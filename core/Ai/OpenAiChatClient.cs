using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Slopterm.Server.Ai;

/// <summary>
/// A minimal OpenAI-compatible chat-completions client (streaming SSE + tool calls). Hand-rolled
/// over HttpClient so no vendor SDK ships in the self-contained binary.
/// </summary>
public static class OpenAiChatClient
{
    // Infinite client timeout: responses are open-ended streams, so every call's CancellationToken
    // actually governs its lifetime.
    private static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        // Hand-rolled Happy Eyeballs (RFC 8305). SocketsHttpHandler dials a host's addresses one at
        // a time (still unimplemented upstream: dotnet/runtime#26177), so on a machine whose IPv6
        // route is a black hole - DNS keeps answering AAAA, nothing routes, nothing errors - every
        // outbound request spends its whole budget on the dead family and never tries IPv4: the
        // agent reads as unreachable on an otherwise fine network. Racing the two families fixes
        // that; RFC 8305 staggers the fallback only to spare healthy networks one stray SYN, which
        // is nothing next to the single connection an AI turn opens anyway.
        ConnectCallback = (context, ct) => new ValueTask<Stream>(ConnectFirstFamilyToAnswerAsync(context, ct)),
    })
    { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>
    /// Resolves the request's host and races the two address families, keeping whichever socket
    /// connects first; the other connect is cancelled and its socket disposed. DNS order (RFC
    /// 6724, via getaddrinfo) leads with the family this machine prefers, which is the favorite.
    /// </summary>
    private static async Task<Stream> ConnectFirstFamilyToAnswerAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var endPoint = context.DnsEndPoint;

        // The handler resolves the host itself but hands the callback only the name, so this is a
        // second lookup - a few cached milliseconds next to a TCP connect.
        var addresses = await Dns.GetHostAddressesAsync(endPoint.Host, ct).ConfigureAwait(false);
        if (addresses.Length == 0)
        {
            throw new SocketException((int)SocketError.HostNotFound);
        }

        // One family only (a loopback Ollama, a v6-only host): nothing to race.
        var fallback = AddressOfOtherFamily(addresses);
        if (fallback is null)
        {
            var socket = await ConnectOneAsync(addresses[0], endPoint.Port, ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }

        using var race = CancellationTokenSource.CreateLinkedTokenSource(ct);
        Task<Socket> preferred = ConnectOneAsync(addresses[0], endPoint.Port, race.Token);
        Task<Socket> alternate = ConnectOneAsync(fallback, endPoint.Port, race.Token);

        Socket winner;
        try
        {
            // Whichever side settles first decides: its socket on success, else - and only once
            // the other side has failed too - its exception.
            Task<Socket> settled = await Task.WhenAny(preferred, alternate).ConfigureAwait(false);
            Task<Socket> other = ReferenceEquals(settled, preferred) ? alternate : preferred;
            try
            {
                winner = await settled.ConfigureAwait(false);
            }
            catch
            {
                winner = await other.ConfigureAwait(false);
            }

            race.Cancel();
            await DiscardAsync(other).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Requests carry the caller's token; cancellation must surface with it, not the race's.
            throw new OperationCanceledException("The AI request was cancelled.", ct);
        }

        return new NetworkStream(winner, ownsSocket: true);
    }

    /// <summary>The first address of the family that DNS did not lead with - the fallback.</summary>
    internal static IPAddress? AddressOfOtherFamily(IReadOnlyList<IPAddress> addresses)
    {
        for (var i = 1; i < addresses.Count; i++)
        {
            if (addresses[i].AddressFamily != addresses[0].AddressFamily)
            {
                return addresses[i];
            }
        }

        return null;
    }

    // NoDelay matches what SocketsHttpHandler's own connect path sets; the socket is disposed on
    // failure or cancellation so a dead attempt never sits on its fd.
    private static async Task<Socket> ConnectOneAsync(IPAddress address, int port, CancellationToken ct)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(address, port, ct).ConfigureAwait(false);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    // Awaits a losing attempt regardless of outcome; an abandoned task would otherwise turn its
    // cancellation into UnobservedTaskException noise.
    private static async Task DiscardAsync(Task<Socket> attempt)
    {
        try
        {
            (await attempt.ConfigureAwait(false)).Dispose();
        }
        catch
        {
            // Cancelled, or failed - the attempt already disposed its socket.
        }
    }

    // Per-request cap on GENERATED tokens (max_tokens overrides the server's num_predict),
    // deliberately generous because reasoning models spend part of it thinking.
    private const int MaxResponseTokens = 16384;

    public sealed record ChatTurnResult(string FinishReason, List<AiToolCall> ToolCalls);

    /// <summary>
    /// Streams one chat-completions request, forwarding text deltas to <paramref name="onTextDelta"/>
    /// and returning accumulated tool calls. Throws InvalidOperationException on a non-2xx response.
    /// </summary>
    public static async Task<ChatTurnResult> StreamAsync(
        string baseUrl,
        string model,
        IReadOnlyList<AiChatMessage> messages,
        object? tools,
        Func<string, Task> onTextDelta,
        CancellationToken ct,
        Func<string, Task>? onReasoningDelta = null,
        string? apiKey = null)
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
        AddAuthorization(request, apiKey);

        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(await ReadErrorAsync(response, ct));
        }

        var finishReason = "stop";
        // Tool-call fragments accumulate by index across chunks (id/name arrive first, the
        // arguments JSON may be split over several deltas).
        var toolCalls = new SortedDictionary<int, (string Id, string Name, StringBuilder Args)>();
        // Some local models emit chain-of-thought inline in content wrapped in <think>...</think>;
        // the splitter routes it to the reasoning callback so it never lands in the answer.
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

                // Ollama/OpenAI stream chain-of-thought in delta.reasoning, DeepSeek/vLLM in
                // reasoning_content; surface it via the callback, never into the answer or history.
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

                        // Some gateways send empty metadata on argument-only continuation chunks.
                        // Preserve the initial id/name rather than erasing a valid tool call.
                        if (TryGetString(call, "id", out var id) && !string.IsNullOrEmpty(id))
                        {
                            acc.Id = id;
                        }

                        if (call.TryGetProperty("function", out var fn))
                        {
                            if (TryGetString(fn, "name", out var name) && !string.IsNullOrEmpty(name))
                            {
                                acc.Name = name;
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
    public static async Task<List<string>> ListModelsAsync(string baseUrl, CancellationToken ct, string? apiKey = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl.TrimEnd('/')}/models");
        AddAuthorization(request, apiKey);
        using var response = await Http.SendAsync(request, timeout.Token);
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
    /// Streams a content channel, pulling out inline <c>&lt;think&gt;</c> chain-of-thought tags; stateful
    /// across chunks so a tag straddling a delta boundary is held back until <see cref="FinishAsync"/>.
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

        // True if `tail` (beginning at a '<') could still become a tag once more text arrives;
        // a '<' that can't begin any tag returns false so it emits immediately.
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

    // Set per request (the key can change between calls), TryAddWithoutValidation so an unusual
    // key can't throw here; omitted when no key is configured (local Ollama ignores it).
    private static void AddAuthorization(HttpRequestMessage request, string? apiKey)
    {
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey.Trim()}");
        }
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
                    var text = message.GetString() ?? body;
                    var upstream = UpstreamDetail(error);
                    return upstream is null ? text : $"{text} {upstream}";
                }
            }
        }
        catch (JsonException)
        {
        }

        return $"AI server returned {(int)response.StatusCode}: {body}";
    }

    /// <summary>
    /// Extracts a concise "(upstream ...)" suffix for gateway errors (Claude Code Router, LiteLLM,
    /// OpenRouter) that bury the provider's real reason under attempts[]; null for plain errors.
    /// </summary>
    private static string? UpstreamDetail(JsonElement error)
    {
        if (!error.TryGetProperty("attempts", out var attempts) || attempts.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var attempt in attempts.EnumerateArray())
        {
            if (attempt.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var status = attempt.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.Number
                ? s.GetInt32()
                : (int?)null;

            // details.error is the provider's own body; the attempt's own "message" is the
            // gateway's wording again, so it's only the fallback.
            string? detail = null;
            if (attempt.TryGetProperty("details", out var details)
                && details.ValueKind == JsonValueKind.Object
                && details.TryGetProperty("error", out var inner))
            {
                if (inner.ValueKind == JsonValueKind.String)
                {
                    detail = inner.GetString();
                }
                else if (TryGetString(inner, "message", out var innerMessage))
                {
                    detail = innerMessage;
                }
            }

            if (string.IsNullOrEmpty(detail) && TryGetString(attempt, "message", out var attemptMessage))
            {
                detail = attemptMessage;
            }

            if (status is null && string.IsNullOrEmpty(detail))
            {
                continue;
            }

            return status is null ? $"(upstream: {detail})"
                : string.IsNullOrEmpty(detail) ? $"(upstream HTTP {status})"
                : $"(upstream {status}: {detail})";
        }

        return null;
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
