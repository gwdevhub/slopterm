using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Slopterm.Server;

var builder = WebApplication.CreateBuilder(args);

// Loopback-only, OS-assigned free port: never reachable from other machines by default.
builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));

var app = builder.Build();

var launchToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
var sessions = new SessionStore();

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

app.UseDefaultFiles();
app.UseStaticFiles();
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

Console.WriteLine();
Console.WriteLine("slopterm is running. Open this URL in your browser:");
Console.WriteLine($"  http://127.0.0.1:{boundPort}/?token={launchToken}");
Console.WriteLine();

await app.WaitForShutdownAsync();
