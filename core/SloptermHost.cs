using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Slopterm.Server;
using Slopterm.Server.Ai;
using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;

namespace Slopterm.Server;

// What a UI head needs to point a webview at a running slopterm backend. The desktop
// head (Program.cs) wraps this with a Photino window + tray; a future Android head would
// wrap it with a WebView. Everything below the app/endpoints lives here, host-agnostic;
// only the window/tray shell stays in the head.
public sealed record SloptermHostContext(
    WebApplication App,
    string LaunchUrl,
    VaultService Vault,
    SessionStore<TerminalSession> Sessions,
    SessionStore<SftpSession> SftpSessions,
    ForwardingService Forwarding,
    SyncService Sync,
    SchedulerService Scheduler,
    VaultSyncService VaultSync);

// Builds, configures and starts the Kestrel web app + every endpoint, then returns the
// running app and the loopback launch URL. Free of any desktop-window/tray coupling so a
// non-desktop head (Android WebView) can host the exact same backend.
public static class SloptermHost
{
    public static SloptermHostContext Start(string[] args)
    {
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
// Session ids whose shell is genuinely over, kept for a while after the session itself is
// gone. A terminal that was detached when its shell ended (the app was in the background)
// comes back to an id that no longer resolves, and without this it cannot tell "finished"
// from "expired" - see the /api/ssh/session/{id}/state endpoint. Pruned on the reaper's tick.
var endedSessions = new ConcurrentDictionary<string, DateTimeOffset>();
var vault = new VaultService();
// If settings (persisted from a previous run) say a master password isn't required, this
// transparently unlocks the vault right now - the frontend never sees an unlock prompt.
vault.EnsureUnlockedIfPasswordNotRequired();
CrashLogger.LogPhase("vault + settings loaded");
var forwarding = new ForwardingService(vault);
var sync = new SyncService(vault);
var scheduler = new SchedulerService(vault);
var vaultSync = new VaultSyncService(vault);
var collections = new CollectionService(vault, vaultSync);

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
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = webAssets,
    // Never let a client keep these. The embedded assets carry Last-Modified, so without an
    // explicit header a browser (and Android's WebView especially) is free to heuristically
    // cache them - including index.html, which is what pins the whole app to an old build:
    // the cached HTML keeps asking for the hashed bundle it was built against, the cache
    // serves that too, and an updated app quietly runs its previous UI. That cost a real
    // debugging round - a bug hunted in code the device wasn't actually running. There is also
    // nothing to gain here: the server is on loopback, so re-fetching costs no network at all.
    // Same reasoning as the service worker's deliberate no-caching (see web/public/sw.js).
    OnPrepareResponse = context =>
    {
        var headers = context.Context.Response.Headers;
        headers.CacheControl = "no-store, no-cache, must-revalidate";
        headers.Pragma = "no-cache";
        headers.Expires = "0";
    },
});
app.UseWebSockets();

app.MapPost("/api/ssh/connect", (ConnectRequest request) =>
{
    if (ResolveConnectCredential(vault, request) is { } credentialError)
    {
        return Results.BadRequest(new { error = credentialError });
    }

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
    if (ResolveConnectCredential(vault, request) is { } credentialError)
    {
        return Results.BadRequest(new { error = credentialError });
    }

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

    // The tab's request carries no credential for a saved host - the frontend never received
    // one - so it's resolved here, exactly as the connect endpoints do. Without this, a
    // one-shot upload from an SSH tab would try to authenticate with nothing at all.
    if (ResolveConnectCredential(vault, connect) is { } uploadCredentialError)
    {
        return Results.BadRequest(new { error = uploadCredentialError });
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

// Whether this machine can open a local terminal at all, and what it would open. The frontend
// asks once so it can hide the entry point rather than offer a button that always fails - the
// one platform that says no is Android before API 28 (see UnixPty).
app.MapGet("/api/local/shell", () =>
{
    if (!LocalShell.IsSupported)
    {
        return Results.Ok(new { supported = false, reason = LocalShell.UnsupportedReason, platform = LocalShell.PlatformName(), shell = (string?)null });
    }

    return Results.Ok(new
    {
        supported = true,
        reason = (string?)null,
        platform = LocalShell.PlatformName(),
        shell = LocalShell.DescribeShell(LocalShell.Resolve().Executable),
    });
});

// Opens a shell on the machine slopterm is running on - the desktop's own PC, or the phone -
// and hands back a session id the terminal WebSocket attaches to exactly like an SSH one.
// There is deliberately no separate WS/resize/disconnect/state route for local sessions: they
// go in the same store as SSH sessions and every route past the connect is already shared.
//
// This does mean the loopback API can start a process on the user's machine. That is the same
// boundary /api/local/list already sits on (it reads, renames and deletes the user's files),
// held by the same per-launch token and Origin/Host checks in the middleware above - and the
// app it is exposed to is a terminal client, whose entire purpose is running commands.
app.MapPost("/api/local/shell/connect", (LocalShellRequest request) =>
{
    try
    {
        var session = TerminalSession.StartLocal(request);
        sessions.Add(session.Id, session);
        vault.AppendLog(new LogEntryRecord
        {
            Event = "local_shell_opened",
            Host = session.Host,
            Port = session.Port,
            Username = session.Username,
        });

        return Results.Ok(new { sessionId = session.Id, shell = session.Username, platform = session.Host });
    }
    catch (Exception ex)
    {
        vault.AppendLog(new LogEntryRecord
        {
            Event = "local_shell_failed",
            Host = LocalShell.PlatformName(),
            Port = 0,
            Username = "shell",
            Detail = ex.Message,
        });
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
        if (!vault.Unlock(request.MasterPassword))
        {
            return Results.Json(new { error = "Incorrect master password." }, statusCode: StatusCodes.Status401Unauthorized);
        }

        // "On unlock" is one of the sync triggers - until now the collections weren't even
        // readable, so nothing could have been pushed or pulled.
        vaultSync.RequestSyncAll();
        return Results.Ok();
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

app.MapPost("/api/settings/show-ssh-config-hosts", (SetShowSshConfigHostsRequest request) =>
{
    vault.SetShowSshConfigHosts(request.Enabled);
    return Results.Ok(vault.GetSettings());
});

// Read by the Android head rather than by anything in here - the keep-alive service picks
// its notification channel from it (see MainActivity.RefreshSessionNotificationBadge). It
// lives in settings.json with the rest so it survives reinstalls via the vault backup and is
// editable from the same Settings page.
app.MapPost("/api/settings/session-notification-badge", (SetSessionNotificationBadgeRequest request) =>
{
    vault.SetSessionNotificationBadge(request.Enabled);
    return Results.Ok(vault.GetSettings());
});

// Read-only, sourced live from ~/.ssh/config on every call - no vault unlock needed (same
// posture as /api/local/list: this app already has full local filesystem access, and
// nothing here is ever written back to the file). The frontend only surfaces this behind
// the ShowSshConfigHosts toggle, but the endpoint itself isn't gated on it - a missing/
// unparseable config file already degrades to an empty list with no error either way.
app.MapGet("/api/ssh-config/hosts", () => Results.Ok(SshConfigService.ListHosts()));

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

// The in-terminal AI agent's endpoint/model config - a plain settings.json pair (no unlock
// needed; the local-first default is Ollama's port). The optional API key a hosted endpoint
// needs IS a secret, so it lives in the vault and only its presence is ever reported back.
app.MapGet("/api/settings/ai", () =>
{
    var settings = vault.GetSettings();
    return Results.Ok(new { baseUrl = settings.AiBaseUrl, model = settings.AiModel, hasApiKey = !string.IsNullOrEmpty(vault.GetAiApiKey()) });
});

app.MapPost("/api/settings/ai", (SetAiSettingsRequest request) =>
{
    // An empty URL is a real setting, not a missing one: it turns the agent off, which is
    // also the out-of-the-box state. A pasted URL gets its trailing slash normalized away so
    // "{base}/chat/completions" concatenation stays clean.
    //
    // An omitted model keeps whatever is stored. The model is picked from the endpoint's own
    // /models list in the agent bar, so the Settings form doesn't send one at all - and it
    // must not wipe the picked model just because the URL was saved.
    var current = vault.GetSettings();
    var baseUrl = (request.BaseUrl ?? string.Empty).Trim().TrimEnd('/');
    var model = string.IsNullOrWhiteSpace(request.Model) ? current.AiModel : request.Model.Trim();
    vault.SetAiSettings(baseUrl, model);

    // Only touch the key when the caller actually sent the field (null = keep as is), so a
    // model switch from the agent bar can't clear it. Writing it needs an unlocked vault -
    // the URL/model half is already saved by then, which is the useful partial outcome.
    if (request.ApiKey is not null)
    {
        try
        {
            vault.SetAiApiKey(request.ApiKey.Trim());
        }
        catch (InvalidOperationException ex)
        {
            return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
        }
    }

    return Results.Ok(new { baseUrl, model, hasApiKey = !string.IsNullOrEmpty(vault.GetAiApiKey()) });
});

// Live reachability probe: is the local AI server up, is the configured model actually
// pulled, and what models are available to switch to? Drives the status dot, the model
// picker in the agent bar, and the Settings readout.
app.MapGet("/api/ai/status", async () =>
{
    var settings = vault.GetSettings();
    var apiKey = vault.GetAiApiKey();

    // No endpoint configured is the default state, not an error: the agent is off, the UI
    // renders no bar on a terminal tab, and there is nothing to probe.
    if (string.IsNullOrWhiteSpace(settings.AiBaseUrl))
    {
        return Results.Ok(new
        {
            configured = false,
            reachable = false,
            modelAvailable = false,
            baseUrl = settings.AiBaseUrl,
            model = settings.AiModel,
            models = Array.Empty<string>(),
            hasApiKey = !string.IsNullOrEmpty(apiKey),
            unauthorized = false,
        });
    }

    try
    {
        var models = await OpenAiChatClient.ListModelsAsync(settings.AiBaseUrl, CancellationToken.None, apiKey);
        // Ollama ids carry a tag ("gemma4:12b"); treat a missing tag as ":latest" both ways so
        // "qwen3" matches "qwen3:latest" without the user having to spell it exactly.
        static string Norm(string m) => m.Contains(':') ? m : $"{m}:latest";
        var modelAvailable = models.Any(m => string.Equals(Norm(m), Norm(settings.AiModel), StringComparison.OrdinalIgnoreCase));
        return Results.Ok(new
        {
            configured = true,
            reachable = true,
            modelAvailable,
            baseUrl = settings.AiBaseUrl,
            model = settings.AiModel,
            models,
            hasApiKey = !string.IsNullOrEmpty(apiKey),
            unauthorized = false,
        });
    }
    catch (Exception ex)
    {
        // A 401/403 is a different problem from "nothing is listening" - the endpoint is up
        // and the key is missing, wrong, or unreadable because the vault is locked - so the UI
        // can point at the key instead of telling the user to start Ollama.
        var unauthorized = ex is HttpRequestException { StatusCode: HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden };
        return Results.Ok(new
        {
            configured = true,
            reachable = false,
            modelAvailable = false,
            baseUrl = settings.AiBaseUrl,
            model = settings.AiModel,
            models = Array.Empty<string>(),
            hasApiKey = !string.IsNullOrEmpty(apiKey),
            unauthorized,
        });
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

// --- Collections ------------------------------------------------------------------------
// A collection is the unit of sync and sharing: a set of records that converge with one
// WebDAV URL, end-to-end encrypted under a key the server never sees (see
// core/VaultSync/). The implicit `local` collection isn't listed here - it has no remote
// and never leaves the device, so there is nothing about it to configure.

// The scope catalog, so the UI doesn't hard-code the list (or its warnings) a second time.
app.MapGet("/api/collections/scopes", () => Results.Ok(SyncScopes.All.Select(scope => new
{
    name = scope.Name,
    label = scope.Label,
    defaultOn = scope.DefaultOn,
    warning = scope.Warning,
})));

app.MapGet("/api/vault/collections", () =>
{
    try
    {
        return Results.Ok(collections.List());
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/collections", (CollectionRequest request) =>
{
    try
    {
        return Results.Ok(collections.Create(
            request.Name ?? "Collection", request.RemoteUrl ?? string.Empty,
            request.Username, request.Password, request.Scopes));
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/collections/{id}", (string id, CollectionRequest request) =>
{
    try
    {
        return Results.Ok(collections.Update(
            id, request.Name, request.RemoteUrl, request.Username, request.Password, request.Scopes, request.Enabled));
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (InvalidOperationException ex)
    {
        return Results.NotFound(new { error = ex.Message });
    }
});

// Leaving is local-only by design: it never touches the shared content everyone else is
// still using, and by default it keeps this device's copy of the records.
app.MapDelete("/api/vault/collections/{id}", (string id, bool? keepRecordsLocally) =>
{
    try
    {
        collections.Leave(id, keepRecordsLocally ?? true);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.NotFound(new { error = ex.Message });
    }
});

// What a collection actually carries, grouped by scope - "which of my hosts does the team
// see?", which the record count on the card can't answer. Labels only; the same rule as the
// listing endpoints applies, so no secret is in the response.
app.MapGet("/api/collections/{id}/contents", (string id) =>
{
    try
    {
        return collections.DescribeContents(id) is { } contents
            ? Results.Ok(contents)
            : Results.NotFound(new { error = "No such collection on this device." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapGet("/api/collections/status", () => Results.Ok(vaultSync.GetStatus()));

app.MapPost("/api/collections/{id}/sync", async (string id, CancellationToken ct) =>
{
    try
    {
        await vaultSync.SyncNowAsync(id, ct);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

// The token carries the collection key AND the WebDAV credentials, so the frontend reveals it
// on demand and warns against pasting it into a chat. Access itself is the server's business:
// the receiving device can keep these credentials or swap in its own account.
app.MapGet("/api/collections/{id}/token", (string id, string? passphrase) =>
{
    try
    {
        return Results.Ok(new { token = collections.BuildInviteToken(id, passphrase) });
    }
    catch (InvalidOperationException ex)
    {
        return Results.NotFound(new { error = ex.Message });
    }
});

// Every collection at once - the "set up my new phone in one paste" path.
app.MapGet("/api/collections/token", (string? passphrase) =>
{
    try
    {
        return Results.Ok(new { token = collections.BuildSyncConfigurationToken(passphrase) });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Accepts either token format, so the paste box has one code path whichever the user has.
app.MapPost("/api/collections/join", (JoinCollectionRequest request) =>
{
    try
    {
        return Results.Ok(collections.Join(request.Token ?? string.Empty, request.Passphrase));
    }
    catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException)
    {
        return Results.BadRequest(new { error = "That isn't a valid slopterm collection token, or the passphrase is wrong." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Moves one record between collections - how a private host becomes a shared one.
app.MapPost("/api/vault/records/{folder}/{id}/collection", (string folder, string id, MoveRecordRequest request) =>
{
    if (SyncScopes.FolderFor(folder) is null)
    {
        return Results.BadRequest(new { error = $"{folder} isn't a syncable kind of record." });
    }

    try
    {
        vault.MoveRecord(folder, id, request.CollectionId);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

// Credential material never leaves the backend in a listing: a saved secret is something
// the app uses, not something it shows back to you. What the UI gets instead is whether a
// secret exists, and where the credential RESOLVED on this device (see CredentialResolver),
// so a card can say "your key: prod-deploy" or "no key on this device" without ever
// handling the key itself. Connecting no longer needs the secret client-side either - see
// the connect endpoints, which resolve from hostId.
app.MapGet("/api/vault/hosts", () =>
{
    try
    {
        return Results.Ok(vault.ListHosts().Select(h => MaskHost(vault, h.Id, h.CollectionId, h.UpdatedAt, h.Record)));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/hosts", (HostRecord request, string? collectionId) =>
{
    try
    {
        var id = vault.SaveHost(null, request, collectionId);
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Replace-don't-reveal: the edit form never received the stored secrets, so a credential
// that comes back with no secret means "unchanged", not "cleared". Anything the user
// actually typed arrives populated and replaces what was there.
app.MapPut("/api/vault/hosts/{id}", (string id, HostRecord request) =>
{
    try
    {
        var existing = vault.ListHosts().FirstOrDefault(h => h.Id == id).Record;
        if (existing is not null)
        {
            MergeCredentials(existing.Credentials, request.Credentials);
        }

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

        // A host whose key resolves by name exports as exactly that - a name, no secret.
        // Sharing the inventory without shipping anyone's private key is the whole point of
        // the keychain credential kind.
        return Results.Ok(new { token = HostShareCodec.Encode(match.Record) });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Duplicating has to happen server-side now that credential material never reaches the
// frontend: a copy built from what the UI holds would arrive with no password or key at all.
// The name suffix is applied here for the same reason - it's the only place that can see the
// whole record.
app.MapPost("/api/vault/hosts/{id}/duplicate", (string id) =>
{
    try
    {
        var match = vault.ListHosts().FirstOrDefault(h => h.Id == id);
        if (match.Record is null)
        {
            return Results.NotFound();
        }

        var copy = new HostRecord
        {
            Name = $"{match.Record.Name} (copy)",
            Address = match.Record.Address,
            Port = match.Record.Port,
            ParentGroupId = match.Record.ParentGroupId,
            StartupSnippetIds = [.. match.Record.StartupSnippetIds],
            // Fresh credential ids: the copy is its own record, and sharing ids with the
            // original would make an edit to one look like an edit to the other's credential.
            Credentials = [.. match.Record.Credentials.Select(c => new CredentialRecord
            {
                Id = Guid.NewGuid().ToString("N"),
                Kind = c.Kind,
                Username = c.Username,
                Secret = c.Secret,
                Passphrase = c.Passphrase,
                KeychainName = c.KeychainName,
            })],
        };

        return Results.Ok(new { id = vault.SaveHost(null, copy, match.CollectionId) });
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

// Same masking posture as hosts: the key itself never comes back out. The Keychain screen
// lists names, not key material, and editing replaces rather than reveals.
app.MapGet("/api/vault/keychain", () =>
{
    try
    {
        var entries = vault.ListKeychainEntries().Select(e => new
        {
            id = e.Id,
            collectionId = e.CollectionId,
            updatedAt = e.UpdatedAt,
            entry = new
            {
                e.Record.Name,
                hasPrivateKey = !string.IsNullOrEmpty(e.Record.PrivateKey),
                hasPassphrase = !string.IsNullOrEmpty(e.Record.Passphrase),
            },
        });
        return Results.Ok(entries);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/keychain", (KeychainEntryRecord request, string? collectionId) =>
{
    try
    {
        if (DuplicateKeychainName(vault, request.Name, null, collectionId) is { } duplicate)
        {
            return Results.BadRequest(new { error = duplicate });
        }

        var id = vault.SaveKeychainEntry(null, request, collectionId);
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
        var existing = vault.ListKeychainEntries().FirstOrDefault(e => e.Id == id);
        if (existing.Record is not null)
        {
            // Replace-don't-reveal, same as a host credential: an empty key/passphrase from
            // the edit form means "unchanged", because the form never had them to begin with.
            request.PrivateKey = string.IsNullOrEmpty(request.PrivateKey) ? existing.Record.PrivateKey : request.PrivateKey;
            request.Passphrase = string.IsNullOrEmpty(request.Passphrase) ? existing.Record.Passphrase : request.Passphrase;
        }

        if (DuplicateKeychainName(vault, request.Name, id, existing.Record is null ? null : existing.CollectionId) is { } duplicate)
        {
            return Results.BadRequest(new { error = duplicate });
        }

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

// --- Scheduled jobs: the job records (persisted config) plus live status/run history. ---
// Every mutation pokes the scheduler so it reconciles immediately rather than on its next
// poll; it re-reads the records itself, so there's no separate "apply this change" call.

app.MapGet("/api/vault/jobs", () =>
{
    try
    {
        var jobs = vault.ListJobs().Select(j => new { id = j.Id, updatedAt = j.UpdatedAt, job = j.Record });
        return Results.Ok(jobs);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/api/vault/jobs", (JobRecord request) =>
{
    try
    {
        if (ValidateJob(request) is { } problem)
        {
            return Results.BadRequest(new { error = problem });
        }

        var id = vault.SaveJob(null, request);
        scheduler.Poke();
        return Results.Ok(new { id });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPut("/api/vault/jobs/{id}", (string id, JobRecord request) =>
{
    try
    {
        if (ValidateJob(request) is { } problem)
        {
            return Results.BadRequest(new { error = problem });
        }

        vault.SaveJob(id, request);
        scheduler.Poke();
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/vault/jobs/{id}", (string id) =>
{
    try
    {
        scheduler.CancelRun(id);
        var deleted = vault.DeleteJob(id);
        scheduler.Poke();
        return deleted ? Results.NoContent() : Results.NotFound();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

// Covers every saved job, not just the scheduled ones - "disabled" and "otherDevice" are
// states the UI shows, so an absence here means the job is gone, nothing subtler.
app.MapGet("/api/jobs/status", () => Results.Ok(scheduler.GetStatus()));

// Which install this is, so the UI can say whether a job pinned to a device is pinned to
// THIS one. Non-secret (see DeviceIdentity) and readable with the vault locked.
app.MapGet("/api/jobs/device-id", () => Results.Ok(new { deviceId = DeviceIdentity.Current }));

app.MapGet("/api/jobs/{id}/runs", (string id) =>
{
    try
    {
        return Results.Ok(vault.ListJobRuns(id));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapDelete("/api/jobs/{id}/runs", (string id) =>
{
    vault.ClearJobRuns(id);
    return Results.NoContent();
});

app.MapPost("/api/jobs/{id}/run", (string id) =>
{
    try
    {
        scheduler.RunNow(id);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/jobs/{id}/cancel", (string id) =>
{
    scheduler.CancelRun(id);
    return Results.NoContent();
});

// "When would this actually run?" for the job form, answered before anything is saved - the
// only practical way to tell whether a cron expression says what you meant. Takes the schedule
// fields of an unsaved job (nothing else about it is needed) and returns real instants from the
// same code the loop uses, so the preview can't promise a schedule the scheduler won't keep.
// Needs no vault access, hence no unlock/404 path here.
app.MapPost("/api/jobs/schedule-preview", (SchedulePreviewRequest request) =>
{
    if (request.ScheduleKind == "cron" && SchedulerService.ValidateCronExpression(request.CronExpression) is { } error)
    {
        return Results.Ok(new { runs = Array.Empty<DateTimeOffset>(), error });
    }

    var probe = new JobRecord
    {
        // Placeholders: PreviewNextRuns only ever reads the schedule fields below.
        HostId = string.Empty,
        Name = string.Empty,
        ScheduleKind = request.ScheduleKind,
        IntervalMinutes = request.IntervalMinutes,
        DailyTime = request.DailyTime,
        CronExpression = request.CronExpression,
    };

    return Results.Ok(new { runs = SchedulerService.PreviewNextRuns(probe, 3), error = (string?)null });
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

// Appearance (theme colors + fonts) lives in the vault so it syncs across a user's devices
// like their hosts/snippets. Best-effort exactly like open-tabs above: GET returns null when
// locked or unset (the client keeps its own localStorage cache for instant, pre-unlock
// theming), and the POST no-ops while locked. The body is stored opaquely so the theme schema
// stays a purely client-side concern.
app.MapGet("/api/vault/appearance", () => Results.Ok(vault.GetAppearance()));

app.MapPost("/api/vault/appearance", (JsonElement request) =>
{
    vault.SaveAppearance(request);
    return Results.NoContent();
});

app.MapDelete("/api/ssh/session/{sessionId}", (string sessionId) =>
{
    // Recorded as ended, not merely absent, so the terminal's own socket closing a beat later
    // reads as "this session is finished" rather than "it vanished, dial a new one" - which
    // would reconnect the very session the user just disconnected. Written before the removal
    // because the removal disposes inline and takes a moment, and a probe landing in between
    // would find neither the session nor the marker.
    if (sessions.Get(sessionId) is not null)
    {
        endedSessions[sessionId] = DateTimeOffset.UtcNow;
    }

    var removed = sessions.Remove(sessionId);
    if (removed is not null)
    {
        vault.AppendLog(new LogEntryRecord { Event = "disconnected", Host = removed.Host, Port = removed.Port, Username = removed.Username });
    }

    return Results.NoContent();
});

// Which SSH sessions are still connected. A reloaded page uses this to find the sessions its
// restored tabs were on and reattach to them instead of dialing fresh connections.
// Host/port/username only: no secrets, and all three are already in the open-tabs record and
// the connection log.
// Ended sessions are filtered out even though they're briefly still in the store (the reaper
// collects them on its next tick): reattaching to a shell that has already exited would mount
// a whole terminal onto it just to watch it close again.
// `kind` distinguishes the local-shell sessions that now share this store, so a restored
// local tab reattaches to a local session rather than to whichever session happened to keep
// its id.
app.MapGet("/api/ssh/sessions", () => Results.Ok(
    sessions.Snapshot().Where(entry => !entry.Value.Ended).Select(entry => new
    {
        sessionId = entry.Key,
        kind = entry.Value.Kind,
        host = entry.Value.Host,
        port = entry.Value.Port,
        username = entry.Value.Username,
        attached = entry.Value.IsAttached,
    })));

// The same for SFTP, so a reloaded page reattaches its file-browser tabs rather than opening
// a second connection per tab and orphaning the first (an orphan nothing ever cleans up -
// unlike terminals, SFTP sessions hold no socket to lose and so are never reaped).
//
// Disconnected ones are dropped from the store as they're found, which is the only thing that
// ever collects them. That matters here more than it looks: an SFTP session whose SSH link
// died while the app was backgrounded is unusable, and offering it for reattach would give
// the user a file browser that fails on every click with no way back.
app.MapGet("/api/sftp/sessions", () =>
{
    var connected = new List<KeyValuePair<string, SftpSession>>();
    foreach (var entry in sftpSessions.Snapshot())
    {
        if (entry.Value.IsConnected)
        {
            connected.Add(entry);
        }
        else
        {
            sftpSessions.Remove(entry.Key);
        }
    }

    return Results.Ok(connected.Select(entry => new
    {
        sessionId = entry.Key,
        host = entry.Value.Host,
        port = entry.Value.Port,
        username = entry.Value.Username,
        homeDirectory = entry.Value.HomeDirectory,
    }));
});

// Why a terminal's socket died, from the session's point of view. The browser can't tell a
// rejected upgrade from a dead network - both arrive as an anonymous close - so a reconnecting
// terminal asks here and gets one of three answers:
//   live    - the session is being held for you; reattach.
//   ended   - the shell finished on its own (`exit`), or the user disconnected it, while you
//             were away; close the tab instead of silently dialing a whole new login.
//   unknown - never heard of it, or it aged out, or its transport died. All three mean the
//             same thing to the client: the tab is still wanted, so dial again.
// `ended` is why endedSessions exists at all: without it, a shell that exits while the app is
// backgrounded is indistinguishable from one that timed out, and coming back would hand the
// user a brand-new authenticated session they never asked for.
app.MapGet("/api/ssh/session/{sessionId}/state", (string sessionId) =>
{
    if (sessions.Get(sessionId) is { Ended: false })
    {
        return Results.Ok(new { state = "live" });
    }

    // A session still in the store but with its shell already finished (the reaper hasn't
    // ticked yet) counts as ended, not live - the answer shouldn't depend on timing.
    if (sessions.Get(sessionId) is { ShellEnded: true })
    {
        return Results.Ok(new { state = "ended" });
    }

    return Results.Ok(new { state = endedSessions.ContainsKey(sessionId) ? "ended" : "unknown" });
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

// The terminal's byte pump. Losing this socket does NOT end the SSH session: the session
// keeps running detached (draining into its scrollback) until it's either reattached or
// aged out by the reaper below. That distinction is the whole fix for "switching apps on
// Android kills every connection" - a WebView that gets suspended, reclaimed or reloaded
// drops this socket for reasons that have nothing to do with the user being done with the
// shell, and this handler used to read every one of them as `exit`.
//
// `?since=` is the client's byte offset into the session's total output, so a reattach
// replays exactly what it missed instead of the screen jumping to a fresh prompt. Omitted
// by a client with nothing on screen (a reloaded page), which gets the retained tail.
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

    long? since = long.TryParse(context.Request.Query["since"], out var parsedSince) && parsedSince >= 0
        ? parsedSince
        : null;

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    // ApplicationStopping is linked in so a quit unblocks this handler immediately instead of
    // the graceful stop waiting on it (it would otherwise only return when the session ends).
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, app.Lifetime.ApplicationStopping);

    // AttachAsync owns the socket for its whole life, including the close handshake - the
    // reason it sends has to go out while its own send pump is quiesced, which only it knows.
    var result = await session.AttachAsync(socket, since, cts.Token);

    // The shell finished, or the SSH transport under it died - either way there is nothing
    // left to reattach to, so the session goes now rather than idling out the grace period.
    // Every other way out of AttachAsync leaves it connected and detached for the reaper to
    // age out if nobody comes back.
    if (result is AttachResult.ShellEnded or AttachResult.TransportLost)
    {
        // Marked before it's removed, not after: a client whose socket died without a close
        // frame - which is the whole reason this record exists - probes for the session's
        // fate, and the other order leaves a window where it finds neither the session nor
        // the marker and dials a fresh login to a host whose shell just exited.
        if (result is AttachResult.ShellEnded)
        {
            endedSessions[sessionId] = DateTimeOffset.UtcNow;
        }

        var removed = sessions.Remove(sessionId);
        if (removed is not null)
        {
            vault.AppendLog(new LogEntryRecord { Event = "disconnected", Host = removed.Host, Port = removed.Port, Username = removed.Username });
        }
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

    // True once the terminal shows the user's Enter after the typed suggestion. The suggestion's
    // final line is typed WITHOUT a newline, but a multi-line one (a heredoc) already sent its
    // interior line breaks as carriage returns, which the shell echoes back - so the user's
    // Enter is the first newline PAST those injectedNewlines (0 for a plain single-line
    // suggestion, where the very first newline is the user's). It may equally be them running
    // something else; either way the model then reads what actually happened. Then waits briefly
    // for the output to settle. False on cancel or a 15-minute timeout.
    async Task<bool> WaitForUserRunAsync(TerminalSession target, long offset, int injectedNewlines, CancellationToken token)
    {
        var deadline = Environment.TickCount64 + 15 * 60_000;
        while (Environment.TickCount64 < deadline)
        {
            await Task.Delay(300, token);
            if (target.Scrollback.SnapshotSince(offset).Count(b => b == (byte)'\n') > injectedNewlines)
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

                    if (session.Agent.TryTakePendingSuggestion(out var offset, out var suggested, out var injectedNewlines))
                    {
                        var wcts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                        watchCts = wcts;
                        var ran = false;
                        try
                        {
                            ran = await WaitForUserRunAsync(session, offset, injectedNewlines, wcts.Token);
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
                    // Sending while the saved-chats list is open starts a fresh conversation for
                    // this one message - the "New chat then send" flow the user expects - instead
                    // of appending it to the now-hidden current chat, where it would look like the
                    // message just vanished. Doing it here as part of the send (rather than the
                    // client firing a separate new_chat frame) is deliberate: the new_chat handler
                    // emits an empty history frame, which would wipe the user bubble the client
                    // already rendered optimistically. NewChat() keeps the outgoing chat in the
                    // saved list and supersedes anything in flight (it bumps the generation).
                    if (msg.NewChat)
                    {
                        queue.Clear();
                        session.Agent.NewChat();
                    }

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

// Detached sessions don't live forever. Once a terminal's WebSocket has been gone for the
// whole grace window with nothing reattaching, the SSH connection is torn down and logged
// exactly as an ended session always was - so the old "close the socket, kill the session"
// behavior still happens, just minutes later instead of instantly.
//
// The window is what "keep connections open for a few minutes in the background" means in
// practice: long enough to cover switching to another app and back, short enough that a tab
// the user really is finished with doesn't hold a remote shell open all day. It applies on
// every platform, so a page reload or a webview crash on the desktop is survivable too.
//
// SFTP sessions are deliberately not reaped: they hold no WebSocket, so there's no transport
// to lose and nothing here would ever be able to tell an idle file browser from an abandoned
// one. They keep their existing "live until explicitly disconnected" lifetime.
var detachGrace = TimeSpan.FromMinutes(5);
var endedSessionMemory = TimeSpan.FromMinutes(30);
_ = Task.Run(async () =>
{
    using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
    try
    {
        while (await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping))
        {
            foreach (var (id, session) in sessions.Snapshot())
            {
                // Claiming and removing are two steps because the claim is what settles the
                // race with a reattach arriving in the same instant - see TryBeginReap.
                if (!session.TryBeginReap(detachGrace))
                {
                    continue;
                }

                // Each teardown is best-effort and isolated: disposing a session whose TCP
                // link is by definition suspect can throw out of SSH.NET, and appending to
                // the log touches disk. One failure must cost that session only - if it
                // escaped, this loop would end and nothing would ever be reaped again.
                try
                {
                    if (session.ShellEnded)
                    {
                        endedSessions[id] = DateTimeOffset.UtcNow;
                    }

                    // Remove returns null when something else got there first (a Disconnect
                    // click landing on this same tick), and that caller already logged - the
                    // return value is how this stays one log entry per session, not two.
                    if (sessions.Remove(id) is { } removed)
                    {
                        vault.AppendLog(new LogEntryRecord
                        {
                            Event = "disconnected",
                            Host = removed.Host,
                            Port = removed.Port,
                            Username = removed.Username,
                        });
                    }
                }
                catch (Exception)
                {
                    // Same contract as SessionStore.DisposeAll: one connection failing to
                    // tear down cleanly must not take the rest with it.
                }
            }

            var cutoff = DateTimeOffset.UtcNow - endedSessionMemory;
            foreach (var (id, endedAt) in endedSessions)
            {
                if (endedAt < cutoff)
                {
                    endedSessions.TryRemove(id, out _);
                }
            }
        }
    }
    catch (OperationCanceledException)
    {
        // Shutting down - DisposeAll on the quit path takes it from here.
    }
    catch (Exception)
    {
        // A backstop, not an expected path: everything inside the loop is already guarded.
        // Better a stopped reaper than an unobserved crash on a background task.
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

// The scheduler polls the vault for jobs itself, so unlike the two above there's nothing to
// re-trigger on unlock - a locked vault just means its first passes find no jobs.
scheduler.Start();
CrashLogger.LogPhase("job scheduler started");

// Converges every collection with its WebDAV remote. Like the two above it's a no-op with
// a locked vault - the unlock endpoint re-triggers it, since that's the moment a
// password-protected vault first has collections to read at all.
vaultSync.Start();
vaultSync.RequestSyncAll();
CrashLogger.LogPhase("vault sync started");

var addressesFeature = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>();
var boundPort = new Uri(addressesFeature?.Addresses.First() ?? "http://127.0.0.1:0").Port;
var launchUrl = $"http://127.0.0.1:{boundPort}/?token={launchToken}";
        return new SloptermHostContext(app, launchUrl, vault, sessions, sftpSessions, forwarding, sync, scheduler, vaultSync);
    }

    /// <summary>
    /// A saved host as the UI is allowed to see it: no secrets, but everything needed to
    /// decide whether the card connects and what to say about its credential. `canConnect`
    /// is computed by the same resolver the connect endpoints use, so the button state and
    /// what actually happens on click can never disagree.
    /// </summary>
    private static object MaskHost(VaultService vault, string id, string collectionId, DateTimeOffset updatedAt, HostRecord host) => new
    {
        id,
        collectionId,
        updatedAt,
        canConnect = CredentialResolver.ResolveForHost(vault, collectionId, host)?.CanConnect == true,
        host = new
        {
            host.Name,
            host.Address,
            host.Port,
            host.ParentGroupId,
            host.StartupSnippetIds,
            credentials = host.Credentials.Select(credential => new
            {
                credential.Id,
                credential.Kind,
                credential.Username,
                credential.KeychainName,
                hasSecret = !string.IsNullOrEmpty(credential.Secret),
                hasPassphrase = !string.IsNullOrEmpty(credential.Passphrase),
                resolution = CredentialResolver.Describe(vault, collectionId, credential),
            }),
        },
    };

    /// <summary>
    /// Carries stored secrets forward across an edit. The form never received them, so a
    /// credential arriving with an empty secret means "leave it alone"; one arriving with a
    /// value is a deliberate replacement. Matching is by credential id - a credential the
    /// user removed simply isn't in the incoming list and so isn't carried over.
    /// </summary>
    private static void MergeCredentials(List<CredentialRecord> existing, List<CredentialRecord> incoming)
    {
        foreach (var credential in incoming)
        {
            var previous = existing.FirstOrDefault(c => c.Id == credential.Id);
            if (previous is null)
            {
                continue;
            }

            credential.Secret = string.IsNullOrEmpty(credential.Secret) ? previous.Secret : credential.Secret;
            credential.Passphrase = string.IsNullOrEmpty(credential.Passphrase) ? previous.Passphrase : credential.Passphrase;
        }
    }

    /// <summary>
    /// Keychain names are the join key for name-resolved host credentials, so two entries
    /// sharing one inside a collection would make which key a host connects with a coin
    /// flip. Returns the error message, or null when the name is free.
    /// </summary>
    private static string? DuplicateKeychainName(VaultService vault, string name, string? excludeId, string? collectionId)
    {
        var target = collectionId ?? CollectionStore.LocalCollectionId;
        var clash = vault.ListKeychainEntries().Any(e =>
            e.Id != excludeId &&
            e.CollectionId == target &&
            string.Equals(e.Record.Name.Trim(), name.Trim(), StringComparison.OrdinalIgnoreCase));

        return clash
            ? $"A key called \"{name.Trim()}\" already exists here. Names have to be unique so a host that names a key resolves to exactly one."
            : null;
    }

    /// <summary>
    /// Fills in a connect request's credential from the vault when the client didn't send
    /// one. The frontend deliberately never holds host secrets any more, so a connect to a
    /// saved host arrives as hostId (+ optionally credentialId) and nothing else - this is
    /// where "use a key named prod-deploy" becomes an actual private key, resolved against
    /// what THIS device holds.
    /// </summary>
    private static string? ResolveConnectCredential(VaultService vault, ConnectRequest request)
    {
        if (!string.IsNullOrEmpty(request.Password) || !string.IsNullOrEmpty(request.PrivateKey))
        {
            return null; // Quick Connect / Recent supply their own
        }

        // Quick Connect's "use a saved key": no host to resolve against, just a name.
        if (string.IsNullOrEmpty(request.HostId))
        {
            if (string.IsNullOrEmpty(request.KeychainName))
            {
                return null;
            }

            var named = CredentialResolver.Resolve(
                vault,
                CollectionStore.LocalCollectionId,
                new CredentialRecord { Id = "quick-connect", Kind = "keychain", KeychainName = request.KeychainName });

            if (named?.CanConnect != true)
            {
                return $"No key called \"{request.KeychainName}\" on this device.";
            }

            request.AuthMethod = "privateKey";
            request.PrivateKey = named.PrivateKey;
            request.Passphrase = named.Passphrase;
            return null;
        }

        var match = vault.ListHosts().FirstOrDefault(h => h.Id == request.HostId);
        if (match.Record is null)
        {
            return null;
        }

        var resolved = CredentialResolver.ResolveForHost(vault, match.CollectionId, match.Record, request.CredentialId);
        if (resolved is null)
        {
            return "That host has no credential saved.";
        }

        if (!resolved.CanConnect)
        {
            return resolved.Source == "none" && resolved.Detail is not null
                ? $"No key called \"{resolved.Detail}\" on this device. Add one to the Keychain with that name, or attach a key to this host."
                : "No key on this device for that host.";
        }

        request.Username = string.IsNullOrEmpty(request.Username) ? resolved.Username ?? string.Empty : request.Username;
        request.AuthMethod = resolved.Password is not null ? "password" : "privateKey";
        request.Password = resolved.Password;
        request.PrivateKey = resolved.PrivateKey;
        request.Passphrase = resolved.Passphrase;
        return null;
    }

    /// <summary>
    /// Rejects a job the scheduler couldn't act on sensibly, at save time rather than as a
    /// mystery failed run hours later. Returns null when the job is fine.
    /// </summary>
    private static string? ValidateJob(JobRecord job)
    {
        if (string.IsNullOrWhiteSpace(job.Command) && string.IsNullOrWhiteSpace(job.SnippetId))
        {
            return "A job needs either a command or a snippet to run.";
        }

        if (job.ScheduleKind == "cron")
        {
            if (SchedulerService.ValidateCronExpression(job.CronExpression) is { } cronError)
            {
                return cronError;
            }
        }
        else if (job.ScheduleKind == "daily")
        {
            if (!TimeSpan.TryParseExact(job.DailyTime, @"hh\:mm", CultureInfo.InvariantCulture, out _))
            {
                return "Daily time must be HH:mm (24-hour), e.g. 06:00.";
            }
        }
        else if (job.IntervalMinutes < 1)
        {
            return "The interval must be at least one minute.";
        }

        if (!string.IsNullOrEmpty(job.FailurePattern))
        {
            try
            {
                _ = new Regex(job.FailurePattern);
            }
            catch (ArgumentException ex)
            {
                return $"The failure pattern isn't a valid regular expression: {ex.Message}";
            }
        }

        return null;
    }
}
