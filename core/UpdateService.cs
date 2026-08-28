using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace Slopterm.Server;

public sealed record UpdateCheckResult(
    bool Supported,
    bool UpdateAvailable,
    string? CurrentSha256,
    string? LatestSha256,
    string? LatestTagName,
    long? AssetId,
    string? Error);

public sealed record UpdateProgress(string Phase, double Percent, string? Error = null);

/// <summary>
/// Self-update: compares the SHA256 of the currently-running single-file executable
/// against the matching asset in this repo's rolling "latest" GitHub Release (see
/// .github/workflows/release.yml), and can download+swap+relaunch in place.
///
/// gwdevhub/slopterm is public, so both the metadata lookup and the asset download work
/// unauthenticated. A GitHub token stays supported but is purely optional - it only raises
/// GitHub's unauthenticated rate limit (see VaultService.GetGithubToken/SetGithubToken and
/// Settings' "Updates" section).
///
/// Two API details worth keeping, verified end-to-end against the real repo/API: a call to
/// /releases/tags/latest returns each asset's `digest` (sha256:&lt;hex&gt;, computed by GitHub
/// itself on upload - no need to download an asset just to hash it), and the download uses
/// GET /releases/assets/{id} with `Accept: application/octet-stream` rather than the asset's
/// own `browser_download_url`, which is a redirect aimed at a browser session.
///
/// Desktop only. CheckAsync bails out before touching the network on Android, where updates
/// come from Google Play instead - there's no single-file exe to hash or swap, no release
/// asset for the platform, and a self-update would fight Play's own installer. This is what
/// PRIVACY.md's "no update check on mobile" claim rests on, so keep the guard first.
/// </summary>
public sealed class UpdateService
{
    private const string Repo = "gwdevhub/slopterm";
    private static readonly byte[] BundleHeaderSignature =
    [
        0x8b, 0x12, 0x02, 0xb9, 0x6a, 0x61, 0x20, 0x38,
        0x72, 0x7b, 0x93, 0x02, 0x14, 0xd7, 0xa0, 0x32,
        0x13, 0xf5, 0xb9, 0xe6, 0xef, 0xae, 0x33, 0x18,
        0xee, 0x3b, 0x2d, 0xce, 0x24, 0xb3, 0x6a, 0xae
    ];
    private static readonly HttpClient Http = new();

    private string? _cachedCurrentSha256;

    static UpdateService()
    {
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("slopterm-self-update");
    }

    public async Task<UpdateCheckResult> CheckAsync(string? githubToken, CancellationToken ct = default)
    {
        // First, and before any network call: the Android head runs this same SloptermHost
        // (see MainActivity) and the shared web UI checks for updates on mount, so without
        // this the phone would reach out to api.github.com only to fail later at
        // AssetNameForCurrentPlatform. Supported:false is the same shape a dev build returns -
        // the UI already renders it as "no update dot", not as an error.
        if (OperatingSystem.IsAndroid())
        {
            return new UpdateCheckResult(false, false, null, null, null, null,
                "Updates on Android are delivered through Google Play, not from here.");
        }

        var currentSha = ComputeCurrentExeSha256();
        if (currentSha is null)
        {
            return new UpdateCheckResult(false, false, null, null, null, null,
                "Not running as a published single-file build (e.g. `dotnet run` in development) - update checks aren't available.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repo}/releases/tags/latest");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        if (!string.IsNullOrEmpty(githubToken))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", githubToken);
        }

        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(request, ct);
        }
        catch (HttpRequestException ex)
        {
            return new UpdateCheckResult(true, false, currentSha, null, null, null, $"Couldn't reach GitHub: {ex.Message}");
        }

        if (!response.IsSuccessStatusCode)
        {
            var reason = response.StatusCode == System.Net.HttpStatusCode.NotFound
                ? $"No 'latest' release found in {Repo}."
                : $"GitHub API returned {(int)response.StatusCode}.";
            return new UpdateCheckResult(true, false, currentSha, null, null, null, reason);
        }

        var release = await response.Content.ReadFromJsonAsync<GithubRelease>(ct);
        var assetName = AssetNameForCurrentPlatform();
        var asset = release?.Assets?.FirstOrDefault(a => string.Equals(a.Name, assetName, StringComparison.OrdinalIgnoreCase));
        if (asset?.Digest is null)
        {
            return new UpdateCheckResult(true, false, currentSha, null, release?.TagName, null,
                $"No matching release asset ({assetName}) found.");
        }

        var latestSha = asset.Digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase)
            ? asset.Digest["sha256:".Length..]
            : asset.Digest;

        var updateAvailable = !string.Equals(currentSha, latestSha, StringComparison.OrdinalIgnoreCase);
        return new UpdateCheckResult(true, updateAvailable, currentSha, latestSha, release?.TagName, asset.Id, null);
    }

    /// <summary>
    /// Downloads the given release asset, verifies its SHA256 against what CheckAsync
    /// already reported (never apply an unverified binary), then replaces the running
    /// executable in place. Does NOT restart the process itself - the caller (Program.cs)
    /// does that once this returns, since only it knows how to cleanly stop Kestrel first.
    /// </summary>
    public async Task ApplyAsync(long assetId, string expectedSha256Hex, string? githubToken, IProgress<UpdateProgress> progress, CancellationToken ct)
    {
        var exePath = CurrentExePath() ?? throw new InvalidOperationException("Not running as a published single-file build.");
        var tempPath = exePath + ".update";

        progress.Report(new UpdateProgress("downloading", 0));

        using (var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repo}/releases/assets/{assetId}"))
        {
            request.Headers.Accept.ParseAdd("application/octet-stream");
            if (!string.IsNullOrEmpty(githubToken))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", githubToken);
            }

            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            var total = response.Content.Headers.ContentLength;
            await using var httpStream = await response.Content.ReadAsStreamAsync(ct);
            await using var fileStream = File.Create(tempPath);

            var buffer = new byte[81920];
            long readTotal = 0;
            int read;
            while ((read = await httpStream.ReadAsync(buffer, ct)) > 0)
            {
                await fileStream.WriteAsync(buffer.AsMemory(0, read), ct);
                readTotal += read;
                if (total is > 0)
                {
                    progress.Report(new UpdateProgress("downloading", (double)readTotal / total.Value * 100));
                }
            }
        }

        progress.Report(new UpdateProgress("verifying", 100));
        string actualSha;
        await using (var verifyStream = File.OpenRead(tempPath))
        {
            actualSha = Convert.ToHexString(await SHA256.HashDataAsync(verifyStream, ct)).ToLowerInvariant();
        }

        if (!string.Equals(actualSha, expectedSha256Hex, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(tempPath);
            throw new InvalidOperationException("Downloaded update failed integrity verification - not applied.");
        }

        if (!OperatingSystem.IsWindows())
        {
            // GitHub release assets are plain uploaded files - they don't carry the
            // execute bit an actual published binary needs on Linux/macOS.
            File.SetUnixFileMode(tempPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }

        progress.Report(new UpdateProgress("installing", 100));

        // Renaming the running exe out of the way (rather than overwriting it directly)
        // works even while it's the current process's own executing image - the OS only
        // needs the open file handle, not the directory entry/name, to keep running it.
        // Kept as ".old" rather than deleted immediately: if the new exe somehow fails to
        // start, there's still a way to recover by hand. The *next* successful startup
        // deletes it (see Program.cs).
        var backupPath = exePath + ".old";
        if (File.Exists(backupPath))
        {
            File.Delete(backupPath);
        }

        File.Move(exePath, backupPath);
        File.Move(tempPath, exePath);
    }

    private static string AssetNameForCurrentPlatform()
    {
        if (OperatingSystem.IsWindows())
        {
            return "slopterm-win-x64.exe";
        }

        if (OperatingSystem.IsMacOS())
        {
            return RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "slopterm-osx-arm64" : "slopterm-osx-x64";
        }

        if (OperatingSystem.IsLinux())
        {
            return "slopterm-linux-x64";
        }

        throw new PlatformNotSupportedException();
    }

    private static string? CurrentExePath()
    {
        var path = Environment.ProcessPath;
        if (string.IsNullOrEmpty(path))
        {
            return null;
        }

        var fileName = Path.GetFileNameWithoutExtension(path);
        if (string.Equals(fileName, "dotnet", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        // IncludeAllContentForSelfExtract extracts managed assemblies before startup, so
        // Assembly.Location is non-empty even for our genuine single-file releases. Inspect
        // the apphost's bundle marker instead; an ordinary apphost has the same marker with a
        // zero header offset, while dotnet publish fills in the real bundle header offset.
        return IsSingleFileBundle(path) ? path : null;
    }

    internal static bool IsSingleFileBundle(string path)
    {
        const int bufferSize = 64 * 1024;
        var overlap = BundleHeaderSignature.Length + sizeof(long) - 1;
        var buffer = new byte[bufferSize + overlap];
        var preserved = 0;

        using var stream = File.OpenRead(path);
        while (true)
        {
            var read = stream.Read(buffer, preserved, bufferSize);
            if (read == 0)
            {
                return false;
            }

            var bytes = buffer.AsSpan(0, preserved + read);
            var searchOffset = 0;
            while (searchOffset < bytes.Length)
            {
                var relativeIndex = bytes[searchOffset..].IndexOf(BundleHeaderSignature);
                if (relativeIndex < 0)
                {
                    break;
                }

                var signatureIndex = searchOffset + relativeIndex;
                if (signatureIndex >= sizeof(long))
                {
                    return BinaryPrimitives.ReadInt64LittleEndian(bytes[(signatureIndex - sizeof(long))..]) != 0;
                }

                searchOffset = signatureIndex + 1;
            }

            preserved = Math.Min(overlap, bytes.Length);
            bytes[^preserved..].CopyTo(buffer);
        }
    }

    private string? ComputeCurrentExeSha256()
    {
        if (_cachedCurrentSha256 is not null)
        {
            return _cachedCurrentSha256;
        }

        var path = CurrentExePath();
        if (path is null)
        {
            return null;
        }

        using var stream = File.OpenRead(path);
        using var sha = SHA256.Create();
        _cachedCurrentSha256 = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
        return _cachedCurrentSha256;
    }

    private sealed class GithubRelease
    {
        [JsonPropertyName("tag_name")]
        public string? TagName { get; set; }

        [JsonPropertyName("assets")]
        public List<GithubAsset>? Assets { get; set; }
    }

    private sealed class GithubAsset
    {
        [JsonPropertyName("id")]
        public long Id { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("digest")]
        public string? Digest { get; set; }
    }
}
