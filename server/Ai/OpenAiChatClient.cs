using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Slopterm.Server.Ai;

/// <summary>
/// A minimal OpenAI-compatible chat-completions client (streaming SSE + tool calls), aimed at a
/// local Ollama server by default but working against anything speaking the /v1/chat/completions
/// dialect. Hand-rolled over HttpClient on purpose - the whole point of going local-first is not
/// hauling a vendor SDK along in the self-contained binary (see AGENTS.md's dependency rule).
/// </summary>
public static class OpenAiChatClient
{
    // Infinite client timeout because responses are open-ended streams; every call takes a
    // CancellationToken that actually governs its lifetime (the turn's Stop token, or a short
    // linked timeout for probes).
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };

    public sealed record ChatTurnResult(string FinishReason, List<AiToolCall> ToolCalls);

    /// <summary>
    /// Streams one chat-completions request. Text deltas are forwarded to
    /// <paramref name="onTextDelta"/> as they arrive; accumulated tool calls (if any) come back
    /// in the result. Throws InvalidOperationException with the server's own error message on a
    /// non-2xx response (e.g. "model not found", "does not support tools").
    /// </summary>
    public static async Task<ChatTurnResult> StreamAsync(
        string baseUrl,
        string model,
        IReadOnlyList<AiChatMessage> messages,
        object? tools,
        Func<string, Task> onTextDelta,
        CancellationToken ct)
    {
        var body = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["messages"] = messages,
            ["stream"] = true,
            ["max_tokens"] = 4096,
        };
        if (tools is not null)
        {
            body["tools"] = tools;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl.TrimEnd('/')}/chat/completions")
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };

        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(await ReadErrorAsync(response, ct));
        }

        var finishReason = "stop";
        // Tool-call fragments accumulate by index across chunks (id/name arrive first, the
        // arguments JSON may be split over several deltas).
        var toolCalls = new SortedDictionary<int, (string Id, string Name, StringBuilder Args)>();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (!line.StartsWith("data: ", StringComparison.Ordinal))
            {
                continue;
            }

            var payload = line["data: ".Length..];
            if (payload == "[DONE]")
            {
                break;
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(payload);
            }
            catch (JsonException)
            {
                continue; // tolerate a malformed keep-alive/partial line
            }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0)
                {
                    continue;
                }

                var choice = choices[0];
                if (choice.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String)
                {
                    finishReason = fr.GetString() ?? finishReason;
                }

                if (!choice.TryGetProperty("delta", out var delta))
                {
                    continue;
                }

                if (delta.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.String)
                {
                    var text = content.GetString();
                    if (!string.IsNullOrEmpty(text))
                    {
                        await onTextDelta(text);
                    }
                }

                if (delta.TryGetProperty("tool_calls", out var calls) && calls.ValueKind == JsonValueKind.Array)
                {
                    foreach (var call in calls.EnumerateArray())
                    {
                        var index = call.TryGetProperty("index", out var idx) && idx.ValueKind == JsonValueKind.Number
                            ? idx.GetInt32()
                            : toolCalls.Count;
                        if (!toolCalls.TryGetValue(index, out var acc))
                        {
                            acc = ("", "", new StringBuilder());
                        }

                        if (call.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                        {
                            acc.Id = id.GetString() ?? acc.Id;
                        }

                        if (call.TryGetProperty("function", out var fn))
                        {
                            if (fn.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String)
                            {
                                acc.Name = name.GetString() ?? acc.Name;
                            }

                            if (fn.TryGetProperty("arguments", out var args) && args.ValueKind == JsonValueKind.String)
                            {
                                acc.Args.Append(args.GetString());
                            }
                        }

                        toolCalls[index] = acc;
                    }
                }
            }
        }

        var result = new List<AiToolCall>();
        var fallbackId = 0;
        foreach (var (_, acc) in toolCalls)
        {
            if (string.IsNullOrEmpty(acc.Name))
            {
                continue;
            }

            result.Add(new AiToolCall
            {
                // Some servers omit ids on streamed tool calls; the id only has to pair the
                // tool result back to the call within this conversation, so synthesize one.
                Id = string.IsNullOrEmpty(acc.Id) ? $"call_{++fallbackId}" : acc.Id,
                Function = new AiFunctionCall { Name = acc.Name, Arguments = acc.Args.ToString() },
            });
        }

        return new ChatTurnResult(finishReason, result);
    }

    /// <summary>Model ids the server offers (GET /models), for the reachability/status probe.</summary>
    public static async Task<List<string>> ListModelsAsync(string baseUrl, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        using var response = await Http.GetAsync($"{baseUrl.TrimEnd('/')}/models", timeout.Token);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
        var models = new List<string>();
        if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in data.EnumerateArray())
            {
                if (entry.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                {
                    models.Add(id.GetString() ?? "");
                }
            }
        }

        return models;
    }

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var body = await response.Content.ReadAsStringAsync(ct);
        try
        {
            using var doc = JsonDocument.Parse(body);
            // OpenAI dialect: { "error": { "message": ... } }; Ollama sometimes { "error": "..." }.
            if (doc.RootElement.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.String)
                {
                    return error.GetString() ?? body;
                }

                if (error.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
                {
                    return message.GetString() ?? body;
                }
            }
        }
        catch (JsonException)
        {
        }

        return $"AI server returned {(int)response.StatusCode}: {body}";
    }
}

/// <summary>One entry in the OpenAI-dialect conversation history (snake_case wire names).</summary>
public sealed class AiChatMessage
{
    [JsonPropertyName("role")]
    public required string Role { get; set; }

    [JsonPropertyName("content")]
    public string? Content { get; set; }

    [JsonPropertyName("tool_calls")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<AiToolCall>? ToolCalls { get; set; }

    [JsonPropertyName("tool_call_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolCallId { get; set; }
}

public sealed class AiToolCall
{
    [JsonPropertyName("id")]
    public required string Id { get; set; }

    [JsonPropertyName("type")]
    public string Type { get; set; } = "function";

    [JsonPropertyName("function")]
    public required AiFunctionCall Function { get; set; }
}

public sealed class AiFunctionCall
{
    [JsonPropertyName("name")]
    public required string Name { get; set; }

    // The arguments as a JSON string - that's the OpenAI wire shape, not a nested object.
    [JsonPropertyName("arguments")]
    public required string Arguments { get; set; }
}
