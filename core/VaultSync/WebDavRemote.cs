using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Xml.Linq;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// <see cref="IVaultSyncRemote"/> over plain WebDAV, hand-rolled on HttpClient - PUT/GET/
/// DELETE/PROPFIND/MKCOL, basic auth, and just enough XML to pull href + getetag out of a
/// multistatus. No package: the WebDAV clients on NuGet all bring a dependency tree for
/// features (locking, quotas, versioning) this uses none of.
///
/// Every server disagreement lives in this file on purpose, so the merge logic never has
/// to care (see todo/webdav-sync.md's pitfalls):
///   - trailing slashes: directories are always requested WITH one, files always without;
///   - percent-encoding: relative segments are escaped on the way out and hrefs unescaped
///     on the way back, so a name only ever round-trips through one encoding;
///   - PROPFIND returning the requested collection as its own first entry - dropped by
///     comparing against the requested path rather than assuming a position;
///   - MKCOL on an existing collection answering 405 (or 301, when a server redirects a
///     missing trailing slash) instead of 201 - all treated as "it exists now", which is
///     the only thing the caller wanted.
/// </summary>
public sealed class WebDavRemote : IVaultSyncRemote, IDisposable
{
    private static readonly HttpMethod Propfind = new("PROPFIND");
    private static readonly HttpMethod Mkcol = new("MKCOL");
    private static readonly XNamespace Dav = "DAV:";

    // Depth 1, asking only for what the sync loop reads. allprop would work everywhere but
    // makes Nextcloud return a far larger body per entry for no gain.
    private const string PropfindBody =
        """<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><getetag/><resourcetype/></prop></propfind>""";

    private readonly HttpClient _http;
    private readonly Uri _root;

    /// <param name="baseUrl">The user's WebDAV URL. A missing trailing slash is added.</param>
    public WebDavRemote(string baseUrl, string? username, string? password, HttpMessageHandler? handler = null)
    {
        if (!Uri.TryCreate(baseUrl?.Trim(), UriKind.Absolute, out var parsed) ||
            (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps))
        {
            throw new ArgumentException("A collection's remote URL must be a full http:// or https:// WebDAV URL.");
        }

        _root = parsed.AbsoluteUri.EndsWith('/') ? parsed : new Uri(parsed.AbsoluteUri + "/");
        _http = handler is null ? new HttpClient() : new HttpClient(handler);
        _http.Timeout = TimeSpan.FromMinutes(5);

        if (!string.IsNullOrEmpty(username))
        {
            var credentials = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{username}:{password}"));
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", credentials);
        }
    }

    public async Task<IReadOnlyList<RemoteEntry>> ListAsync(string prefix, CancellationToken ct)
    {
        var directory = NormalizeDirectory(prefix);
        using var request = new HttpRequestMessage(Propfind, Resolve(directory))
        {
            Content = new StringContent(PropfindBody, Encoding.UTF8, "text/xml"),
        };
        request.Headers.Add("Depth", "1");

        using var response = await _http.SendAsync(request, ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            return [];
        }

        await ThrowIfFailedAsync(response, "PROPFIND", directory);

        var body = await response.Content.ReadAsStringAsync(ct);
        return ParseMultistatus(body, directory);
    }

    public async Task<byte[]?> GetAsync(string path, CancellationToken ct)
    {
        using var response = await _http.GetAsync(Resolve(NormalizeFile(path)), ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            return null;
        }

        await ThrowIfFailedAsync(response, "GET", path);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    public async Task<RemoteWriteResult> PutAsync(
        string path, byte[] content, string? ifMatch, bool ifNoneMatchStar, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, Resolve(NormalizeFile(path)))
        {
            Content = new ByteArrayContent(content),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

        // TryAddWithoutValidation because a server's ETag isn't always a syntactically valid
        // entity-tag (some omit the quotes), and rejecting the write locally over that would
        // be worse than letting the server decide.
        if (ifNoneMatchStar)
        {
            request.Headers.TryAddWithoutValidation("If-None-Match", "*");
        }
        else if (!string.IsNullOrEmpty(ifMatch))
        {
            request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        }

        using var response = await _http.SendAsync(request, ct);
        if (response.StatusCode is HttpStatusCode.PreconditionFailed)
        {
            return new RemoteWriteResult(false, true, null);
        }

        await ThrowIfFailedAsync(response, "PUT", path);
        return new RemoteWriteResult(true, false, response.Headers.ETag?.Tag);
    }

    public async Task DeleteAsync(string path, CancellationToken ct)
    {
        using var response = await _http.DeleteAsync(Resolve(NormalizeFile(path)), ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
        {
            return; // already the end state the caller asked for
        }

        await ThrowIfFailedAsync(response, "DELETE", path);
    }

    /// <summary>
    /// MKCOLs every ancestor in turn, since MKCOL is not recursive anywhere - a fresh
    /// share needs "slopterm", then "slopterm/v1", then its record folders.
    /// </summary>
    public async Task EnsureDirectoryAsync(string path, CancellationToken ct)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var soFar = new StringBuilder();
        foreach (var segment in segments)
        {
            if (soFar.Length > 0)
            {
                soFar.Append('/');
            }

            soFar.Append(segment);

            using var request = new HttpRequestMessage(Mkcol, Resolve(soFar + "/"));
            using var response = await _http.SendAsync(request, ct);

            // 405 = it's already there. 301 = the server redirected a create it won't
            // perform, which in practice also means "already there". Anything else that
            // isn't success is a real problem worth surfacing.
            if (response.IsSuccessStatusCode ||
                response.StatusCode is HttpStatusCode.MethodNotAllowed or HttpStatusCode.MovedPermanently)
            {
                continue;
            }

            await ThrowIfFailedAsync(response, "MKCOL", soFar.ToString());
        }
    }

    public void Dispose() => _http.Dispose();

    private Uri Resolve(string relativePath)
    {
        var escaped = string.Join('/', relativePath
            .Split('/')
            .Select(segment => segment.Length == 0 ? segment : Uri.EscapeDataString(segment)));
        return new Uri(_root, escaped);
    }

    private static string NormalizeDirectory(string path) =>
        path.Trim('/').Length == 0 ? string.Empty : path.Trim('/') + "/";

    private static string NormalizeFile(string path) => path.Trim('/');

    private IReadOnlyList<RemoteEntry> ParseMultistatus(string xml, string requestedDirectory)
    {
        var document = XDocument.Parse(xml);
        var self = TrimSegments(_root.AbsolutePath + requestedDirectory);
        var entries = new List<RemoteEntry>();

        foreach (var responseElement in document.Descendants(Dav + "response"))
        {
            var href = responseElement.Element(Dav + "href")?.Value;
            if (string.IsNullOrEmpty(href))
            {
                continue;
            }

            // An href may be absolute or path-only, and is always percent-encoded.
            var hrefPath = Uri.TryCreate(href, UriKind.Absolute, out var absolute) ? absolute.AbsolutePath : href;
            var decoded = TrimSegments(Uri.UnescapeDataString(hrefPath));
            if (decoded.Equals(self, StringComparison.Ordinal))
            {
                continue; // the collection describing itself
            }

            var name = decoded.Split('/').LastOrDefault();
            if (string.IsNullOrEmpty(name))
            {
                continue;
            }

            var propstat = responseElement.Elements(Dav + "propstat")
                .FirstOrDefault(p => p.Element(Dav + "status")?.Value.Contains("200", StringComparison.Ordinal) == true)
                ?? responseElement.Elements(Dav + "propstat").FirstOrDefault();
            var prop = propstat?.Element(Dav + "prop");
            var etag = prop?.Element(Dav + "getetag")?.Value;
            var isCollection = prop?.Element(Dav + "resourcetype")?.Element(Dav + "collection") is not null;

            entries.Add(new RemoteEntry(
                requestedDirectory + name,
                string.IsNullOrWhiteSpace(etag) ? null : etag.Trim(),
                isCollection));
        }

        return entries;
    }

    private static string TrimSegments(string path) => path.Trim('/');

    private static async Task ThrowIfFailedAsync(HttpResponseMessage response, string verb, string path)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        // 401/403 are the two the UI has real copy for ("check the credentials", "this
        // collection is read-only for you"), so they keep their status code in the message
        // rather than being flattened into a generic failure.
        var body = await response.Content.ReadAsStringAsync();
        var detail = body.Length > 200 ? body[..200] : body;
        throw new VaultSyncRemoteException(
            (int)response.StatusCode,
            $"{verb} {path} failed with {(int)response.StatusCode} {response.ReasonPhrase}. {detail}".TrimEnd());
    }
}

/// <summary>
/// A remote operation the server refused. StatusCode is what makes 401 (bad credentials)
/// and 403 (read-only share) presentable as their own messages rather than "sync failed".
/// </summary>
public sealed class VaultSyncRemoteException(int statusCode, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}
