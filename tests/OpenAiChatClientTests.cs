using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Slopterm.Server.Ai;
using Xunit;

namespace Slopterm.Tests;

public sealed class OpenAiChatClientTests
{
    [Theory]
    [InlineData("\"name\":\"\",", "")]
    [InlineData("\"name\":\"\",", "\"id\":\"\",")]
    [InlineData("", "\"id\":\"\",")]
    [InlineData("\"name\":null,", "\"id\":null,")]
    [InlineData("", "")]
    [InlineData("\"name\":\"get_weather\",", "\"id\":\"call_weather\",")]
    public async Task StreamPreservesToolMetadataAcrossArgumentChunks(string nameField, string idField)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.MapPost("/v1/chat/completions", async context =>
        {
            context.Response.ContentType = "text/event-stream";
            await context.Response.WriteAsync("""
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\"city\": \""}}]},"finish_reason":null}]}


                """);
            await context.Response.Body.FlushAsync();
            await context.Response.WriteAsync($$$"""
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,{{{idField}}}"type":"function","function":{ {{{nameField}}}"arguments":"Paris\"}"}}]},"finish_reason":null}]}

                data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

                data: [DONE]


                """);
        });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await app.StartAsync(timeout.Token);

        var result = await OpenAiChatClient.StreamAsync(
            app.Urls.Single() + "/v1", "test-model",
            [new AiChatMessage { Role = "user", Content = "Check Paris weather." }],
            tools: null, onTextDelta: _ => Task.CompletedTask, ct: timeout.Token);

        Assert.Equal("tool_calls", result.FinishReason);
        var call = Assert.Single(result.ToolCalls);
        Assert.Equal("call_weather", call.Id);
        Assert.Equal("get_weather", call.Function.Name);
        Assert.Equal("{\"city\": \"Paris\"}", call.Function.Arguments);
    }

public sealed class OpenAiChatClientConnectTests
{
    // The connect race is only as good as its fallback pick: it must be an address of the OTHER
    // family (a regression picks another address of the leading family and the fix silently stops
    // working), and there must be none when DNS answered with a single family.
    [Fact]
    public void FallbackIsTheFirstAddressOfTheOtherFamily()
    {
        var v6a = IPAddress.Parse("2606:4700::1");
        var v6b = IPAddress.Parse("2606:4700::2");
        var v4a = IPAddress.Parse("162.159.0.1");
        var v4b = IPAddress.Parse("162.159.0.2");

        Assert.Equal(v4a, OpenAiChatClient.AddressOfOtherFamily([v6a, v6b, v4a, v4b]));
        Assert.Equal(v6a, OpenAiChatClient.AddressOfOtherFamily([v4a, v4b, v6a, v6b]));
        Assert.Null(OpenAiChatClient.AddressOfOtherFamily([v6a, v6b]));
        Assert.Null(OpenAiChatClient.AddressOfOtherFamily([v4a]));
    }
}
}
