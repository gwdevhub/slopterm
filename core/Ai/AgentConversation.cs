using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Slopterm.Server.Vault;

namespace Slopterm.Server.Ai;

/// <summary>
/// Per-SSH-session AI conversation state and agentic loop, backed by a local OpenAI-compatible
/// server. Modes: chat (answer only), suggest (type for the user to confirm), auto (execute with a safety check).
/// </summary>
public sealed class AgentConversation : IDisposable
{
    // Transcripts are capped when persisted so a long-lived host chat can't grow unbounded.
    private const int MaxPersistedMessages = 200;

    // How much command output a single tool result may carry back to the model - capped because a
    // tool result is persisted and re-sent on every subsequent round of the turn.
    private const int MaxToolOutputBytes = 256 * 1024;

    private readonly TerminalSession _session;
    private readonly string _hostKey;         // "user@host:port", lowercase - groups saved chats per host
    private readonly string _legacyRecordId;  // pre-multi-chat record id (hash of _hostKey) - adopted if present
    private string _currentChatId;
    private readonly object _stateLock = new();
    private readonly List<AiChatMessage> _history = []; // model turns (always ends with an assistant msg or empty)
    private readonly List<ChatMessage> _transcript = [];
    private bool _loaded;
    private bool _busy;
    private int _generation;                             // bumped by Clear() so an in-flight turn skips its commit
    private CancellationTokenSource? _currentCts;        // per-turn, standalone (not linked to the connection)
    // A command typed but not executed (suggest mode, or an auto-mode safety flag), with the
    // scrollback offset it was typed at and how many line breaks were injected; the WS handler
    // watches from that offset for the user's first Enter.
    private (long Offset, string Command, int InjectedNewlines)? _pendingSuggestion;

    public AgentConversation(TerminalSession session)
    {
        _session = session;
        _hostKey = $"{session.Username}@{session.Host}:{session.Port}".ToLowerInvariant();
        // Records written before multi-chat used this deterministic per-host id (hashed so the vault
        // filename stays path-safe) - still recognized so old chats survive the upgrade.
        _legacyRecordId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_hostKey)))[..32].ToLowerInvariant();
        _currentChatId = NewChatId();
    }

    private static string NewChatId() => Guid.NewGuid().ToString("N");

    /// <summary>True when this saved record belongs to this host's conversation list.</summary>
    private bool BelongsToHost(string id, AiChatRecord record)
        => record.HostKey == _hostKey || (record.HostKey is null && id == _legacyRecordId);

    /// <summary>
    /// Pulls the most recent persisted conversation for this host into memory (once); older ones stay
    /// reopenable. Best-effort: a locked vault loads nothing and leaves <c>_loaded</c> false to retry.
    /// </summary>
    public void EnsureLoaded(VaultService vault)
    {
        lock (_stateLock)
        {
            if (_loaded || !vault.IsUnlocked)
            {
                return;
            }

            var latest = vault.ListAiChats()
                .Where(c => BelongsToHost(c.Id, c.Record))
                .OrderByDescending(c => c.UpdatedAt)
                .FirstOrDefault();
            if (latest.Record is { Messages.Count: > 0 } && _transcript.Count == 0)
            {
                _currentChatId = latest.Id;
                LoadMessagesLocked(latest.Record.Messages);
            }

            _loaded = true;
        }
    }

    /// <summary>Replaces in-memory state from a saved transcript. Caller holds <c>_stateLock</c>.</summary>
    private void LoadMessagesLocked(List<ChatMessage> saved)
    {
        _transcript.Clear();
        _history.Clear();
        _transcript.AddRange(saved);
        foreach (var message in saved)
        {
            if (string.IsNullOrEmpty(message.Text))
            {
                continue;
            }

            _history.Add(new AiChatMessage
            {
                Role = message.Role == "user" ? "user" : "assistant",
                Content = message.Text,
            });
        }

        // The model history invariant: ends with an assistant message or is empty.
        while (_history.Count > 0 && _history[^1].Role != "assistant")
        {
            _history.RemoveAt(_history.Count - 1);
        }
    }

    /// <summary>This host's saved conversations, newest first, for the bar's chats list.</summary>
    public List<ChatSummary> ListChats(VaultService vault)
    {
        EnsureLoaded(vault);
        string currentId;
        lock (_stateLock)
        {
            currentId = _currentChatId;
        }

        return vault.ListAiChats()
            .Where(c => BelongsToHost(c.Id, c.Record))
            .OrderByDescending(c => c.UpdatedAt)
            .Select(c => new ChatSummary
            {
                Id = c.Id,
                Title = c.Record.Title
                    ?? OneLine(c.Record.Messages.FirstOrDefault(m => m.Role == "user" && m.Text.Length > 0)?.Text ?? "Untitled chat", 60),
                UpdatedAt = c.UpdatedAt,
                MessageCount = c.Record.Messages.Count,
                Active = c.Id == currentId,
            })
            .ToList();
    }

    /// <summary>
    /// Switches the active conversation to a saved one, cancelling any in-flight turn the same way
    /// <see cref="Clear"/> does (generation bump).
    /// </summary>
    public bool OpenChat(VaultService vault, string id)
    {
        var record = vault.GetAiChat(id);
        if (record is null || !BelongsToHost(id, record))
        {
            return false;
        }

        lock (_stateLock)
        {
            _generation++;
            _pendingSuggestion = null;
            _currentChatId = id;
            LoadMessagesLocked(record.Messages);
            _loaded = true;
            try
            {
                _currentCts?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        return true;
    }

    /// <summary>Starts a fresh conversation without deleting the current one (that's <see cref="Clear"/>).</summary>
    public void NewChat()
    {
        lock (_stateLock)
        {
            _generation++;
            _transcript.Clear();
            _history.Clear();
            _pendingSuggestion = null;
            _currentChatId = NewChatId();
            _loaded = true;
            try
            {
                _currentCts?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }

    /// <summary>
    /// Deletes a saved conversation; true when it was the active one, which the caller then treats like a clear.
    /// </summary>
    public bool DeleteChat(VaultService vault, string id)
    {
        bool wasActive;
        lock (_stateLock)
        {
            wasActive = id == _currentChatId;
        }

        if (wasActive)
        {
            NewChat();
        }

        vault.DeleteAiChat(id);
        return wasActive;
    }

    /// <summary>
    /// Shallow copy is safe: an assistant message is added to <c>_transcript</c> only after it stops mutating.
    /// </summary>
    public IReadOnlyList<ChatMessage> Snapshot()
    {
        lock (_stateLock)
        {
            return _transcript.ToList();
        }
    }

    public bool TryBeginTurn(out CancellationToken token)
    {
        lock (_stateLock)
        {
            if (_busy)
            {
                token = default;
                return false;
            }

            _currentCts = new CancellationTokenSource();
            token = _currentCts.Token;
            _busy = true;
            return true;
        }
    }

    public void CancelCurrent()
    {
        lock (_stateLock)
        {
            try
            {
                _currentCts?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }

    public void EndTurn()
    {
        lock (_stateLock)
        {
            _busy = false;
            _currentCts?.Dispose();
            _currentCts = null;
        }
    }

    /// <summary>
    /// Wipes both transcript and model history (memory and persisted) and cancels any in-flight turn;
    /// bumping the generation first makes the running turn skip its commit.
    /// </summary>
    public void Clear(VaultService vault)
    {
        string clearedId;
        lock (_stateLock)
        {
            clearedId = _currentChatId;
            _generation++;
            _transcript.Clear();
            _history.Clear();
            _pendingSuggestion = null;
            _currentChatId = NewChatId(); // the deleted record's id is never reused
            _loaded = true; // an explicit clear must not resurrect the old persisted chat
            try
            {
                _currentCts?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        vault.DeleteAiChat(clearedId);
    }

    public void Dispose() => CancelCurrent();

    /// <summary>
    /// The typed-but-not-run suggestion from the last turn, if any - read-and-clear, so each is watched once.
    /// </summary>
    public bool TryTakePendingSuggestion(out long offset, out string command, out int injectedNewlines)
    {
        lock (_stateLock)
        {
            if (_pendingSuggestion is { } pending)
            {
                _pendingSuggestion = null;
                offset = pending.Offset;
                command = pending.Command;
                injectedNewlines = pending.InjectedNewlines;
                return true;
            }

            offset = 0;
            command = "";
            injectedNewlines = 0;
            return false;
        }
    }

    /// <summary>
    /// <paramref name="isContinuation"/> marks an automatic follow-up turn (the user ran a suggested
    /// command): the synthetic prompt goes to the model but not into the visible transcript.
    /// </summary>
    public async Task RunTurnAsync(VaultService vault, string mode, string model, string userText, Func<object, Task> emit, CancellationToken ct, bool isContinuation = false)
    {
        EnsureLoaded(vault);
        var settings = vault.GetSettings();
        // Read once per turn: the endpoint's optional bearer token is null for a keyless local Ollama,
        // and whenever the vault is locked (which surfaces as the endpoint's own 401).
        var apiKey = vault.GetAiApiKey();
        var assistantId = Guid.NewGuid().ToString("N");
        var assistant = new ChatMessage { Id = assistantId, Role = "assistant", Mode = mode };
        var userMessage = new AiChatMessage { Role = "user", Content = userText };

        int gen;
        List<AiChatMessage> baseHistory;
        lock (_stateLock)
        {
            gen = _generation;
            _pendingSuggestion = null; // each turn re-establishes its own suggestion, if any
            if (!isContinuation)
            {
                _transcript.Add(new ChatMessage
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Role = "user",
                    Text = userText,
                    Mode = mode,
                });
            }

            baseHistory = [.. _history];
        }

        var localHistory = new List<AiChatMessage>(baseHistory) { userMessage };
        // Request-only plumbing (the suggest-mode nudge below) - stripped before commit so it
        // never pollutes the persisted conversation.
        var nudgePlumbing = new List<AiChatMessage>();

        // Emitted before the request is attempted, so an unreachable server still produces the
        // turn_start -> turn_done(error) pair the frontend expects.
        await emit(new { type = "turn_start", id = assistantId, mode });

        // Stream chain-of-thought as a separate "thinking" channel (never into assistant.Text or
        // history); track whether it held a code span for the suggest-mode rescue nudge below.
        var reasoningHadCodeSpan = false;
        Func<string, Task> onReasoning = text =>
        {
            if (!reasoningHadCodeSpan && text.Contains('`'))
            {
                reasoningHadCodeSpan = true;
            }

            return emit(new { type = "reasoning_delta", id = assistantId, text });
        };

        var stopReason = "end_turn";
        string? error = null;
        // The final round's finish_reason - "length" means the model hit the token cap (often a
        // reasoning model that spent it all thinking), used below to explain an empty answer.
        var lastFinishReason = "stop";
        try
        {
            // Chat mode sends no tools and instead inlines recent terminal output into the system
            // prompt fresh each request; it never enters the committed history.
            var tools = mode switch
            {
                "suggest" => SuggestTools,
                "auto" => AutoTools,
                _ => null,
            };

            var suggestNudged = false;
            var bufferNextRound = false;
            // The text the final round contributed to assistant.Text and whether that round made
            // tool calls - used to tell a complete answer from one that ended mid-thought.
            var lastRoundText = "";
            var lastRoundHadToolCalls = false;

            while (true)
            {
                ct.ThrowIfCancellationRequested();

                var request = new List<AiChatMessage>
                {
                    new() { Role = "system", Content = SystemPrompt(mode, model) },
                };
                request.AddRange(localHistory);

                var textLenBefore = assistant.Text.Length;

                // The nudged round is buffered so a bare "DONE" can be discarded before reaching
                // the UI. roundText tracks only this round - the tool-call echo must not accumulate.
                var bufferThisRound = bufferNextRound;
                bufferNextRound = false;
                var roundText = new StringBuilder();

                var result = await OpenAiChatClient.StreamAsync(
                    settings.AiBaseUrl, model, request, tools,
                    async text =>
                    {
                        roundText.Append(text);
                        if (bufferThisRound)
                        {
                            return;
                        }

                        assistant.Text += text;
                        await emit(new { type = "text_delta", id = assistantId, text });
                    },
                    ct,
                    onReasoning,
                    apiKey);
                lastFinishReason = result.FinishReason;

                if (bufferThisRound)
                {
                    var buffered = roundText.ToString().Trim();
                    if (buffered.Length > 0 && !buffered.Equals("DONE", StringComparison.OrdinalIgnoreCase))
                    {
                        var addition = (assistant.Text.Length > 0 ? "\n\n" : "") + buffered;
                        assistant.Text += addition;
                        await emit(new { type = "text_delta", id = assistantId, text = addition });
                    }
                }

                // Exactly what THIS round added to the visible answer (delta-based, so it captures
                // the buffered path's "\n\n"-joined addition and excludes a discarded "DONE").
                lastRoundText = assistant.Text[textLenBefore..];
                lastRoundHadToolCalls = result.ToolCalls.Count > 0;

                if (result.ToolCalls.Count == 0)
                {
                    // Small models sometimes narrate the command instead of calling suggest_command.
                    // One retry, if the answer or reasoning has a code span and nothing was typed.
                    if (mode == "suggest" && !suggestNudged
                        && !assistant.Activities.Any(a => a.Tool == "suggest_command")
                        && (assistant.Text.Contains('`') || reasoningHadCodeSpan))
                    {
                        suggestNudged = true;
                        bufferNextRound = true;
                        var narrated = new AiChatMessage { Role = "assistant", Content = assistant.Text };
                        var nudge = new AiChatMessage
                        {
                            Role = "user",
                            Content = "If your reply proposes a shell command, call the suggest_command tool with that exact "
                                + "command now so it is typed into my terminal ready to run. If there is nothing to type, "
                                + "reply with just: DONE",
                        };
                        nudgePlumbing.Add(narrated);
                        nudgePlumbing.Add(nudge);
                        localHistory.Add(narrated);
                        localHistory.Add(nudge);
                        continue;
                    }

                    break;
                }

                // Echo the assistant's tool-call turn, execute each call, and append matching tool
                // results (the OpenAI dialect requires one role:"tool" message per tool_call id).
                var echoText = roundText.ToString().Trim();
                localHistory.Add(new AiChatMessage
                {
                    Role = "assistant",
                    Content = echoText.Length > 0 ? echoText : null,
                    ToolCalls = result.ToolCalls,
                });

                foreach (var call in result.ToolCalls)
                {
                    var input = ParseArguments(call.Function.Arguments);
                    var (summary, output) = await ExecuteToolAsync(settings, apiKey, mode, model, call.Function.Name, input, ct);
                    assistant.Activities.Add(new ChatActivity { Tool = call.Function.Name, Summary = summary });
                    await emit(new { type = "tool_activity", id = assistantId, tool = call.Function.Name, summary });
                    localHistory.Add(new AiChatMessage { Role = "tool", ToolCallId = call.Id, Content = output });
                }

                // A suggestion is now typed and awaiting the user's Enter, so further tool rounds can
                // only hit "one already pending"; end the tool loop now.
                if (HasPendingSuggestion())
                {
                    break;
                }
            }

            // Small local models often end a turn mid-thought after tool work; guarantee a complete
            // answer with one final no-tools request. Request-local, never committed to history.
            var partial = assistant.Text.TrimEnd();
            var endedMidThought = partial.Length == 0
                || lastFinishReason == "length"
                || partial.EndsWith(':');
            if (assistant.Activities.Count > 0 && endedMidThought)
            {
                var followUp = new List<AiChatMessage>
                {
                    new() { Role = "system", Content = SystemPrompt(mode, model) },
                };
                followUp.AddRange(localHistory);
                var hasPartial = partial.Length > 0;
                // A natural-break round's text lives only in assistant.Text, not localHistory, so
                // re-add just that trailing piece; a tool-call round's text is already in history.
                if (hasPartial && !lastRoundHadToolCalls && lastRoundText.Trim().Length > 0)
                {
                    followUp.Add(new AiChatMessage { Role = "assistant", Content = lastRoundText });
                }

                followUp.Add(new AiChatMessage
                {
                    Role = "user",
                    Content = hasPartial
                        ? "Continue and finish that reply now, using the tool results above - complete the summary you started. "
                          + "Write only the remaining part; do not repeat what you already said, and do not call any tools."
                        : "Based on the tool results above, tell me in one or two sentences what happened and answer my original question. Do not call any tools.",
                });

                var conclusion = await OpenAiChatClient.StreamAsync(
                    settings.AiBaseUrl, model, followUp, tools: null,
                    async text =>
                    {
                        assistant.Text += text;
                        await emit(new { type = "text_delta", id = assistantId, text });
                    },
                    ct,
                    onReasoning,
                    apiKey);
                lastFinishReason = conclusion.FinishReason;
            }

            // A reasoning model can spend its whole token budget thinking and produce no visible
            // answer; surface a note instead of leaving the user staring at a silent, blank turn.
            if (string.IsNullOrWhiteSpace(assistant.Text))
            {
                var note = lastFinishReason == "length"
                    ? "The model hit its response-token limit while thinking and never produced an answer. "
                      + "Try a shorter prompt, or switch to a model that doesn't \"think\" as much (Settings -> AI agent)."
                    : assistant.Activities.Count > 0
                        ? "The action completed, but the model didn't write a summary - check the terminal above for the result."
                        : "The model returned an empty response.";
                assistant.Text = note;
                await emit(new { type = "text_delta", id = assistantId, text = note });
            }
        }
        catch (OperationCanceledException)
        {
            stopReason = "stopped";
        }
        catch (InvalidOperationException) when (string.IsNullOrWhiteSpace(settings.AiBaseUrl))
        {
            // Defensive: with no endpoint configured the UI shows no agent bar, so this is only
            // reachable by a direct WebSocket call; an empty base URL makes the URI relative.
            stopReason = "error";
            error = "No AI endpoint is configured. Add one in Settings under \"AI agent\" to use the agent.";
        }
        catch (HttpRequestException)
        {
            stopReason = "error";
            // A remote endpoint that refuses the connection is a different conversation from a
            // local one: telling someone using a hosted endpoint to "start Ollama" is noise.
            error = IsLoopback(settings.AiBaseUrl)
                ? $"Can't reach the local AI server at {settings.AiBaseUrl}. Is Ollama running? Start it (or install it from ollama.com), or fix the address in Settings."
                : $"Can't reach the AI server at {settings.AiBaseUrl}. Check the address (and API key, if it needs one) in Settings under \"AI agent\".";
        }
        catch (Exception ex)
        {
            stopReason = "error";
            error = ex.Message;
        }
        finally
        {
            bool cleared;
            lock (_stateLock)
            {
                cleared = gen != _generation;
                if (!cleared)
                {
                    List<AiChatMessage> commit;
                    if (stopReason == "end_turn")
                    {
                        // Clean, well-formed conversation: the final assistant text isn't in
                        // localHistory yet, and nudge plumbing is request-only - stripped so it never persists.
                        commit = localHistory.Where(m => !nudgePlumbing.Contains(m)).ToList();
                        if (!string.IsNullOrEmpty(assistant.Text))
                        {
                            commit.Add(new AiChatMessage { Role = "assistant", Content = assistant.Text });
                        }
                    }
                    else
                    {
                        // stopped / error: keep the user turn + any streamed assistant TEXT only,
                        // never a dangling tool-call turn without its results.
                        commit = [.. baseHistory, userMessage];
                        if (!string.IsNullOrEmpty(assistant.Text))
                        {
                            commit.Add(new AiChatMessage { Role = "assistant", Content = assistant.Text });
                        }
                    }

                    // Model history must always end with an assistant message. If this turn
                    // produced no assistant content at all, drop it and keep the prior history.
                    if (commit.Count > 0 && commit[^1].Role != "assistant")
                    {
                        commit = [.. baseHistory];
                    }

                    _history.Clear();
                    _history.AddRange(commit);
                    _transcript.Add(assistant);
                }
            }

            if (!cleared)
            {
                Persist(vault);
                await emit(new { type = "turn_done", id = assistantId, stopReason, error });
            }
        }
    }

    /// <summary>Best-effort save of the display transcript (capped) - no-op if the vault is locked.</summary>
    private void Persist(VaultService vault)
    {
        List<ChatMessage> snapshot;
        string chatId;
        lock (_stateLock)
        {
            chatId = _currentChatId;
            snapshot = _transcript.Count <= MaxPersistedMessages
                ? _transcript.ToList()
                : _transcript[^MaxPersistedMessages..];
        }

        if (snapshot.Count == 0)
        {
            return; // never persist an empty conversation - it would litter the chats list
        }

        vault.SaveAiChat(chatId, new AiChatRecord
        {
            HostKey = _hostKey,
            Title = OneLine(snapshot.FirstOrDefault(m => m.Role == "user" && m.Text.Length > 0)?.Text ?? "Untitled chat", 60),
            Messages = snapshot,
        });
    }

    private static IReadOnlyDictionary<string, JsonElement> ParseArguments(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return new Dictionary<string, JsonElement>();
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) ?? new Dictionary<string, JsonElement>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, JsonElement>();
        }
    }

    // --- Tools ---------------------------------------------------------------------------------

    private async Task<(string Summary, string Result)> ExecuteToolAsync(
        AppSettings settings, string? apiKey, string mode, string model, string name, IReadOnlyDictionary<string, JsonElement> input, CancellationToken ct)
    {
        switch (name)
        {
            case "read_terminal":
            {
                var maxLines = 120;
                if (input.TryGetValue("maxLines", out var value) && value.ValueKind == JsonValueKind.Number)
                {
                    maxLines = value.GetInt32();
                }

                var text = AnsiText.Strip(_session.Scrollback.SnapshotTail(16 * 1024));
                return ("read recent output", LastLines(text, maxLines));
            }

            case "suggest_command":
            {
                if (mode != "suggest")
                {
                    return ("blocked suggest_command", "Error: suggest_command is only available in suggest mode. In auto mode use run_command - the safety check handles anything risky.");
                }

                if (HasPendingSuggestion())
                {
                    return ("blocked suggest_command (one already pending)", PendingBlockMessage);
                }

                var command = SanitizeCommand(GetString(input, "command") ?? "", out var sanitizeError);
                if (command is null)
                {
                    return ("rejected suggestion (not a single command)", $"Error: {sanitizeError}");
                }

                if (!TypeSuggestion(command))
                {
                    // The write failed, so nothing is pending and the guard was left disarmed
                    // (see TypeSuggestion); arming it would block every later typing tool.
                    return ("suggest_command failed to type",
                        "Error: the command could not be typed into the terminal (the shell may have disconnected). "
                        + "Nothing is pending - tell the user; they can retry once the session is back.");
                }

                return ($"suggested: {OneLine(command, 80)}",
                    "The command was typed into the terminal but NOT executed - the user must press Enter to run it "
                    + "(or edit/discard it). Do not assume it ran. Answer the user in chat now; if they run it you "
                    + "will automatically be asked to continue.");
            }

            case "run_command":
            {
                if (mode != "auto")
                {
                    return ("blocked run_command", "Error: run_command is only available in auto mode. Use suggest_command instead.");
                }

                if (HasPendingSuggestion())
                {
                    // Critical guard: running now would send Enter onto the pending suggestion's
                    // prompt line, executing it concatenated with this command.
                    return ("blocked run_command (suggestion pending)", PendingBlockMessage);
                }

                var command = SanitizeCommand(GetString(input, "command") ?? "", out var runSanitizeError);
                if (command is null)
                {
                    return ("rejected command (not a single command)", $"Error: {runSanitizeError}");
                }

                var (safe, reason) = await VerifyActionSafeAsync(settings, apiKey, model, command, ct);
                if (!safe)
                {
                    // Type it verbatim, multi-line and all, so the user confirms exactly what would
                    // run; no trailing Enter, so TypeSuggestion leaves the final line awaiting confirm.
                    if (!TypeSuggestion(command))
                    {
                        return ("run_command failed to type",
                            "Error: the flagged command could not be typed into the terminal (the shell may have "
                            + "disconnected). Nothing is pending - tell the user.");
                    }

                    return ($"suggested (safety check): {OneLine(command, 80)}",
                        $"The safety check declined to run this automatically ({reason}). The command was typed into "
                        + "the terminal instead - the user can press Enter to run it or discard it. Tell the user what "
                        + "you suggested and why it was flagged, then answer their question; if they run it you will "
                        + "automatically be asked to continue.");
                }

                var before = _session.Scrollback.TotalWritten;
                // Multi-line commands (heredocs) go out line by line as carriage returns, then a
                // final "\r" runs the last line - a single-line command is just "cmd\r".
                _session.WriteToShell(ToPtyInput(command) + "\r");
                await ReadUntilIdleAsync(ct);
                var output = AnsiText.Strip(_session.Scrollback.SnapshotSince(before, MaxToolOutputBytes));
                return ($"ran: {OneLine(command, 80)}", output);
            }

            case "press_keys":
            {
                if (mode != "auto")
                {
                    return ("blocked press_keys", "Error: press_keys is only available in auto mode.");
                }

                if (HasPendingSuggestion())
                {
                    return ("blocked press_keys (suggestion pending)", PendingBlockMessage);
                }

                var keys = GetString(input, "keys") ?? "";
                // Guard against the observed misuse: models send whole shell commands here, which
                // sit unexecuted (no Enter); anything command-like is redirected to run_command.
                if (keys.Contains(' ') || keys.Length > 8)
                {
                    return ("blocked press_keys (looks like a command)",
                        "Error: press_keys is ONLY for short interactive keystrokes (like y, n, q, a number, or space "
                        + "for a pager). That input looks like a shell command - call run_command with it instead; "
                        + "run_command presses Enter and returns the output.");
                }

                var (safe, reason) = await VerifyActionSafeAsync(settings, apiKey, model, keys, ct);
                if (!safe)
                {
                    if (!TypeSuggestion(keys))
                    {
                        return ("press_keys failed to type",
                            "Error: the flagged keystrokes could not be typed into the terminal (the shell may have "
                            + "disconnected). Nothing is pending - tell the user.");
                    }

                    return ($"suggested keystrokes (safety check): {OneLine(keys, 80)}",
                        $"The safety check declined to send this automatically ({reason}). It was typed without a "
                        + "newline for the user to confirm. Tell the user, then answer their question.");
                }

                var before = _session.Scrollback.TotalWritten;
                _session.WriteToShell(keys); // no newline appended - for prompts / pagers
                await Task.Delay(400, ct);
                var output = AnsiText.Strip(_session.Scrollback.SnapshotSince(before, MaxToolOutputBytes));
                return ($"pressed keys: {OneLine(keys, 80)}", output);
            }

            case "wait":
            {
                if (mode == "chat")
                {
                    return ("blocked wait (chat mode)", "Error: wait is not available in chat mode.");
                }

                var seconds = 3;
                if (input.TryGetValue("seconds", out var value) && value.ValueKind == JsonValueKind.Number)
                {
                    seconds = value.GetInt32();
                }

                seconds = Math.Clamp(seconds, 1, 60);
                var before = _session.Scrollback.TotalWritten;
                await Task.Delay(seconds * 1000, ct);
                var output = AnsiText.Strip(_session.Scrollback.SnapshotSince(before, MaxToolOutputBytes));
                return ($"waited {seconds}s", output);
            }

            default:
                // A model can hallucinate a tool (sometimes a whole sentence as the "name");
                // truncate it in the chip and hand back the real tool list so it can correct itself.
                var available = mode == "auto"
                    ? "read_terminal, run_command, press_keys, wait"
                    : "read_terminal, suggest_command, wait";
                return ($"unknown tool: {OneLine(name, 40)}",
                    $"Error: there is no tool named '{OneLine(name, 80)}'. Available tools: {available}. "
                    + "Call one of those, or just reply in chat.");
        }
    }

    /// <summary>
    /// The auto-mode gate: a second model call judges whether the input may be sent to the shell
    /// unconfirmed; fails closed (any error or non-SAFE answer means unsafe).
    /// </summary>
    private async Task<(bool Safe, string Reason)> VerifyActionSafeAsync(AppSettings settings, string? apiKey, string model, string action, CancellationToken ct)
    {
        try
        {
            var tail = LastLines(AnsiText.Strip(_session.Scrollback.SnapshotTail(4 * 1024)), 15);
            var messages = new List<AiChatMessage>
            {
                new()
                {
                    Role = "system",
                    Content =
                        "You are a strict safety gate for an AI agent operating a remote SSH shell. Decide whether the "
                        + "input below may be sent to the shell AUTOMATICALLY, without user confirmation.\n"
                        + "UNSAFE (must be confirmed by the user): deleting or overwriting files/data, package "
                        + "installs/removals/upgrades, service or system restarts/shutdowns, permission/ownership "
                        + "changes, user/account changes, network or firewall configuration, writes to system paths or "
                        + "config files, kill signals, piping downloads into a shell, anything irreversible or "
                        + "resource-destructive, or confirming a prompt that would do any of the above.\n"
                        + "SAFE: read-only inspection (listing, viewing, searching, status/process/disk queries), "
                        + "navigation, pagers, and keystrokes that merely continue a clearly safe operation visible in "
                        + "the terminal.\n"
                        + "Your reply MUST begin with the single bare word SAFE or UNSAFE - no formatting, no markdown, "
                        + "nothing before it - optionally followed by a short reason.",
                },
                new()
                {
                    Role = "user",
                    Content = $"Recent terminal output:\n---\n{tail}\n---\n\nInput about to be sent to the shell:\n{action}",
                },
            };

            var verdict = new StringBuilder();
            await OpenAiChatClient.StreamAsync(
                settings.AiBaseUrl, model, messages, tools: null,
                text =>
                {
                    verdict.Append(text);
                    return Task.CompletedTask;
                },
                ct,
                onReasoningDelta: null,
                apiKey: apiKey);

            var answer = verdict.ToString().Trim();
            if (IsSafeVerdict(answer))
            {
                return (true, "");
            }

            var reason = answer.Length > 0 ? OneLine(answer, 160) : "no verdict";
            return (false, reason);
        }
        catch (OperationCanceledException)
        {
            throw; // a Stop must cancel the whole turn, not read as an unsafe verdict
        }
        catch (Exception ex)
        {
            return (false, $"safety check unavailable: {ex.Message}");
        }
    }

    /// <summary>
    /// Tolerant verdict parse (models wrap the word in markdown or preamble): first decisive word
    /// wins; "not safe" counts as unsafe; no decisive word stays fail-closed.
    /// </summary>
    private static bool IsSafeVerdict(string answer)
    {
        var word = new StringBuilder();
        string previous = "";
        foreach (var c in answer)
        {
            if (char.IsLetter(c))
            {
                word.Append(char.ToUpperInvariant(c));
                continue;
            }

            if (word.Length > 0)
            {
                var current = word.ToString();
                word.Clear();
                if (current == "UNSAFE")
                {
                    return false;
                }

                if (current == "SAFE")
                {
                    return previous != "NOT";
                }

                previous = current;
            }
        }

        var last = word.ToString();
        if (last == "UNSAFE")
        {
            return false;
        }

        return last == "SAFE" && previous != "NOT";
    }

    /// <summary>
    /// Best-effort "command finished" signal against a raw PTY: poll the byte counter every 250ms,
    /// stop after ~750ms quiet, hard-capped at ~15s.
    /// </summary>
    private async Task ReadUntilIdleAsync(CancellationToken ct)
    {
        const int pollMs = 250;
        const int idleThresholdMs = 750;
        const int hardCapMs = 15_000;

        var start = Environment.TickCount64;
        var last = _session.Scrollback.TotalWritten;
        var lastChange = start;

        while (true)
        {
            await Task.Delay(pollMs, ct);
            var now = Environment.TickCount64;
            var current = _session.Scrollback.TotalWritten;

            if (current != last)
            {
                last = current;
                lastChange = now;
            }
            else if (now - lastChange >= idleThresholdMs)
            {
                break;
            }

            if (now - start >= hardCapMs)
            {
                break;
            }
        }
    }

    private static string? GetString(IReadOnlyDictionary<string, JsonElement> input, string key)
        => input.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    /// <summary>
    /// Cleans a model-proposed command into something typeable at a shell prompt (strips markdown
    /// fences and "$ " sigils), or rejects it. Multi-line heredocs pass through verbatim.
    /// </summary>
    private static string? SanitizeCommand(string raw, out string error)
    {
        error = "";
        var text = raw.Trim();

        if (text.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNewline = text.IndexOf('\n');
            text = firstNewline >= 0 ? text[(firstNewline + 1)..] : text[3..];
            var closing = text.LastIndexOf("```", StringComparison.Ordinal);
            if (closing >= 0)
            {
                text = text[..closing];
            }

            text = text.Trim();
        }

        text = text.Trim('`').Trim();
        // Normalize line endings up front so the multi-line test and the later PTY conversion
        // both see a single newline convention.
        text = text.Replace("\r\n", "\n").Replace('\r', '\n');

        if (text.Length == 0)
        {
            error = "That was empty. Send a shell command to run.";
            return null;
        }

        // Multi-line (a heredoc): keep every line exactly as given - trimming indentation or
        // dropping "# ..." would corrupt the body.
        if (text.Contains('\n'))
        {
            return text;
        }

        if (text.StartsWith("$ ", StringComparison.Ordinal))
        {
            text = text[2..].Trim();
        }

        if (text.Length == 0 || text.StartsWith('#'))
        {
            error = "That contained no runnable command (only a comment or a prompt sigil). Send a shell command.";
            return null;
        }

        return text;
    }

    /// <summary>
    /// Converts a multi-line command into shell keyboard input: every line break becomes a carriage
    /// return (the Enter key). Callers append a trailing "\r" only when the final line should run.
    /// </summary>
    private static string ToPtyInput(string command)
        => command.Replace("\r\n", "\n").Replace('\r', '\n').Replace('\n', '\r');

    /// <summary>
    /// Types a proposed command into the PTY and, only if the write reached the shell, arms the
    /// single-pending guard; a failed write returns false with the guard left disarmed.
    /// </summary>
    private bool TypeSuggestion(string text)
    {
        // Capture the offset BEFORE writing: the continuation watch counts newlines past this
        // point, so it has to predate the typed characters.
        var typedAt = _session.Scrollback.TotalWritten;
        // No trailing "\r": the final line is left typed-but-unrun for the user's Enter. A multi-line
        // command's interior line breaks do go out as carriage returns.
        var pty = ToPtyInput(text);
        try
        {
            _session.WriteToShell(pty);
        }
        catch (Exception)
        {
            return false;
        }

        lock (_stateLock)
        {
            // Each injected "\r" echoes back as a newline before the user acts, so the confirming
            // Enter is the one after those (0 for a single-line suggestion).
            _pendingSuggestion = (typedAt, text, pty.Count(c => c == '\r'));
        }

        return true;
    }

    /// <summary>A typed suggestion is already sitting at the prompt - nothing else may be typed until the user acts.</summary>
    private bool HasPendingSuggestion()
    {
        lock (_stateLock)
        {
            return _pendingSuggestion is not null;
        }
    }

    private const string PendingBlockMessage =
        "Error: a suggested command is already typed in the terminal awaiting the user's Enter. Do NOT type anything "
        + "else - it would corrupt the pending command line. Answer the user in chat and stop; you will be asked to "
        + "continue automatically once the user acts.";

    // Is the configured endpoint on this machine? Only used to word connection errors (Ollama
    // advice vs. "check the address and key"), so an unparseable URL just isn't loopback.
    private static bool IsLoopback(string baseUrl)
        => Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) && uri.IsLoopback;

    private static string OneLine(string text, int max)
    {
        var flat = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return flat.Length <= max ? flat : string.Concat(flat.AsSpan(0, max), "…");
    }

    private static string LastLines(string text, int maxLines)
    {
        if (maxLines <= 0)
        {
            return "";
        }

        var lines = text.Split('\n');
        return lines.Length <= maxLines ? text : string.Join('\n', lines[^maxLines..]);
    }

    private string SystemPrompt(string mode, string model)
    {
        // The model id is stated explicitly because local models hallucinate their identity
        // when asked (confidently claiming to be Claude/ChatGPT/etc. - observed live).
        var header =
            $"""
            You are the AI model "{model}", running locally on this machine via an OpenAI-compatible server (Ollama), embedded as the AI agent of the slopterm SSH client. You are attached to a live SSH terminal session connected to {_session.Username}@{_session.Host}:{_session.Port}. If asked what model you are, say "{model}" - do not claim to be any other AI product.
            """;

        // Small local models act and then go silent, so every mode hammers on "always answer in
        // chat" (and RunTurnAsync forces a summary if a turn ends with tool activity but no text).
        const string answerRule =
            "ALWAYS finish your turn by answering the user in the chat. After any tool use, state what happened and "
            + "answer their question in plain language. Never end a turn without a chat reply. Never invent command "
            + "output - only report what the terminal actually shows.";

        switch (mode)
        {
            case "suggest":
                return
                    $"""
                    {header}
                    You cannot execute anything yourself. You can read the recent terminal output (read_terminal), pause for output to settle (wait), and propose a command with the suggest_command tool - it types the command into the terminal WITHOUT executing it; the user reviews it and presses Enter themselves.
                    Whenever the user wants something done or wants a command, you MUST call suggest_command with the exact command - never only write a command in your chat text, because the user expects it typed into the terminal ready to run. Suggest ONE command at a time and explain in chat what it does and why. A single command MAY span multiple lines (for example a heredoc) - put the entire block, its body AND the closing terminator (like EOF), into that one call; do not split a heredoc across calls. When the user runs your suggestion, you are automatically asked to continue: read the result, report it, and suggest the next single command - until the task is complete, then say so clearly and stop suggesting. {answerRule}
                    """;

            case "auto":
                return
                    $"""
                    {header}
                    You can read the recent terminal output (read_terminal), run commands (run_command - it types the command, presses Enter, and returns the output), press a few raw keys for interactive prompts and pagers (press_keys - y/n/q/space only, never a command), and pause for output to settle (wait). Everything you send appears in the user's real terminal, which they are watching live.
                    To run ANY shell command, USE run_command and nothing else - do not ask permission and do not merely describe it. A single command MAY span multiple lines (for example a heredoc) - put the whole block, its body AND the closing terminator (like EOF), into one run_command call; do not split a heredoc across calls or type its body with press_keys. A safety check runs automatically on everything you send: safe, read-only actions execute immediately; anything potentially destructive is only TYPED into the terminal as a suggestion the user must confirm with Enter - when that happens, say so in chat and wait for the user instead of retrying.
                    Prefer reading recent output or waiting to observe results before continuing. {answerRule}
                    """;

            default:
            {
                // Chat mode: no tools, so hand the model the recent output directly. Small
                // local models get a bounded tail to stay inside modest context windows.
                var tail = LastLines(AnsiText.Strip(_session.Scrollback.SnapshotTail(8 * 1024)), 80);
                return
                    $"""
                    {header}
                    Answer the user's questions about this session. You cannot type into the terminal or run anything.
                    Be concise. {answerRule}

                    Recent terminal output (most recent last):
                    ---
                    {tail}
                    ---
                    """;
            }
        }
    }

    // OpenAI-dialect function definitions: chat mode sends none, suggest gets read/wait/suggest,
    // auto adds execution (safety-gated in ExecuteToolAsync).
    private static readonly object ReadTerminalTool = new
    {
        type = "function",
        function = new
        {
            name = "read_terminal",
            description = "Read the most recent output from the SSH terminal session (ANSI escapes stripped).",
            parameters = new
            {
                type = "object",
                properties = new
                {
                    maxLines = new { type = "integer", description = "Maximum number of trailing lines to return (default 120)." },
                },
            },
        },
    };

    private static readonly object WaitTool = new
    {
        type = "function",
        function = new
        {
            name = "wait",
            description = "Pause for a number of seconds to let a long-running command make progress, then return any new output.",
            parameters = new
            {
                type = "object",
                properties = new
                {
                    seconds = new { type = "integer", description = "How many seconds to wait (1-60)." },
                },
            },
        },
    };

    private static readonly object SuggestCommandTool = new
    {
        type = "function",
        function = new
        {
            name = "suggest_command",
            description = "Type a shell command into the terminal WITHOUT executing it. The user reviews it and presses Enter to run it (or discards it). Use this to propose the next command.",
            parameters = new
            {
                type = "object",
                properties = new
                {
                    command = new { type = "string", description = "The shell command to propose. May span multiple lines for constructs like a heredoc - include the whole block (its body and the closing terminator, e.g. EOF); it is typed line by line. No trailing newline." },
                },
                required = new[] { "command" },
            },
        },
    };

    private static readonly object RunCommandTool = new
    {
        type = "function",
        function = new
        {
            name = "run_command",
            description = "Run a shell command in the terminal and return the output it produced. A safety check runs first: commands it flags as potentially destructive are only typed into the terminal for the user to confirm instead of executing.",
            parameters = new
            {
                type = "object",
                properties = new
                {
                    command = new { type = "string", description = "The shell command to run. May span multiple lines for constructs like a heredoc - include the whole block (its body and the closing terminator, e.g. EOF); it is sent line by line and executed. No trailing newline needed." },
                },
                required = new[] { "command" },
            },
        },
    };

    private static readonly object PressKeysTool = new
    {
        type = "function",
        function = new
        {
            name = "press_keys",
            description = "Press a few raw keys in the terminal WITHOUT Enter - ONLY for interactive prompts and pagers (e.g. y, n, q, a number, space). NEVER for shell commands: use run_command for those (it presses Enter and returns the output). Also passes the safety check first.",
            parameters = new
            {
                type = "object",
                properties = new
                {
                    keys = new { type = "string", description = "The exact keystrokes to press (max a few characters, e.g. \"y\" or \"q\")." },
                },
                required = new[] { "keys" },
            },
        },
    };

    private static readonly object SuggestTools = new[] { ReadTerminalTool, WaitTool, SuggestCommandTool };

    // No suggest_command in auto mode on purpose: run_command's safety gate already types unsafe
    // commands, and offering both makes small models take the timid path for everything.
    private static readonly object AutoTools = new[] { ReadTerminalTool, WaitTool, RunCommandTool, PressKeysTool };
}
