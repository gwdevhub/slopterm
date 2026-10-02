using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Slopterm.Server.Headless;

public static class HeadlessHost
{
    public static WebApplication Build(string[] args, HeadlessOptions options)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.ConfigureKestrel(server =>
            server.Listen(options.ListenAddress, options.Port));
        var app = builder.Build();
        var executor = new HeadlessCommandExecutor(options);

        app.Use(async (context, next) =>
        {
            if (context.Request.Path == "/healthz")
            {
                await next();
                return;
            }

            var authorization = context.Request.Headers.Authorization.ToString();
            const string prefix = "Bearer ";
            if (!authorization.StartsWith(prefix, StringComparison.Ordinal) ||
                !TokenEquals(authorization[prefix.Length..], options.ApiToken))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            await next();
        });

        app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));
        app.MapGet("/api/v1/hosts", () => Results.Ok(
            options.Hosts.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => new
                {
                    alias = pair.Key,
                    address = pair.Value.Address,
                    port = pair.Value.Port,
                    username = pair.Value.Username,
                })));
        app.MapPost("/api/v1/exec/{alias}", async Task<Results<
            Ok<HeadlessExecutionResult>,
            BadRequest<object>,
            NotFound<object>>> (
            string alias,
            HeadlessExecuteRequest request,
            CancellationToken cancellationToken) =>
        {
            if (!options.Hosts.ContainsKey(alias))
            {
                return TypedResults.NotFound<object>(new { error = $"Unknown host alias: {alias}." });
            }

            try
            {
                return TypedResults.Ok(await executor.ExecuteAsync(alias, request, cancellationToken));
            }
            catch (ArgumentException ex)
            {
                return TypedResults.BadRequest<object>(new { error = ex.Message });
            }
        });

        return app;
    }

    internal static bool TokenEquals(string presented, string expected)
    {
        var presentedBytes = Encoding.UTF8.GetBytes(presented);
        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        return presentedBytes.Length == expectedBytes.Length &&
               CryptographicOperations.FixedTimeEquals(presentedBytes, expectedBytes);
    }
}
