using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Slopterm.Server;
using Slopterm.Server.Native;
using Slopterm.Server.Vault;

// Installed before anything else below gets a chance to throw - see CrashLogger's doc
// comment for why this matters specifically for the published (no-console) Windows build.
CrashLogger.Install();

// Static asset paths that don't need the auth cookie/token - none of them are sensitive
// (no secrets, just "an app called slopterm exists"), and installing as a PWA relies on
// the browser fetching the manifest/service worker/icons in ways that aren't guaranteed
// to carry credentials the same way an authenticated page's own fetches do.
var publicPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "/manifest.webmanifest", "/sw.js", "/favicon.svg",
    "/icon-192.png", "/icon-192-maskable.png", "/icon-512.png", "/icon-512-maskable.png",
};

// A fixed, stable port so an installed PWA shortcut (origin-scoped, port included) keeps
// working across app restarts - falls back to an OS-assigned port if it's ever occupied.
// This isn't a security regression: the actual auth boundary is the per-launch token
// below, not port secrecy.
const int PreferredPort = 51823;
var port = PreferredPort;
try
{
    var probe = new TcpListener(IPAddress.Loopback, PreferredPort);
    probe.Start();
    probe.Stop();
}
catch (SocketException)
{
    port = 0;
}

var builder = WebApplication.CreateBuilder(args);

// Loopback-only: never reachable from other machines by default.
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, port));

var app = builder.Build();

// Persisted rather than freshly random every launch (see LaunchTokenStore's doc comment)
// so a browser tab that's still open across a self-update-triggered restart keeps working
// with the same cookie instead of getting a 401 from the new process.
var launchToken = LaunchTokenStore.LoadOrCreate(() => Convert.ToHexString(RandomNumberGenerator.GetBytes(24)));
var sessions = new SessionStore<TerminalSession>();
var sftpSessions = new SessionStore<SftpSession>();
var vault = new VaultService();
// If settings (persisted from a previous run) say a master password isn't required, this
// transparently unlocks the vault right now - the frontend never sees an unlock prompt.
vault.EnsureUnlockedIfPasswordNotRequired();
var forwarding = new ForwardingService(vault);

// Best-effort cleanup of a previous update's backup - see UpdateService.ApplyAsync. Not
// fatal if this fails (e.g. the old process briefly still holds it on Windows); it'll just
// be retried on the next startup.
try
{
    var previousExeBackup = Environment.ProcessPath + ".old";
    if (File.Exists(previousExeBackup))
    {
        File.Delete(previousExeBackup);
    }
}
catch (IOException) { }

var updateService = new UpdateService();
UpdateProgress updateProgress = new("idle", 0);
var updateProgressLock = new object();

// The SSH-tab upload endpoint carries its ConnectRequest as a multipart form field rather
// than a JSON body, so it has to deserialize that field by hand - match the camelCase
// convention the minimal-API pipeline uses for every other endpoint's JSON body.
var jsonWebOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);

// Everything below is loopback/token/origin gated - this app has no other auth layer.
app.Use(async (context, next) =>
{
    var requestHost = context.Request.Host.Host;
    if (requestHost != "127.0.0.1" && requestHost != "localhost")
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var origin = context.Request.Headers.Origin.ToString();
    if (!string.IsNullOrEmpty(origin))
    {
        var requestPort = context.Request.Host.Port;
        var allowedOrigins = new[] { $"http://127.0.0.1:{requestPort}", $"http://localhost:{requestPort}" };
        if (!allowedOrigins.Contains(origin))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
    }

    if (publicPaths.Contains(context.Request.Path.Value ?? string.Empty))
    {
        await next();
        return;
    }

    if (context.Request.Cookies["slopterm_token"] == launchToken)
    {
        await next();
        return;
    }

    if (context.Request.Query["token"] == launchToken)
    {
        context.Response.Cookies.Append("slopterm_token", launchToken, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Strict,
            Secure = false,
            IsEssential = true,
        });

        // Keep the token out of the address bar/history once the cookie is set.
        if (HttpMethods.IsGet(context.Request.Method) &&
            context.Request.Headers.Accept.ToString().Contains("text/html"))
        {
            context.Response.Redirect(context.Request.Path);
            return;
        }

        await next();
        return;
    }

    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
});

// The React build is embedded in this assembly (see the .csproj), not read from a
// wwwroot folder on disk, so the published single-file exe is genuinely self-contained.
var webAssets = new ManifestEmbeddedFileProvider(Assembly.GetExecutingAssembly(), "wwwroot");
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = webAssets });
app.UseStaticFiles(new StaticFileOptions { FileProvider = webAssets });
app.UseWebSockets();

app.MapPost("/api/ssh/connect", (ConnectRequest request) =>
{
    try
    {
        var session = TerminalSession.Connect(request);
        sessions.Add(session.Id, session);
        vault.AppendLog(new LogEntryRecord
        {
            Event = "connected",
            Host = request.Host,
            Port = request.Port,
            Username = request.Username,
        });
        // Bring up this host's port forwards automatically now that we're connected to it.
        if (!string.IsNullOrEmpty(request.HostId))
        {
            forwarding.StartRulesForHost(request.HostId);
        }

        return Results.Ok(new { sessionId = session.Id });
    }
    catch (Exception ex)
    {
        vault.AppendLog(new LogEntryRecord
        {
            Event = "connect_failed",
            Host = request.Host,
            Port = request.Port,
            Username = request.Username,
            Detail = ex.Message,
        });
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/sftp/connect", (ConnectRequest request) =>
{
    try
    {
        var session = SftpSession.Connect(request);
        sftpSessions.Add(session.Id, session);
        if (!string.IsNullOrEmpty(request.HostId))
        {
            forwarding.StartRulesForHost(request.HostId);
        }

        return Results.Ok(new { sessionId = session.Id, homeDirectory = session.HomeDirectory });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/sftp/{sessionId}/list", (string sessionId, string? path) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        return Results.Ok(session.ListDirectory(path));
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapDelete("/api/sftp/session/{sessionId}", (string sessionId) =>
{
    sftpSessions.Remove(sessionId);
    return Results.NoContent();
});

app.MapPost("/api/sftp/{sessionId}/upload", async (string sessionId, SftpUploadRequest request, CancellationToken ct) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        await session.UploadFileAsync(request.LocalPath, request.RemoteDir, ct);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

// Writes raw uploaded bytes to a remote directory over a fresh, one-shot SFTP connection.
// Unlike /api/sftp/{sessionId}/upload, this has no existing sftp session to key off - an
// SSH tab (see TerminalView) only holds an interactive shell, not an SFTP channel - so it
// carries its own ConnectRequest and opens/closes a short-lived SftpSession just for this
// write. Backs the SSH tab's paste-to-upload and drag-from-OS flows. multipart/form-data
// (not JSON) so the file bytes travel as-is rather than base64-inflated.
app.MapPost("/api/ssh/upload", async (HttpRequest request, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
    {
        return Results.BadRequest(new { error = "Expected multipart/form-data." });
    }

    var form = await request.ReadFormAsync(ct);
    var connectJson = form["connect"].ToString();
    var remoteDir = form["remoteDir"].ToString();
    var file = form.Files["file"];
    if (string.IsNullOrEmpty(connectJson) || string.IsNullOrEmpty(remoteDir) || file is null)
    {
        return Results.BadRequest(new { error = "connect, remoteDir and file are all required." });
    }

    ConnectRequest? connect;
    try
    {
        connect = JsonSerializer.Deserialize<ConnectRequest>(connectJson, jsonWebOptions);
    }
    catch (JsonException)
    {
        connect = null;
    }

    if (connect is null)
    {
        return Results.BadRequest(new { error = "Invalid connect payload." });
    }

    try
    {
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);

        using var session = SftpSession.Connect(connect);
        var remotePath = await session.WriteBytesAsync(remoteDir, file.FileName, ms.ToArray(), ct);
        return Results.Ok(new { remotePath });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/sftp/{sessionId}/download", async (string sessionId, SftpDownloadRequest request, CancellationToken ct) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        await session.DownloadFileAsync(request.RemotePath, request.LocalDir, ct);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

// Upload from raw bytes rather than a server-side path: an OS file dragged from the file
// manager (Explorer/Finder/Nautilus) onto a pane only exists in the browser as bytes, with
// no path on this machine's disk that the path-based /upload endpoint above could open. The
// file name and target remote directory ride along as query params; the body is the raw
// file bytes, same as /api/vault/import.
app.MapPost("/api/sftp/{sessionId}/upload-bytes", async (string sessionId, string name, string remoteDir, HttpRequest request, CancellationToken ct) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        await session.UploadBytesAsync(request.Body, name, remoteDir, ct);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/sftp/{sessionId}/rename", (string sessionId, SftpRenameRequest request) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        session.Rename(request.Path, request.NewName);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/sftp/{sessionId}/delete", (string sessionId, SftpDeleteRequest request) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        session.Delete(request.Path);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/sftp/{sessionId}/mkdir", (string sessionId, SftpMakeDirectoryRequest request) =>
{
    var session = sftpSessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        session.MakeDirectory(request.ParentDir, request.Name);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/local/list", (string? path) =>
{
    try
    {
        return Results.Ok(LocalFileSystem.ListDirectory(path));
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or ArgumentException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/local/rename", (LocalRenameRequest request) =>
{
    try
    {
        LocalFileSystem.Rename(request.Path, request.NewName);
        return Results.NoContent();
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or ArgumentException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/local/delete", (LocalDeleteRequest request) =>
{
    try
    {
        LocalFileSystem.Delete(request.Path);
        return Results.NoContent();
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or ArgumentException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/local/mkdir", (LocalMakeDirectoryRequest request) =>
{
    try
    {
        LocalFileSystem.MakeDirectory(request.ParentDir, request.Name);
        return Results.NoContent();
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or ArgumentException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/vault/status", () => Results.Ok(new { exists = vault.Exists, unlocked = vault.IsUnlocked }));

app.MapPost("/api/vault/setup", (VaultPasswordRequest request) =>
{
    try
    {
        vault.Setup(request.MasterPassword);
        return Results.Ok();
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/vault/unlock", (VaultPasswordRequest request) =>
{
    try
    {
        return vault.Unlock(request.MasterPassword)
            ? Results.Ok()
            : Results.Json(new { error = "Incorrect master password." }, statusCode: StatusCodes.Status401Unauthorized);
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/vault/lock", () =>
{
    vault.Lock();
    return Results.NoContent();
});

app.MapPost("/api/window-position", (WindowPosition position) =>
{
    WindowPositionStore.Save(position);
    return Results.NoContent();
});

app.MapGet("/api/settings", () => Results.Ok(vault.GetSettings()));

app.MapPost("/api/settings/require-master-password", (SetRequireMasterPasswordRequest request) =>
{
    try
    {
        vault.SetRequireMasterPassword(request.Required, request.CurrentPassword, request.NewPassword);
        return Results.Ok(vault.GetSettings());
    }
    catch (UnauthorizedAccessException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
    catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/settings/close-to-tray", (SetCloseToTrayRequest request) =>
{
    vault.SetCloseToTray(request.Enabled);
    return Results.Ok(vault.GetSettings());
});

app.MapGet("/api/settings/github-token", () => Results.Ok(new { hasToken = !string.IsNullOrEmpty(vault.GetGithubToken()) }));

app.MapPost("/api/settings/github-token", (SetGithubTokenRequest request) =>
{
    try
    {
        vault.SetGithubToken(request.Token);
        return Results.Ok(new { hasToken = !string.IsNullOrEmpty(vault.GetGithubToken()) });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/update/check", async () =>
{
    var result = await updateService.CheckAsync(vault.GetGithubToken());
    return Results.Ok(result);
});

app.MapGet("/api/update/progress", () =>
{
    lock (updateProgressLock)
    {
        return Results.Ok(updateProgress);
    }
});

app.MapPost("/api/update/apply", (UpdateApplyRequest request) =>
{
    lock (updateProgressLock)
    {
        if (updateProgress.Phase is "downloading" or "verifying" or "installing")
        {
            return Results.Conflict(new { error = "An update is already in progress." });
        }

        updateProgress = new UpdateProgress("downloading", 0);
    }

    var githubToken = vault.GetGithubToken();

    // Captured before ApplyAsync runs, not re-read afterwards: ApplyAsync renames this
    // process's own running executable out from under it (old -> ".old", new binary into
    // the vacated path), and on Linux Environment.ProcessPath is backed by /proc/self/exe,
    // which follows that rename for the rest of this process's life - verified directly
    // (renamed a running process's own exe file, then placed a new file at the original
    // path; /proc/<pid>/exe kept reporting the renamed-away ".old" path, never the new
    // file). Re-reading Environment.ProcessPath after the swap would relaunch the old,
    // backed-up binary instead of the freshly installed one.
    var exePathForRestart = Environment.ProcessPath!;

    _ = Task.Run(async () =>
    {
        try
        {
            var reporter = new Progress<UpdateProgress>(p =>
            {
                lock (updateProgressLock)
                {
                    updateProgress = p;
                }
            });

            await updateService.ApplyAsync(request.AssetId, request.ExpectedSha256, githubToken, reporter, CancellationToken.None);

            lock (updateProgressLock)
            {
                updateProgress = new UpdateProgress("restarting", 100);
            }

            // Gives a client polling /api/update/progress a real chance to observe the
            // "restarting" phase at least once before the connection drops - verified
            // against the real repo/API that without this, the install+shutdown sequence
            // is fast enough that a poller can go straight from "verifying" to the
            // connection being refused, never seeing "installing"/"restarting" at all.
            await Task.Delay(500);

            // Stops Kestrel (releasing the fixed port) before spawning the replacement
            // process, so the new instance never races the old one for the same port.
            await app.StopAsync();

            Process.Start(new ProcessStartInfo(exePathForRestart) { UseShellExecute = false });

            // Deliberately NOT relying on this background task's completion unblocking
            // Program.cs's own `await app.WaitForShutdownAsync()` and falling through
            // naturally from there - verified directly (published single-file exe, real
            // repo/API) that the two race: `app.StopAsync()` unblocks that awaited call on
            // its own continuation, Main() can then fall off the end and the whole process
            // (including this background task's thread pool) can be torn down *before*
            // Process.Start above ever got to run, silently dropping the respawn entirely -
            // the new process just never appeared. Process.Start is synchronous - by the
            // time it returns here the replacement OS process already exists independently
            // of this one - so exiting immediately and explicitly right after it, rather
            // than leaving shutdown ordering to chance, is what actually closes that race.
            Environment.Exit(0);
        }
        catch (Exception ex)
        {
            lock (updateProgressLock)
            {
                updateProgress = new UpdateProgress("error", 0, ex.Message);
            }
        }
    });

    return Results.Accepted();
});

app.MapGet("/api/vault/export", () =>
{
    try
    {
        var bytes = vault.ExportBackup();
        return Results.File(bytes, "application/zip", $"slopterm-vault-backup-{DateTimeOffset.UtcNow:yyyy-MM-dd}.zip");
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/vault/import", async (HttpRequest request) =>
{
    try
    {
        using var ms = new MemoryStream();
        await request.Body.CopyToAsync(ms);
        vault.ImportBackup(ms.ToArray());
        return Results.NoContent();
    }
    catch (Exception ex) when (ex is InvalidOperationException or InvalidDataException or IOException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/vault/reset", () =>
{
    vault.ResetToDefault();
    return Results.NoContent();
});

app.MapGet("/api/vault/hosts", () =>
{
    try
    {
        var hosts = vault.ListHosts().Select(h => new { id = h.Id, updatedAt = h.UpdatedAt, host = h.Record });
        return Results.Ok(hosts);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/hosts", (HostRecord request) =>
{
    try
    {
        var id = vault.SaveHost(null, request);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/hosts/{id}", (string id, HostRecord request) =>
{
    try
    {
        vault.SaveHost(id, request);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/hosts/{id}", (string id) =>
{
    try
    {
        return vault.DeleteHost(id) ? Results.NoContent() : Results.NotFound();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Encodes a saved host (address/port/credentials) into a portable, encrypted token the
// "Copy" right-click action puts on the clipboard - see HostShareCodec for the format and
// its (deliberately non-secret) encryption.
app.MapGet("/api/vault/hosts/{id}/share", (string id) =>
{
    try
    {
        var match = vault.ListHosts().FirstOrDefault(h => h.Id == id);
        if (match.Record is null)
        {
            return Results.NotFound();
        }

        return Results.Ok(new { token = HostShareCodec.Encode(match.Record) });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// The other side of "Copy": decode a share token from another instance and save it as a
// new host here. A bad/foreign token is a plain 400, not a 500 - it's user-pasted input.
app.MapPost("/api/vault/hosts/import-share", (ImportHostShareRequest request) =>
{
    HostRecord host;
    try
    {
        host = HostShareCodec.Decode(request.Token ?? string.Empty);
    }
    catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException)
    {
        return Results.BadRequest(new { error = "That isn't a valid slopterm host share token." });
    }

    // Groups aren't shared/synced, so a source-instance group id would just dangle here.
    host.ParentGroupId = null;

    try
    {
        var id = vault.SaveHost(null, host);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/vault/snippets", () =>
{
    try
    {
        var snippets = vault.ListSnippets().Select(s => new { id = s.Id, updatedAt = s.UpdatedAt, snippet = s.Record });
        return Results.Ok(snippets);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/snippets", (SnippetRecord request) =>
{
    try
    {
        var id = vault.SaveSnippet(null, request);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/snippets/{id}", (string id, SnippetRecord request) =>
{
    try
    {
        vault.SaveSnippet(id, request);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/snippets/{id}", (string id) =>
{
    try
    {
        return vault.DeleteSnippet(id) ? Results.NoContent() : Results.NotFound();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/vault/keychain", () =>
{
    try
    {
        var entries = vault.ListKeychainEntries().Select(e => new { id = e.Id, updatedAt = e.UpdatedAt, entry = e.Record });
        return Results.Ok(entries);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/keychain", (KeychainEntryRecord request) =>
{
    try
    {
        var id = vault.SaveKeychainEntry(null, request);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/keychain/{id}", (string id, KeychainEntryRecord request) =>
{
    try
    {
        vault.SaveKeychainEntry(id, request);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/keychain/{id}", (string id) =>
{
    try
    {
        return vault.DeleteKeychainEntry(id) ? Results.NoContent() : Results.NotFound();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// --- Port forwarding: the rule records (persisted config) plus live control/status. ---

app.MapGet("/api/vault/port-forwards", () =>
{
    try
    {
        var rules = vault.ListPortForwards().Select(r => new { id = r.Id, updatedAt = r.UpdatedAt, forward = r.Record });
        return Results.Ok(rules);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/port-forwards", (PortForwardRecord request) =>
{
    try
    {
        var id = vault.SavePortForward(null, request);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/port-forwards/{id}", (string id, PortForwardRecord request) =>
{
    try
    {
        // Edits take effect on the next start, so stop any live instance of this rule first.
        forwarding.StopRule(id);
        vault.SavePortForward(id, request);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/port-forwards/{id}", (string id) =>
{
    try
    {
        forwarding.StopRule(id);
        return vault.DeletePortForward(id) ? Results.NoContent() : Results.NotFound();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/forwarding/status", () => Results.Ok(forwarding.GetStatus()));

app.MapPost("/api/forwarding/rules/{id}/start", (string id) =>
{
    try
    {
        forwarding.StartRule(id);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/forwarding/rules/{id}/stop", (string id) =>
{
    forwarding.StopRule(id);
    return Results.NoContent();
});

app.MapGet("/api/vault/logs", () =>
{
    try
    {
        var logs = vault.ListLogs().Select(l => new { id = l.Id, timestamp = l.UpdatedAt, entry = l.Record });
        return Results.Ok(logs);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/logs", () =>
{
    try
    {
        vault.ClearLogs();
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/vault/recent-connections", () =>
{
    try
    {
        var recents = vault.ListRecentConnections().Select(r => new { id = r.Id, updatedAt = r.UpdatedAt, connection = r.Record });
        return Results.Ok(recents);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Best-effort like /api/vault/logs writes - never blocks on the vault being locked, since
// only ad hoc (Quick Connect/Recent) connects call this, not saved-Host ones.
app.MapPost("/api/vault/recent-connections", (RecentConnectionRecord request) =>
{
    vault.UpsertRecentConnection(request);
    return Results.NoContent();
});

// Both best-effort like /api/vault/logs - GetOpenTabs returns an empty snapshot rather
// than 401 if the vault happens to be locked (a brand-new app window shouldn't error out
// just because it hasn't unlocked yet), and the POST silently no-ops the same way.
app.MapGet("/api/vault/open-tabs", () => Results.Ok(vault.GetOpenTabs()));

app.MapPost("/api/vault/open-tabs", (OpenTabsRecord request) =>
{
    vault.SaveOpenTabs(request);
    return Results.NoContent();
});

app.MapDelete("/api/ssh/session/{sessionId}", (string sessionId) =>
{
    var removed = sessions.Remove(sessionId);
    if (removed is not null)
    {
        vault.AppendLog(new LogEntryRecord { Event = "disconnected", Host = removed.Host, Port = removed.Port, Username = removed.Username });
    }

    return Results.NoContent();
});

app.Map("/ws/terminal/{sessionId}", async (HttpContext context, string sessionId) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var session = sessions.Get(sessionId);
    if (session is null)
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);

    var toSocket = session.PumpToWebSocketAsync(socket, cts.Token);
    var fromSocket = session.PumpFromWebSocketAsync(socket, cts.Token);
    await Task.WhenAny(toSocket, fromSocket);
    cts.Cancel();

    if (socket.State == WebSocketState.Open)
    {
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "session ended", CancellationToken.None);
    }

    var removed = sessions.Remove(sessionId);
    if (removed is not null)
    {
        vault.AppendLog(new LogEntryRecord { Event = "disconnected", Host = removed.Host, Port = removed.Port, Username = removed.Username });
    }
});

app.Start();

// Bring up background port forwards marked auto-start. Best-effort: no-op if the vault is
// still locked (a master-password vault starts its forwards on first connect/unlock instead).
forwarding.StartAutoForwards();

var addressesFeature = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>();
var boundPort = new Uri(addressesFeature?.Addresses.First() ?? "http://127.0.0.1:0").Port;
var launchUrl = $"http://127.0.0.1:{boundPort}/?token={launchToken}";

void OpenWindow() => AppWindowManager.EnsureWindowOpen(launchUrl);

void Quit()
{
    // Closes anything opened on the user's behalf that stopping this process alone
    // wouldn't - a fallback browser window (no webview runtime installed) is a separate
    // OS process Program.cs's own shutdown never touches. The main Photino window needs
    // no equivalent call here: it lives on a background thread that already dies once
    // StopApplication unblocks WaitForShutdownAsync below and the process exits.
    AppWindowManager.CloseAllFallbackBrowserWindows();
    app.Lifetime.StopApplication();
}

// Closing the app window quits by default; a user can opt into the old minimize-to-tray
// behavior via Settings (CloseToTray). The flag is read live at each close, so toggling it
// takes effect without a restart, and closing runs the same clean Quit the tray menu does.
AppWindowManager.Configure(() => vault.GetSettings().CloseToTray, Quit);

WindowsTrayIcon? trayIcon = null;
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    // No console window on the published build (see the .csproj) - the tray icon is the
    // only way to reach the app. Left-click/"Open" focuses the one slopterm window if
    // it's already open, or creates it fresh otherwise (see AppWindowManager);
    // "Quit" stops it.
    trayIcon = new WindowsTrayIcon("slopterm", OpenWindow, Quit);
    trayIcon.Start();

    // Create the native window immediately so Windows gives the running application a
    // taskbar button as well as its tray icon. The window already uses the embedded app
    // icon (AppWindowManager.SetIconFile). Closing it quits the app by default; only when
    // the user opts into CloseToTray does the close handler minimize-and-keep-running
    // instead, leaving the taskbar/tray entry available for the rest of the process life.
    OpenWindow();
}
else
{
    // No tray icon on Linux/macOS yet (see AGENTS.md's system tray section) - printing
    // the URL to the console is still the only way to reach the app there.
    Console.WriteLine();
    Console.WriteLine("slopterm is running. Open this URL in your browser:");
    Console.WriteLine($"  {launchUrl}");
    Console.WriteLine();
}

await app.WaitForShutdownAsync();
forwarding.Dispose(); // tears down every background forwarding connection cleanly
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    trayIcon?.Dispose();
}
