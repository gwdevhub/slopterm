using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Slopterm.Server.Vault;

namespace Slopterm.Server.Ai;

/// <summary>
/// Per-SSH-session AI conversation state and the agentic loop, backed by a local
/// OpenAI-compatible server (Ollama by default - see AppSettings.AiBaseUrl/AiModel).
/// Constructed with (and owned by) the <see cref="TerminalSession"/>. The transcript is
/// persisted vault-encrypted per host (user@host:port), so reconnecting to the same host -
/// even after an app restart - resumes the conversation. One <c>_stateLock</c> guards ALL of
/// <c>_history</c>, <c>_transcript</c>, <c>_busy</c>, <c>_generation</c>, <c>_loaded</c> and
/// <c>_currentCts</c>.
///
/// Three permission modes:
///  - "chat": answers only; no tools at all (recent terminal output is inlined into the
///    prompt instead, so it also works with models lacking tool support).
///  - "suggest": may TYPE a command into the terminal (no newline) for the user to confirm
///    with Enter; never executes anything itself.
///  - "auto": may execute - but every command/keystroke first passes a safety check (a
///    second model call that sees the recent terminal context); anything flagged unsafe is
///    only typed as a suggestion, like "suggest" mode. Fails closed if the check errors.
/// </summary>
public sealed class AgentConversation : IDisposable
{
    // Transcripts are capped when persisted so a long-lived host chat can't grow unbounded.
    private const int MaxPersistedMessages = 200;

    private readonly TerminalSession _session;
    private readonly string _hostKey;         // "user@host:port", lowercase - groups saved chats per host
    private readonly string _legacyRecordId;  // pre-multi-chat record id (hash of _hostKey) - adopted if present
    private string _currentChatId;            // the vault record the active conversation persists to
    private readonly object _stateLock = new();
    private readonly List<AiChatMessage> _history = []; // model turns (always ends with an assistant msg or empty)
    private readonly List<ChatMessage> _transcript = []; // display turns
    private bool _loaded;                                // persisted transcript pulled in yet?
    private bool _busy;
    private int _generation;                             // bumped by Clear() so an in-flight turn skips its commit
    private CancellationTokenSource? _currentCts;        // per-turn, standalone (not linked to the connection)
    // A command typed into the terminal but not executed (suggest mode, or an auto-mode
    // safety flag), with the scrollback offset it was typed at. The WS handler watches from
    // that offset for the user's Enter and then starts a continuation turn automatically.
    private (long Offset, string Command)? _pendingSuggestion;

    public AgentConversation(TerminalSession session)
    {
        _session = session;
        _hostKey = $"{session.Username}@{session.Host}:{session.Port}".ToLowerInvariant();
        // Records written before multi-chat existed used this deterministic per-host id
        // (hashed so the vault filename stays path-safe) - still recognized so old chats
        // survive the upgrade.
        _legacyRecordId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_hostKey)))[..32].ToLowerInvariant();
        _currentChatId = NewChatId();
    }

    private static string NewChatId() => Guid.NewGuid().ToString("N");

    /// <summary>True when this saved record belongs to this host's conversation list.</summary>
    private bool BelongsToHost(string id, AiChatRecord record)
        => record.HostKey == _hostKey || (record.HostKey is null && id == _legacyRecordId);

    /// <summary>
    /// Pulls the MOST RECENT persisted conversation for this host into memory (once) -
    /// older ones stay listable/reopenable via <see cref="ListChats"/>/<see cref="OpenChat"/>.
    /// Model history is rebuilt from the transcript's plain text turns - tool-call plumbing
    /// isn't persisted; the conversational content is what "continue where we left off"
    /// needs. Best-effort: a locked vault just means nothing loads now; not marking
    /// <c>_loaded</c> lets a later call (post-unlock reconnect) retry.
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
    /// Switches the active conversation to a saved one. Cancels any in-flight turn the same
    /// way Clear does (generation bump - it skips its commit and emits no turn_done). The
    /// outgoing conversation was already persisted after its last turn, so nothing is lost.
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

    /// <summary>
    /// Starts a fresh conversation WITHOUT deleting the current one (that's Clear) - the
    /// outgoing chat stays in the saved list.
    /// </summary>
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
    /// Deletes a saved conversation. Returns true when it was the ACTIVE one - the caller
    /// then treats it like a clear (this also resets in-memory state to a fresh chat).
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
    /// Shallow copy is safe: an assistant message is only added to <c>_transcript</c> AFTER it
    /// stops mutating (in RunTurnAsync's finally), and user messages are immutable once created.
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
    /// Wipes both transcript and model history (in memory AND the persisted record) and
    /// cancels any in-flight turn. Bumping the generation first makes the running turn skip
    /// its commit and emit no turn_done (the empty history frame the caller sends already
    /// reset the client).
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
    /// The typed-but-not-run suggestion from the last turn, if any - read-and-clear, so each
    /// suggestion is watched exactly once.
    /// </summary>
    public bool TryTakePendingSuggestion(out long offset, out string command)
    {
        lock (_stateLock)
        {
            if (_pendingSuggestion is { } pending)
            {
                _pendingSuggestion = null;
                offset = pending.Offset;
                command = pending.Command;
                return true;
            }

            offset = 0;
            command = "";
            return false;
        }
    }

    /// <summary>
    /// <paramref name="isContinuation"/> marks an automatic follow-up turn (the user ran a
    /// suggested command): the synthetic prompt goes to the model but not into the visible
    /// transcript - the user never typed it.
    /// </summary>
    public async Task RunTurnAsync(VaultService vault, string mode, string userText, Func<object, Task> emit, CancellationToken ct, bool isContinuation = false)
    {
        EnsureLoaded(vault);
        var settings = vault.GetSettings();
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

        var stopReason = "end_turn";
        string? error = null;
        try
        {
            // Chat mode sends no tools at all (works with models that lack tool support) and
            // instead inlines the recent terminal output into the system prompt fresh each
            // request - it never enters the committed history.
            var tools = mode switch
            {
                "suggest" => SuggestTools,
                "auto" => AutoTools,
                _ => null,
            };

            var suggestNudged = false;
            var bufferNextRound = false;

            while (true)
            {
                ct.ThrowIfCancellationRequested();

                var request = new List<AiChatMessage>
                {
                    new() { Role = "system", Content = SystemPrompt(mode, settings.AiModel) },
                };
                request.AddRange(localHistory);

                // The nudged round is buffered instead of streamed live, so a bare "DONE"
                // (nothing to type) can be discarded without ever reaching the UI. roundText
                // tracks THIS round's text either way - the tool-call echo below must carry
                // only the current round, or the model sees its accumulated earlier sentences
                // in history and restates them (observed as a doubled final answer).
                var bufferThisRound = bufferNextRound;
                bufferNextRound = false;
                var roundText = new StringBuilder();

                var result = await OpenAiChatClient.StreamAsync(
                    settings.AiBaseUrl, settings.AiModel, request, tools,
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
                    ct);

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

                if (result.ToolCalls.Count == 0)
                {
                    // Small models sometimes narrate the command in chat instead of calling
                    // suggest_command - but the point of suggest mode is the command landing
                    // in the terminal. One deterministic retry: if the answer contains a code
                    // span and nothing was typed yet, tell the model to call the tool (or say
                    // DONE, which the buffering above swallows).
                    if (mode == "suggest" && !suggestNudged
                        && !assistant.Activities.Any(a => a.Tool == "suggest_command")
                        && assistant.Text.Contains('`'))
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

                // Echo the assistant's tool-call turn, execute each call, and append the
                // matching tool results - the OpenAI dialect requires one role:"tool" message
                // per tool_call id, directly after the assistant message that made the calls.
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
                    var (summary, output) = await ExecuteToolAsync(settings, mode, call.Function.Name, input, ct);
                    assistant.Activities.Add(new ChatActivity { Tool = call.Function.Name, Summary = summary });
                    await emit(new { type = "tool_activity", id = assistantId, tool = call.Function.Name, summary });
                    localHistory.Add(new AiChatMessage { Role = "tool", ToolCallId = call.Id, Content = output });
                }
            }

            // Small local models sometimes stop right after their tool calls without ever
            // answering in chat. Guarantee an answer: one final no-tools request that forces
            // a summary. The nudge message is request-local - never committed to history.
            if (string.IsNullOrWhiteSpace(assistant.Text) && assistant.Activities.Count > 0)
            {
                var followUp = new List<AiChatMessage>
                {
                    new() { Role = "system", Content = SystemPrompt(mode, settings.AiModel) },
                };
                followUp.AddRange(localHistory);
                followUp.Add(new AiChatMessage
                {
                    Role = "user",
                    Content = "Based on the tool results above, tell me in one or two sentences what happened and answer my original question. Do not call any tools.",
                });

                await OpenAiChatClient.StreamAsync(
                    settings.AiBaseUrl, settings.AiModel, followUp, tools: null,
                    async text =>
                    {
                        assistant.Text += text;
                        await emit(new { type = "text_delta", id = assistantId, text });
                    },
                    ct);
            }
        }
        catch (OperationCanceledException)
        {
            stopReason = "stopped";
        }
        catch (HttpRequestException)
        {
            stopReason = "error";
            error = $"Can't reach the local AI server at {settings.AiBaseUrl}. Is Ollama running? Start it (or install it from ollama.com), or fix the address in Settings.";
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
                        // localHistory yet (only tool-call turns are appended mid-loop), and
                        // nudge plumbing is request-only - stripped so it never persists.
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
                    _transcript.Add(assistant); // show the (possibly partial) answer
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
        AppSettings settings, string mode, string name, IReadOnlyDictionary<string, JsonElement> input, CancellationToken ct)
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

                var typedAt = _session.Scrollback.TotalWritten;
                _session.WriteToShell(command);
                lock (_stateLock)
                {
                    _pendingSuggestion = (typedAt, command);
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
                    // Critical guard, not just tidiness: running now would send Enter onto
                    // the prompt line where the pending suggestion sits - executing the
                    // suggestion concatenated with this command.
                    return ("blocked run_command (suggestion pending)", PendingBlockMessage);
                }

                var command = SanitizeCommand(GetString(input, "command") ?? "", out var runSanitizeError);
                if (command is null)
                {
                    return ("rejected command (not a single command)", $"Error: {runSanitizeError}");
                }

                var (safe, reason) = await VerifyActionSafeAsync(settings, command, ct);
                if (!safe)
                {
                    var typed = OneLine(command, int.MaxValue);
                    var flaggedAt = _session.Scrollback.TotalWritten;
                    _session.WriteToShell(typed);
                    lock (_stateLock)
                    {
                        _pendingSuggestion = (flaggedAt, typed);
                    }

                    return ($"suggested (safety check): {OneLine(typed, 80)}",
                        $"The safety check declined to run this automatically ({reason}). The command was typed into "
                        + "the terminal instead - the user can press Enter to run it or discard it. Tell the user what "
                        + "you suggested and why it was flagged, then answer their question; if they run it you will "
                        + "automatically be asked to continue.");
                }

                var before = _session.Scrollback.TotalWritten;
                _session.WriteToShell(command + "\r");
                await ReadUntilIdleAsync(ct);
                var output = AnsiText.Strip(_session.Scrollback.SnapshotSince(before));
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
                // Hard guard against the observed misuse: small models reach for the raw
                // keystroke tool to send whole shell commands, which then just sit unexecuted
                // (no Enter) while the model wonders why nothing happened. Anything that
                // looks like a command gets redirected to run_command, which does press Enter.
                if (keys.Contains(' ') || keys.Length > 8)
                {
                    return ("blocked press_keys (looks like a command)",
                        "Error: press_keys is ONLY for short interactive keystrokes (like y, n, q, a number, or space "
                        + "for a pager). That input looks like a shell command - call run_command with it instead; "
                        + "run_command presses Enter and returns the output.");
                }

                var (safe, reason) = await VerifyActionSafeAsync(settings, keys, ct);
                if (!safe)
                {
                    var flaggedAt = _session.Scrollback.TotalWritten;
                    _session.WriteToShell(keys);
                    lock (_stateLock)
                    {
                        _pendingSuggestion = (flaggedAt, keys);
                    }

                    return ($"suggested keystrokes (safety check): {OneLine(keys, 80)}",
                        $"The safety check declined to send this automatically ({reason}). It was typed without a "
                        + "newline for the user to confirm. Tell the user, then answer their question.");
                }

                var before = _session.Scrollback.TotalWritten;
                _session.WriteToShell(keys); // no newline appended - for prompts / pagers
                await Task.Delay(400, ct);
                var output = AnsiText.Strip(_session.Scrollback.SnapshotSince(before));
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
                var output = AnsiText.Strip(_session.Scrollback.SnapshotSince(before));
                return ($"waited {seconds}s", output);
            }

            default:
                return ($"unknown tool: {name}", $"Error: unknown tool '{name}'.");
        }
    }

    /// <summary>
    /// The "auto" mode gate: a second model call (same local model) judges whether the input
    /// may be sent to the shell without user confirmation. It sees the recent terminal tail so
    /// context-dependent keystrokes (like answering a visible prompt) can be judged sensibly.
    /// Fails CLOSED: any error, or an answer that doesn't clearly start with SAFE, means unsafe.
    /// </summary>
    private async Task<(bool Safe, string Reason)> VerifyActionSafeAsync(AppSettings settings, string action, CancellationToken ct)
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
                settings.AiBaseUrl, settings.AiModel, messages, tools: null,
                text =>
                {
                    verdict.Append(text);
                    return Task.CompletedTask;
                },
                ct);

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
    /// Tolerant verdict parse: models wrap the requested one-word verdict in markdown or
    /// preamble ("**SAFE**", "Verdict: SAFE"), and a strict prefix match fail-closed every
    /// one of those to unsafe (observed with gemma flagging a plain uname). The first
    /// decisive word wins; "not safe" phrasing counts as unsafe; no decisive word at all
    /// stays fail-closed.
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
    /// Best-effort "command finished" signal against a raw PTY with no exit-code channel: poll the
    /// byte counter every 250ms, stop once it has been quiet for ~750ms, hard-capped at ~15s (and
    /// honoring <paramref name="ct"/>). Long-running/interactive commands return partial output;
    /// the model can call read_terminal / wait again.
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
    /// Cleans a model-proposed command into something that can actually be typed at a shell
    /// prompt, or rejects it with a corrective error for the model. Small models paste
    /// markdown fences, "$ " prompt artifacts, # comments, and whole multi-line scripts -
    /// flattening those onto one PTY line is exactly the "comments leaking into the
    /// terminal" garbage this guards against. Salvages the common single-command-plus-
    /// comment shape; rejects anything with more than one runnable line.
    /// </summary>
    private static string? SanitizeCommand(string raw, out string error)
    {
        error = "";
        var text = raw.Trim();

        // Wrapping markdown fence (``` or ```sh ... ```).
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

        var runnable = new List<string>();
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue; // empty or comment (a root-prompt "# cmd" paste isn't typeable either)
            }

            if (line.StartsWith("$ ", StringComparison.Ordinal))
            {
                line = line[2..].Trim(); // pasted prompt artifact
                if (line.Length == 0)
                {
                    continue;
                }
            }

            runnable.Add(line);
        }

        if (runnable.Count == 0)
        {
            error = "That contained no runnable command (only comments or empty lines). Send exactly one single-line shell command.";
            return null;
        }

        if (runnable.Count > 1)
        {
            error = "That was a multi-line script. Send exactly ONE single-line command per call (chain with && or ; if you must), then wait for its result before the next one.";
            return null;
        }

        return runnable[0];
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

        // Small local models tend to act and then go silent - every mode hammers on "always
        // answer in chat" (and RunTurnAsync additionally forces a summary if a turn ends with
        // tool activity but no text).
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
                    Whenever the user wants something done or wants a command, you MUST call suggest_command with the exact command - never only write a command in your chat text, because the user expects it typed into the terminal ready to run. Suggest ONE command at a time and explain in chat what it does and why. When the user runs your suggestion, you are automatically asked to continue: read the result, report it, and suggest the next single command - until the task is complete, then say so clearly and stop suggesting. {answerRule}
                    """;

            case "auto":
                return
                    $"""
                    {header}
                    You can read the recent terminal output (read_terminal), run commands (run_command - it types the command, presses Enter, and returns the output), press a few raw keys for interactive prompts and pagers (press_keys - y/n/q/space only, never a command), and pause for output to settle (wait). Everything you send appears in the user's real terminal, which they are watching live.
                    To run ANY shell command, USE run_command and nothing else - do not ask permission and do not merely describe it. A safety check runs automatically on everything you send: safe, read-only actions execute immediately; anything potentially destructive is only TYPED into the terminal as a suggestion the user must confirm with Enter - when that happens, say so in chat and wait for the user instead of retrying.
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

    // OpenAI-dialect function definitions. Chat mode sends none (works with models whose
    // Ollama template lacks tool support); suggest gets read/wait/suggest; auto adds
    // execution (safety-gated in ExecuteToolAsync).
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
                    command = new { type = "string", description = "The shell command to propose. Single line; no trailing newline." },
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
                    command = new { type = "string", description = "The shell command to run. No trailing newline needed." },
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

    // No suggest_command in auto mode on purpose: run_command's safety gate already turns
    // unsafe commands into typed suggestions, and offering the suggest tool too makes small
    // models take the timid path for everything (observed with gemma: it suggested even a
    // plain uname instead of running it).
    private static readonly object AutoTools = new[] { ReadTerminalTool, WaitTool, RunCommandTool, PressKeysTool };
}
