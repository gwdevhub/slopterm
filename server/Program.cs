using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Slopterm.Server;
using Slopterm.Server.Native;
using Slopterm.Server.Vault;

var builder = WebApplication.CreateBuilder(args);

// Loopback-only, OS-assigned free port: never reachable from other machines by default.
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));

var app = builder.Build();

var launchToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
var sessions = new SessionStore();
var vault = new VaultService();

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
        var port = context.Request.Host.Port;
        var allowedOrigins = new[] { $"http://127.0.0.1:{port}", $"http://localhost:{port}" };
        if (!allowedOrigins.Contains(origin))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
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
        sessions.Add(session);
        return Results.Ok(new { sessionId = session.Id });
    }
    catch (Exception ex)
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

app.MapDelete("/api/ssh/session/{sessionId}", (string sessionId) =>
{
    sessions.Remove(sessionId);
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

    sessions.Remove(sessionId);
});

app.Start();

var addressesFeature = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>();
var boundPort = new Uri(addressesFeature?.Addresses.First() ?? "http://127.0.0.1:0").Port;
var launchUrl = $"http://127.0.0.1:{boundPort}/?token={launchToken}";

void OpenInBrowser() => Process.Start(new ProcessStartInfo(launchUrl) { UseShellExecute = true });

WindowsTrayIcon? trayIcon = null;
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    // No console window on the published build (see the .csproj) - the tray icon is the
    // only way to reach the app. Left-click/"Open" opens the browser; "Quit" stops it.
    trayIcon = new WindowsTrayIcon("slopterm", OpenInBrowser, () => app.Lifetime.StopApplication());
    trayIcon.Start();
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
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    trayIcon?.Dispose();
}
