using Slopterm.Server.Headless;

if (args is ["--healthcheck"])
{
    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    try
    {
        var port = Environment.GetEnvironmentVariable("SLOPTERM_HEADLESS_PORT") ?? "8080";
        using var response = await client.GetAsync($"http://127.0.0.1:{port}/healthz");
        return response.IsSuccessStatusCode ? 0 : 1;
    }
    catch
    {
        return 1;
    }
}

var options = HeadlessOptions.FromEnvironment();
var app = HeadlessHost.Build(args, options);
await app.RunAsync();
return 0;
