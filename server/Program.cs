using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Slopterm.Server;
using Slopterm.Server.Ai;
using Slopterm.Server.Native;
using Slopterm.Server.Vault;

// Installed before anything else below gets a chance to throw - see CrashLogger's doc
// comment for why this matters specifically for the published (no-console) Windows build.
CrashLogger.Install();
CrashLogger.LogPhase("process starting");

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

// Quit must never sit behind live terminal/agent WebSockets - their handlers only return
// when the session ends, and the host's graceful stop waits for in-flight requests, so the
// default timeout reads as "the app won't close while an SSH session is open". Quit tears
// sessions down explicitly (see Quit below) and links ApplicationStopping into the WS
// handlers' tokens; this short timeout is only the backstop that force-aborts stragglers.
builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(2));

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
CrashLogger.LogPhase("vault + settings loaded");
var forwarding = new ForwardingService(vault);
var sync = new SyncService(vault);

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

// The in-terminal AI agent's endpoint/model config - a plain settings.json pair (no secrets,
// no unlock needed; the local-first default is Ollama's port).
app.MapGet("/api/settings/ai", () =>
{
    var settings = vault.GetSettings();
    return Results.Ok(new { baseUrl = settings.AiBaseUrl, model = settings.AiModel });
});

app.MapPost("/api/settings/ai", (SetAiSettingsRequest request) =>
{
    // Empty fields reset to the defaults; a pasted URL gets its trailing slash normalized away
    // so "{base}/chat/completions" concatenation stays clean.
    var defaults = new AppSettings();
    var baseUrl = string.IsNullOrWhiteSpace(request.BaseUrl) ? defaults.AiBaseUrl : request.BaseUrl.Trim().TrimEnd('/');
    var model = string.IsNullOrWhiteSpace(request.Model) ? defaults.AiModel : request.Model.Trim();
    vault.SetAiSettings(baseUrl, model);
    return Results.Ok(new { baseUrl, model });
});

// Live reachability probe: is the local AI server up, is the configured model actually
// pulled, and what models are available to switch to? Drives the status dot, the model
// picker in the agent bar, and the Settings readout.
app.MapGet("/api/ai/status", async () =>
{
    var settings = vault.GetSettings();
    try
    {
        var models = await OpenAiChatClient.ListModelsAsync(settings.AiBaseUrl, CancellationToken.None);
        // Ollama ids carry a tag ("gemma4:12b"); treat a missing tag as ":latest" both ways so
        // "qwen3" matches "qwen3:latest" without the user having to spell it exactly.
        static string Norm(string m) => m.Contains(':') ? m : $"{m}:latest";
        var modelAvailable = models.Any(m => string.Equals(Norm(m), Norm(settings.AiModel), StringComparison.OrdinalIgnoreCase));
        return Results.Ok(new { reachable = true, modelAvailable, baseUrl = settings.AiBaseUrl, model = settings.AiModel, models });
    }
    catch
    {
        return Results.Ok(new { reachable = false, modelAvailable = false, baseUrl = settings.AiBaseUrl, model = settings.AiModel, models = Array.Empty<string>() });
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

app.MapGet("/api/vault/sync-rules", () =>
{
    try
    {
        var rules = vault.ListSyncRules().Select(r => new { id = r.Id, updatedAt = r.UpdatedAt, rule = r.Record });
        return Results.Ok(rules);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/sync-rules", (SyncRuleRecord request) =>
{
    try
    {
        var id = vault.SaveSyncRule(null, request);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/sync-rules/{id}", (string id, SyncRuleRecord request) =>
{
    try
    {
        // Edits take effect on the next start, so stop any live instance of this rule first.
        sync.StopRule(id);
        vault.SaveSyncRule(id, request);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/sync-rules/{id}", (string id) =>
{
    try
    {
        sync.StopRule(id);
        return vault.DeleteSyncRule(id) ? Results.NoContent() : Results.NotFound();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/sync/status", () => Results.Ok(sync.GetStatus()));

app.MapPost("/api/sync/rules/{id}/start", (string id) =>
{
    try
    {
        sync.StartRule(id);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/sync/rules/{id}/stop", (string id) =>
{
    sync.StopRule(id);
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

// The browser terminal fits itself to its container, then posts the resulting size here so
// the remote PTY matches - see TerminalSession.Resize. Separate from the I/O WebSocket on
// purpose: that channel is a raw byte pump straight into the shell, so a control message
// would have to be escaped out of the user's own keystrokes; a plain REST call sidesteps that.
app.MapPost("/api/ssh/{sessionId}/resize", (string sessionId, TerminalResizeRequest request) =>
{
    var session = sessions.Get(sessionId);
    if (session is null)
    {
        return Results.NotFound();
    }

    try
    {
        session.Resize((uint)request.Cols, (uint)request.Rows);
        return Results.NoContent();
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
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
    // ApplicationStopping is linked in so a quit unblocks this handler immediately instead of
    // the graceful stop waiting on it (it would otherwise only return when the session ends).
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, app.Lifetime.ApplicationStopping);

    var toSocket = session.PumpToWebSocketAsync(socket, cts.Token);
    var fromSocket = session.PumpFromWebSocketAsync(socket, cts.Token);
    await Task.WhenAny(toSocket, fromSocket);
    cts.Cancel();

    if (socket.State == WebSocketState.Open)
    {
        try
        {
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "session ended", CancellationToken.None);
        }
        catch (WebSocketException)
        {
            // A client that vanished mid-close (e.g. the app window was closed as part of a
            // quit) can't complete the close handshake - nothing to do, we're tearing down.
        }
    }

    var removed = sessions.Remove(sessionId);
    if (removed is not null)
    {
        vault.AppendLog(new LogEntryRecord { Event = "disconnected", Host = removed.Host, Port = removed.Port, Username = removed.Username });
    }
});

// The in-terminal AI agent's single full-duplex streaming channel. Text frames, one JSON object
// per frame, camelCase via AgentJson.Web. Same loopback/token/origin gating as every other route
// (the global middleware above). Unlike the PTY WS, closing this does NOT remove the SSH session -
// the conversation lives on the still-alive TerminalSession and replays via `history` on reconnect.
app.Map("/ws/agent/{sessionId}", async (HttpContext context, string sessionId) =>
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

    // Deliberately NOT `using` - socket/cts are disposed manually in the finally, AFTER the
    // in-flight turn task has completed, so a still-running turn never emits onto a disposed socket.
    // ApplicationStopping is linked in for the same reason as the terminal WS: a quit must
    // unblock the receive loop immediately rather than the graceful stop waiting on it.
    var socket = await context.WebSockets.AcceptWebSocketAsync();
    var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, app.Lifetime.ApplicationStopping);
    var sendLock = new SemaphoreSlim(1, 1);
    // User messages queue instead of erroring while a turn runs; the pump below is the ONLY
    // place turns are started, draining this in order. Stop/clear empty it.
    var queue = new ConcurrentQueue<(string Mode, string Text)>();
    var signal = new SemaphoreSlim(0);
    // Cancels only the "waiting for the user's Enter" watch - a new user message, stop, or
    // clear must all end it (deliberately never disposed mid-flight: the receive loop may
    // race a Cancel against the pump replacing it, and an undisposed CTS is just GC work).
    CancellationTokenSource? watchCts = null;

    // Tolerates a closing/closed/disposed socket - never throws upward, so a stray late emit from
    // a cancelled turn is a silent no-op.
    async Task Emit(object evt)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        await sendLock.WaitAsync();
        try
        {
            if (socket.State != WebSocketState.Open)
            {
                return;
            }

            var bytes = JsonSerializer.SerializeToUtf8Bytes(evt, AgentJson.Web);
            await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cts.Token);
        }
        catch (WebSocketException) { }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
        finally
        {
            sendLock.Release();
        }
    }

    // True once the terminal shows a newline after the typed suggestion - the suggestion
    // itself is typed WITHOUT one, so the first newline past that offset is the user's Enter
    // (or them running something else; either way the model reads what actually happened).
    // Then waits briefly for the output to settle. False on cancel or a 15-minute timeout.
    async Task<bool> WaitForUserRunAsync(TerminalSession target, long offset, CancellationToken token)
    {
        var deadline = Environment.TickCount64 + 15 * 60_000;
        while (Environment.TickCount64 < deadline)
        {
            await Task.Delay(300, token);
            if (target.Scrollback.SnapshotSince(offset).Contains((byte)'\n'))
            {
                // Let the command's output settle (quiet for 750ms, capped at 10s).
                var last = target.Scrollback.TotalWritten;
                var lastChange = Environment.TickCount64;
                var cap = Environment.TickCount64 + 10_000;
                while (Environment.TickCount64 < cap)
                {
                    await Task.Delay(250, token);
                    var current = target.Scrollback.TotalWritten;
                    if (current != last)
                    {
                        last = current;
                        lastChange = Environment.TickCount64;
                    }
                    else if (Environment.TickCount64 - lastChange >= 750)
                    {
                        break;
                    }
                }

                return true;
            }
        }

        return false;
    }

    // The pump: the single consumer that starts every turn. Each wake drains, in order:
    // queued user messages first (a new message always wins over waiting on a suggestion),
    // then - if the last turn typed a suggestion - watches for the user's Enter and runs an
    // automatic continuation turn. Repeats until there is nothing left to do, then sleeps
    // until the next signal. Serializing everything here is what makes message queueing,
    // the continuation loop, and stop/clear compose without races.
    var lastMode = "chat";
    var pumpTask = Task.Run(async () =>
    {
        try
        {
            while (true)
            {
                await signal.WaitAsync(cts.Token);
                while (true)
                {
                    if (queue.TryDequeue(out var message))
                    {
                        if (!session.Agent.TryBeginTurn(out var turnToken))
                        {
                            continue; // defensive - the pump is the only turn starter
                        }

                        lastMode = message.Mode;
                        try
                        {
                            await session.Agent.RunTurnAsync(vault, message.Mode, message.Text, Emit, turnToken);
                        }
                        finally
                        {
                            session.Agent.EndTurn();
                        }

                        continue;
                    }

                    if (session.Agent.TryTakePendingSuggestion(out var offset, out var suggested))
                    {
                        var wcts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                        watchCts = wcts;
                        var ran = false;
                        try
                        {
                            ran = await WaitForUserRunAsync(session, offset, wcts.Token);
                        }
                        catch (OperationCanceledException)
                        {
                            // watch interrupted (new message / stop / clear) - fall through;
                            // the loop re-checks the queue next.
                        }

                        if (ran && session.Agent.TryBeginTurn(out var continuationToken))
                        {
                            try
                            {
                                await session.Agent.RunTurnAsync(vault, lastMode,
                                    $"(I pressed Enter and the terminal ran: {suggested}. Read the terminal output, report the "
                                    + "result, and continue with the next single step. If the task is complete, say so and stop suggesting.)",
                                    Emit, continuationToken, isContinuation: true);
                            }
                            finally
                            {
                                session.Agent.EndTurn();
                            }
                        }

                        continue;
                    }

                    break; // nothing queued, nothing pending - sleep until the next signal
                }
            }
        }
        catch (OperationCanceledException)
        {
            // connection closing
        }
    });

    try
    {
        // Pull this host's persisted conversation in (once) before replaying it, so a fresh
        // session to the same host resumes where the last one left off - across restarts too.
        session.Agent.EnsureLoaded(vault);
        await Emit(new { type = "history", messages = session.Agent.Snapshot() });

        var buffer = new byte[8192];
        while (socket.State == WebSocketState.Open && !cts.IsCancellationRequested)
        {
            using var frame = new MemoryStream();
            WebSocketReceiveResult received;
            do
            {
                received = await socket.ReceiveAsync(buffer, cts.Token);
                if (received.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                frame.Write(buffer, 0, received.Count);
            }
            while (!received.EndOfMessage);

            if (received.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (frame.Length == 0)
            {
                continue;
            }

            AgentClientMessage? msg;
            try
            {
                msg = JsonSerializer.Deserialize<AgentClientMessage>(Encoding.UTF8.GetString(frame.ToArray()), AgentJson.Web);
            }
            catch (JsonException)
            {
                await Emit(new { type = "error", message = "Malformed frame." });
                continue;
            }

            switch (msg?.Type)
            {
                case "send":
                    // Never rejected: messages queue in order and the pump drains them one
                    // turn at a time. A new message also supersedes any watch still waiting
                    // on a previous suggestion's Enter.
                    queue.Enqueue((msg.Mode ?? "chat", msg.Text ?? ""));
                    watchCts?.Cancel();
                    signal.Release();
                    break;
                case "stop":
                    queue.Clear(); // stop means stop - queued messages are dropped too
                    watchCts?.Cancel();
                    session.Agent.CancelCurrent();
                    break;
                case "clear":
                    queue.Clear();
                    watchCts?.Cancel();
                    session.Agent.Clear(vault); // also deletes the persisted record
                    await Emit(new { type = "history", messages = Array.Empty<ChatMessage>() });
                    break;
                case "list_chats":
                    await Emit(new { type = "chats", chats = session.Agent.ListChats(vault) });
                    break;
                case "open_chat":
                    // Switching conversations supersedes everything in flight, like clear.
                    queue.Clear();
                    watchCts?.Cancel();
                    if (session.Agent.OpenChat(vault, msg.Id ?? ""))
                    {
                        await Emit(new { type = "history", messages = session.Agent.Snapshot() });
                    }

                    await Emit(new { type = "chats", chats = session.Agent.ListChats(vault) });
                    break;
                case "new_chat":
                    // Unlike clear, the outgoing conversation stays in the saved list.
                    queue.Clear();
                    watchCts?.Cancel();
                    session.Agent.NewChat();
                    await Emit(new { type = "history", messages = Array.Empty<ChatMessage>() });
                    await Emit(new { type = "chats", chats = session.Agent.ListChats(vault) });
                    break;
                case "delete_chat":
                    if (!string.IsNullOrEmpty(msg.Id))
                    {
                        if (session.Agent.DeleteChat(vault, msg.Id))
                        {
                            // Deleted the active conversation - same reset as clear.
                            queue.Clear();
                            watchCts?.Cancel();
                            await Emit(new { type = "history", messages = Array.Empty<ChatMessage>() });
                        }

                        await Emit(new { type = "chats", chats = session.Agent.ListChats(vault) });
                    }

                    break;
            }
        }
    }
    catch (OperationCanceledException) { }
    catch (WebSocketException) { }
    finally
    {
        // Wind the pump down, WAIT for it, THEN dispose socket/cts - the turn's CTS is
        // standalone (not linked to this connection), so a dropped socket doesn't auto-cancel
        // it; CancelCurrent does, and awaiting the pump guarantees no emit races the disposal
        // below.
        cts.Cancel();
        session.Agent.CancelCurrent();
        try
        {
            await pumpTask;
        }
        catch
        {
            // observed
        }

        if (socket.State == WebSocketState.Open)
        {
            try
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "agent closed", CancellationToken.None);
            }
            catch
            {
                // best-effort close
            }
        }

        socket.Dispose();
        cts.Dispose();
        watchCts?.Dispose();
        sendLock.Dispose();
        signal.Dispose();
    }
});

app.Start();
CrashLogger.LogPhase("kestrel started");

// Bring up background port forwards marked auto-start. Best-effort: no-op if the vault is
// still locked (a master-password vault starts its forwards on first connect/unlock instead).
forwarding.StartAutoForwards();
CrashLogger.LogPhase("auto port-forwards started");

// Same best-effort/vault-locked-is-a-no-op shape as the port forwards above.
sync.StartAutoSyncs();
CrashLogger.LogPhase("auto sync rules started");

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
    // Records who asked to quit (window close vs tray "Quit") - a spurious window close right
    // after launch presents to the user exactly like a crash ("tray showed, then it vanished"),
    // so the breadcrumb is what tells the two apart after the fact.
    CrashLogger.LogPhase("shutdown requested (window closed or tray Quit)");
    AppWindowManager.CloseAllFallbackBrowserWindows();

    // Tear down live sessions BEFORE stopping the host: their WS handlers only return once
    // the blocking shell-read pump unblocks, and the graceful stop below waits for exactly
    // those handlers - without this, quitting with an SSH session open stalls until the
    // session happens to end. Disposal makes the shell reads throw ObjectDisposedException
    // immediately; ApplicationStopping (linked into the WS receive loops) and the 2s
    // ShutdownTimeout backstop cover everything else.
    sessions.DisposeAll();
    sftpSessions.DisposeAll();
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
    CrashLogger.LogPhase("tray icon started, opening window");

    // Create the native window immediately so Windows gives the running application a
    // taskbar button as well as its tray icon. The window already uses the embedded app
    // icon (AppWindowManager.SetIconFile). Closing it quits the app by default; only when
    // the user opts into CloseToTray does the close handler minimize-and-keep-running
    // instead, leaving the taskbar/tray entry available for the rest of the process life.
    OpenWindow();
    CrashLogger.LogPhase("window opened");
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

CrashLogger.LogPhase("running");
await app.WaitForShutdownAsync();
CrashLogger.LogPhase("shut down cleanly");
forwarding.Dispose(); // tears down every background forwarding connection cleanly
sync.Dispose(); // tears down every background sync watcher/connection cleanly
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    trayIcon?.Dispose();
}
