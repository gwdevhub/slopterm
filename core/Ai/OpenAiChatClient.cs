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

    // Per-request cap on tokens GENERATED (reasoning + answer). Sent as max_tokens, which
    // overrides the server's own num_predict - so this number, not the Ollama config, governs
    // completion length (it's separate from num_ctx, the context window). Reasoning models
    // spend part - sometimes all - of this budget "thinking" before any visible answer, so
    // it's deliberately generous: too small and a verbose small model exhausts it mid-thought
    // and never emits content (finish_reason "length"). Still bounded rather than unlimited so
    // a runaway small model stays responsive and stoppable; RunTurnAsync surfaces the
    // budget-exhausted case rather than leaving a silent, empty turn.
    private const int MaxResponseTokens = 16384;

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
        CancellationToken ct,
        Func<string, Task>? onReasoningDelta = null)
    {
        var body = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["messages"] = messages,
            ["stream"] = true,
            ["max_tokens"] = MaxResponseTokens,
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
        // Some local models don't use the structured reasoning field - they emit their
        // chain-of-thought inline in content wrapped in <think>...</think> tags. The splitter
        // pulls those out of the answer stream (routing them to the reasoning callback, or just
        // dropping them when there's no sink) so raw think text never lands in the answer.
        var thinkSplitter = new ThinkSplitter(onTextDelta, onReasoningDelta);

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
                        await thinkSplitter.PushAsync(text);
                    }
                }

                // Reasoning models stream their chain-of-thought separately from the answer:
                // Ollama/OpenAI put it in delta.reasoning, DeepSeek/vLLM in reasoning_content,
                // with delta.content empty until thinking ends. Surface it through the reasoning
                // callback so the UI can show a "thinking" indicator instead of a dead-looking
                // turn - it is never mixed into the answer text or the committed history.
                if (onReasoningDelta is not null
                    && (TryGetString(delta, "reasoning", out var reasoning)
                        || TryGetString(delta, "reasoning_content", out reasoning))
                    && !string.IsNullOrEmpty(reasoning))
                {
                    await onReasoningDelta(reasoning);
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

        // Flush any text the splitter was holding back (a trailing '<' it couldn't yet rule
        // out as a tag start, or an unterminated <think> block the model never closed).
        await thinkSplitter.FinishAsync();

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

    /// <summary>
    /// Streams a content channel while pulling out chain-of-thought wrapped in
    /// <c>&lt;think&gt;...&lt;/think&gt;</c> (or <c>&lt;thinking&gt;</c>) tags that some local models
    /// emit inline instead of using the structured reasoning field. Text outside the tags goes to
    /// the answer sink; text inside goes to the reasoning sink (dropped when that's null, e.g. the
    /// safety gate, which keeps think-text out of the verdict). Stateful across chunks: a tag may
    /// straddle a delta boundary, so a trailing fragment that could still grow into a tag is held
    /// back until the next push (or <see cref="FinishAsync"/>).
    /// </summary>
    private sealed class ThinkSplitter(Func<string, Task> onText, Func<string, Task>? onReasoning)
    {
        private static readonly string[] OpenTags = ["<think>", "<thinking>"];
        private static readonly string[] CloseTags = ["</think>", "</thinking>"];
        private const int LongestTag = 11; // "</thinking>"

        private bool _inThink;
        private string _buffer = "";

        public async Task PushAsync(string chunk)
        {
            _buffer += chunk;
            while (true)
            {
                if (!_inThink)
                {
                    var open = IndexOfAnyTag(_buffer, OpenTags);
                    var close = IndexOfAnyTag(_buffer, CloseTags);
                    if (open.Index < 0 && close.Index < 0)
                    {
                        await EmitHoldingBackPartialTagAsync(onText);
                        return;
                    }

                    // An orphan close tag (no matching open) is dropped so it never renders
                    // literally; otherwise the earlier open tag switches us into think mode.
                    if (close.Index >= 0 && (open.Index < 0 || close.Index < open.Index))
                    {
                        await EmitAsync(onText, _buffer[..close.Index]);
                        _buffer = _buffer[(close.Index + close.Length)..];
                        continue;
                    }

                    await EmitAsync(onText, _buffer[..open.Index]);
                    _buffer = _buffer[(open.Index + open.Length)..];
                    _inThink = true;
                }
                else
                {
                    var close = IndexOfAnyTag(_buffer, CloseTags);
                    if (close.Index < 0)
                    {
                        await EmitHoldingBackPartialTagAsync(onReasoning);
                        return;
                    }

                    await EmitAsync(onReasoning, _buffer[..close.Index]);
                    _buffer = _buffer[(close.Index + close.Length)..];
                    _inThink = false;
                }
            }
        }

        /// <summary>End of stream: flush whatever's left to the current sink, tags and all.</summary>
        public Task FinishAsync()
        {
            var rest = _buffer;
            _buffer = "";
            return rest.Length == 0 ? Task.CompletedTask : EmitAsync(_inThink ? onReasoning : onText, rest);
        }

        // Emit everything except a trailing run starting at the last '<' that could still grow
        // into a tag - that fragment stays buffered until the next chunk disambiguates it.
        private Task EmitHoldingBackPartialTagAsync(Func<string, Task>? sink)
        {
            var emitLen = _buffer.Length;
            var lastLt = _buffer.LastIndexOf('<');
            if (lastLt >= 0 && _buffer.Length - lastLt < LongestTag && CouldStartTag(_buffer[lastLt..]))
            {
                emitLen = lastLt;
            }

            if (emitLen <= 0)
            {
                return Task.CompletedTask;
            }

            var segment = _buffer[..emitLen];
            _buffer = _buffer[emitLen..];
            return EmitAsync(sink, segment);
        }

        private static Task EmitAsync(Func<string, Task>? sink, string text)
            => sink is null || text.Length == 0 ? Task.CompletedTask : sink(text);

        // Earliest occurrence of any of the tags (case-insensitive), with the matched length.
        private static (int Index, int Length) IndexOfAnyTag(string haystack, string[] tags)
        {
            var best = -1;
            var bestLen = 0;
            foreach (var tag in tags)
            {
                var i = haystack.IndexOf(tag, StringComparison.OrdinalIgnoreCase);
                if (i >= 0 && (best < 0 || i < best))
                {
                    best = i;
                    bestLen = tag.Length;
                }
            }

            return (best, bestLen);
        }

        // True if `tail` (which begins at a '<') is a prefix of some tag, i.e. it might still
        // become one once more text arrives ("<", "<thi", "</thin"). A '<' that can't begin any
        // tag (like a literal "< " or "<x") returns false so it emits immediately.
        private static bool CouldStartTag(string tail)
        {
            foreach (var tag in OpenTags)
            {
                if (tag.StartsWith(tail, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            foreach (var tag in CloseTags)
            {
                if (tag.StartsWith(tail, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }
    }

    private static bool TryGetString(JsonElement obj, string name, out string? value)
    {
        if (obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String)
        {
            value = el.GetString();
            return true;
        }

        value = null;
        return false;
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
