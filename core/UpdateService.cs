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
/// .github/workflows/release.yml), and can download+swap+relaunch in place. gwdevhub/terminal
/// is a *private* repo, so both the metadata lookup and the asset download need a GitHub
/// token for anything to work at all - see VaultService.GetGithubToken/SetGithubToken and
/// Settings' "Updates" section. Verified end-to-end against the real repo/API before this
/// shipped: unauthenticated calls 404 (private repo), an authenticated call to
/// /releases/tags/latest returns each asset's `digest` (sha256:<hex>, computed by GitHub
/// itself on upload - no need to download just to hash), and downloading a private asset
/// works via GET /releases/assets/{id} with `Accept: application/octet-stream` (NOT the
/// asset's own `browser_download_url`, which relies on a browser's cookie session rather
/// than a bearer token and won't work programmatically for a private repo).
/// </summary>
public sealed class UpdateService
{
    private const string Repo = "gwdevhub/terminal";
    private static readonly HttpClient Http = new();

    private string? _cachedCurrentSha256;

    static UpdateService()
    {
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("slopterm-self-update");
    }

    public async Task<UpdateCheckResult> CheckAsync(string? githubToken, CancellationToken ct = default)
    {
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
                ? "No release found, or this is a private repo and no GitHub token is set in Settings."
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

        // Only a genuine published single-file build is updatable - there's no single exe
        // that *is* the app to hash/swap otherwise. Two independent guards, because neither
        // alone is sufficient:
        //
        //  - Empty Assembly.Location is the reliable single-file signal. When the app is
        //    bundled into one self-contained exe, the runtime loads assemblies straight from
        //    the bundle rather than from disk, so GetEntryAssembly().Location is an empty
        //    string. Under `dotnet run`, `dotnet build`, or any normal framework-dependent
        //    run it's the real on-disk DLL path instead. This is the documented way to detect
        //    a single-file publish at runtime. In a real single-file build ProcessPath is the
        //    single-file exe itself, so we still return it (the real update path is preserved).
        //
        //  - The filename == "dotnet" guard alone is NOT enough. `dotnet run` does not leave
        //    us running under the shared `dotnet` host: it builds and launches the project's
        //    own apphost executable (Slopterm.Server.exe in bin/Debug/net10.0/), so
        //    ProcessPath is that apphost and its filename is "Slopterm.Server", never
        //    "dotnet". Relying on the filename check alone would wrongly treat a dev build as
        //    publishable, hash the apphost, find its SHA differs from the release asset, and
        //    report a bogus "update available" (plus the update dot). We keep the "dotnet"
        //    check as cheap belt-and-suspenders (covers `dotnet exec` on non-Windows).
        var isSingleFile = string.IsNullOrEmpty(System.Reflection.Assembly.GetEntryAssembly()?.Location);
        if (!isSingleFile)
        {
            return null;
        }

        var fileName = Path.GetFileNameWithoutExtension(path);
        return string.Equals(fileName, "dotnet", StringComparison.OrdinalIgnoreCase) ? null : path;
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
