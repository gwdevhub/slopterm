import { useCallback, useEffect, useRef, useState } from 'react'
import {
  agentSocketUrl,
  getAiStatus,
  setAiSettings,
  type AgentClientMessage,
  type AgentMode,
  type AgentServerEvent,
  type AiStatus,
  type ChatMessage,
  type ChatSummary,
} from '../lib/api'
import { AiAgentIcon } from './icons'

const inputClasses =
  'w-full resize-none rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-400 focus:outline-none'

// A transcript message plus the ephemeral, display-only reasoning stream. These extra fields
// are populated purely from live reasoning_delta frames - the server never persists or replays
// them (a reasoning model's chain-of-thought is transient), so they're absent after a history
// reload, which is exactly what we want. `reasoningStart`/`End` (ms epochs) drive the elapsed
// "Thinking… Ns" / "Thought for Ns" label.
type UiMessage = ChatMessage & {
  reasoning?: string
  reasoningStart?: number
  reasoningEnd?: number
}

// The optional AI-agent bottom region of an SSH terminal tab. It is ALWAYS present (as a
// fixed-height collapsed strip) so wrapping TerminalView in a flex column never induces an
// extra xterm fit()/redraw during first paint - only expanding it (a user action, well
// after the terminal-resize measurement window) grows the bar and re-fits the terminal via
// its existing ResizeObserver. See the pinned agent WS contract for the wire protocol.
export function AgentBar({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<AgentMode>('chat')
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [socketReady, setSocketReady] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [chatsOpen, setChatsOpen] = useState(false)

  // Held in a ref so send/stop/clear reach the live socket without re-subscribing the WS
  // effect on every render.
  const socketRef = useRef<WebSocket | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // Whether the transcript is currently scrolled to (near) the bottom. Drives sticky-follow:
  // streaming deltas only auto-scroll when the user hasn't scrolled up to read back. Starts
  // true so a fresh, empty transcript follows the first turn.
  const atBottomRef = useRef(true)
  const panelRef = useRef<HTMLDivElement>(null)
  // null = the default size (45vh capped at 420px); a number once the user drag-resizes.
  const [panelHeight, setPanelHeight] = useState<number | null>(null)

  // Refresh the server/model readout on mount and whenever the bar is (re-)expanded, so a
  // change saved in Settings (or a freshly pulled model) is reflected without a reload.
  // Best-effort - a missing/erroring endpoint just leaves the status dot neutral, never
  // throws. Only the dot's color changes, never the collapsed strip's height.
  useEffect(() => {
    let cancelled = false
    getAiStatus()
      .then((s) => {
        if (!cancelled) setAiStatus(s)
      })
      .catch(() => {
        if (!cancelled) setAiStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [expanded])

  // Reducer for server -> client frames. Uses only functional state updates so it never
  // captures stale `messages`, which lets it stay stable (empty dep array) and be referenced
  // from the WS effect without re-running it. MUST ignore frames whose id is not a currently
  // known assistant bubble (contract requirement - makes a late frame from a turn cancelled
  // by `clear` a harmless no-op).
  const reduce = useCallback((evt: AgentServerEvent) => {
    switch (evt.type) {
      case 'history':
        setMessages(evt.messages)
        // A history frame is also how the server concludes clear/open/new - any turn that
        // was running when it arrived has been cancelled server-side (no turn_done comes).
        setRunning(false)
        break
      case 'chats':
        setChats(evt.chats)
        break
      case 'turn_start':
        setMessages((prev) => [...prev, { id: evt.id, role: 'assistant', text: '', mode: evt.mode, activities: [] }])
        setRunning(true)
        break
      case 'text_delta':
        setMessages((prev) =>
          prev.some((m) => m.id === evt.id)
            ? prev.map((m) =>
                m.id === evt.id
                  ? {
                      ...m,
                      text: m.text + evt.text,
                      // First answer text means thinking is over - freeze the elapsed clock.
                      reasoningEnd: m.reasoning && m.reasoningEnd == null ? Date.now() : m.reasoningEnd,
                    }
                  : m,
              )
            : prev,
        )
        break
      case 'reasoning_delta':
        setMessages((prev) =>
          prev.some((m) => m.id === evt.id)
            ? prev.map((m) =>
                m.id === evt.id
                  ? {
                      ...m,
                      reasoning: (m.reasoning ?? '') + evt.text,
                      reasoningStart: m.reasoningStart ?? Date.now(),
                    }
                  : m,
              )
            : prev,
        )
        break
      case 'tool_activity':
        setMessages((prev) =>
          prev.some((m) => m.id === evt.id)
            ? prev.map((m) =>
                m.id === evt.id
                  ? { ...m, activities: [...m.activities, { tool: evt.tool, summary: evt.summary }] }
                  : m,
              )
            : prev,
        )
        break
      case 'turn_done': {
        setRunning(false)
        const errText = evt.stopReason === 'error' && evt.error ? evt.error : null
        setMessages((prev) =>
          prev.some((m) => m.id === evt.id)
            ? prev.map((m) => {
                if (m.id !== evt.id) return m
                return {
                  ...m,
                  // Stop the clock even if the model only ever thought and never answered.
                  reasoningEnd: m.reasoning && m.reasoningEnd == null ? Date.now() : m.reasoningEnd,
                  text: errText ? (m.text ? `${m.text}\n\n${errText}` : errText) : m.text,
                }
              })
            : prev,
        )
        break
      }
      case 'error':
        setNotice(evt.message)
        setRunning(false)
        break
    }
  }, [])

  // Only opens a socket the first time the bar is expanded (guard below); once open it stays
  // open across tab switches (an inactive tab stays mounted, so `expanded` doesn't change) so
  // agent turns keep streaming in the background. Mirrors TerminalView's socket-effect shape.
  useEffect(() => {
    if (!expanded) return
    const socket = new WebSocket(agentSocketUrl(sessionId))
    socketRef.current = socket
    socket.onopen = () => {
      setSocketReady(true)
      setDisconnected(false)
    }
    socket.onmessage = (e) => reduce(JSON.parse(e.data) as AgentServerEvent)
    socket.onerror = () => setSocketReady(false) // the browser fires close right after
    socket.onclose = () => {
      setSocketReady(false)
      setRunning(false) // no more turn frames are coming
      if (socketRef.current === socket) {
        socketRef.current = null
        setDisconnected(true)
      }
    }
    return () => {
      // Null out onclose so an unmount/collapse-initiated close does NOT flip `disconnected`.
      socket.onclose = null
      socket.close()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [sessionId, expanded, reconnectNonce, reduce])

  // Follow new content only when the user is already at the bottom - if they've scrolled up
  // (e.g. to read an expanded "thinking" block while it streams), leave their position alone
  // instead of yanking them back down on every delta.
  useEffect(() => {
    const el = transcriptRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Recompute the sticky flag from the user's own scrolling. A small threshold absorbs
  // sub-pixel rounding and lets "basically at the bottom" still count as pinned. Programmatic
  // content growth doesn't fire scroll, so this only ever reflects deliberate user scrolling.
  function handleTranscriptScroll() {
    const el = transcriptRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  function send() {
    const text = input.trim()
    const socket = socketRef.current
    // Sending while a turn runs is allowed - the backend queues messages and processes
    // them in order (a queued message also interrupts waiting-for-Enter on a suggestion).
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return
    // Sending while the saved-chats list is open starts a fresh conversation for this message -
    // the same as pressing "New chat" first. Otherwise it would append to the current chat behind
    // the hidden transcript and look like it just vanished. The backend folds the new-chat into
    // this send (see the send frame's newChat flag) precisely so no empty history frame arrives
    // to wipe the optimistic bubble below; we just close the list and reset the transcript here.
    const startNewChat = chatsOpen
    if (startNewChat) setChatsOpen(false)
    // Render the user bubble optimistically - the server records it and returns it in later
    // history snapshots, which only arrive on connect/clear, so this never double-renders.
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, mode, activities: [] }
    // Sending is a deliberate "bring me to the latest" action - re-pin to the bottom so the
    // reply follows, even if the user had scrolled up while reading earlier output.
    atBottomRef.current = true
    // A new-chat send replaces the superseded transcript with just this message; a normal send
    // appends to what's already shown.
    setMessages((prev) => (startNewChat ? [userMessage] : [...prev, userMessage]))
    setNotice(null)
    const frame: AgentClientMessage = { type: 'send', mode, text, newChat: startNewChat }
    socket.send(JSON.stringify(frame))
    setInput('')
  }

  function stop() {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return
    const frame: AgentClientMessage = { type: 'stop' }
    socket.send(JSON.stringify(frame))
  }

  function clear() {
    // Local clear keeps the UI instant; the server confirms with an empty history frame.
    // setRunning(false) matches the fact that the server emits NO turn_done for the turn it
    // cancels on clear.
    setMessages([])
    setRunning(false)
    setNotice(null)
    sendFrame({ type: 'clear' })
  }

  function sendFrame(frame: AgentClientMessage) {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(frame))
  }

  function toggleChats() {
    setChatsOpen((open) => {
      if (!open) sendFrame({ type: 'list_chats' })
      return !open
    })
  }

  function openChat(id: string) {
    setNotice(null)
    sendFrame({ type: 'open_chat', id })
    setChatsOpen(false)
  }

  function newChat() {
    // Unlike Clear chat, the outgoing conversation stays in the saved list.
    setMessages([])
    setRunning(false)
    setNotice(null)
    sendFrame({ type: 'new_chat' })
    setChatsOpen(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // Drag the handle at the panel's top edge to resize it: pointer capture keeps the drag
  // alive outside the handle, and the height is clamped so neither the panel nor the
  // terminal above it can be squeezed away. The terminal refits itself via its existing
  // debounced ResizeObserver as the flex column reflows - no extra wiring needed.
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startHeight = panelRef.current?.getBoundingClientRect().height ?? 0
    const onMove = (ev: PointerEvent) => {
      // Dragging up (clientY shrinks) grows the panel.
      const proposed = Math.round(startHeight + (startY - ev.clientY))
      const max = Math.round(window.innerHeight * 0.8)
      setPanelHeight(Math.min(Math.max(proposed, 160), max))
    }
    const stop = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  // Persists the pick via the same settings endpoint the Settings page uses; the backend
  // re-reads settings per turn, so the next send uses the new model with no reconnect.
  // The refresh afterwards re-syncs the picker (and dot/banner) with what actually saved,
  // which also handles a failed save by snapping the select back.
  async function switchModel(model: string) {
    if (!aiStatus) return
    setSwitchingModel(true)
    try {
      await setAiSettings({ baseUrl: aiStatus.baseUrl, model })
    } catch {
      // fall through - the refresh below re-syncs the picker with reality
    }
    try {
      setAiStatus(await getAiStatus())
    } catch {
      setAiStatus(null)
    }
    setSwitchingModel(false)
  }

  const ready = aiStatus?.reachable === true && aiStatus.modelAvailable
  const dotColor = aiStatus == null ? 'bg-slate-500' : ready ? 'bg-emerald-500' : 'bg-amber-500'
  // Everything the server has pulled, plus the configured model if it isn't among them
  // (e.g. not pulled yet) so the select always shows the real current setting.
  const modelOptions =
    aiStatus == null ? [] : aiStatus.models.includes(aiStatus.model) ? aiStatus.models : [aiStatus.model, ...aiStatus.models]
  const sendDisabled = !input.trim() || !socketReady

  // Shared between the collapsed strip and the expanded header row - the toggle and the
  // status dot live in whichever of the two is currently rendered, so the expanded panel
  // needs no separate strip row (one line of chrome instead of two).
  const toggleButton = (
    <button
      type="button"
      aria-label="AI agent"
      onClick={() => setExpanded((v) => !v)}
      className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${
        expanded ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-slate-300 hover:bg-slate-800'
      }`}
    >
      <AiAgentIcon className="h-4 w-4" />
      AI agent
    </button>
  )
  const statusDot = (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`}
      aria-hidden="true"
      title={
        aiStatus == null
          ? 'Checking AI server…'
          : ready
            ? `AI ready (${aiStatus.model})`
            : aiStatus.reachable
              ? `Model "${aiStatus.model}" not pulled`
              : 'AI server not reachable'
      }
    />
  )

  return (
    <div className="shrink-0 border-t border-slate-800 bg-slate-900 text-slate-200">
      {/* Collapsed strip - fixed height, no transition, and rendered at first paint (the
          bar starts collapsed). While expanded it disappears entirely: the toggle + dot
          move into the panel's header row instead. */}
      {!expanded && (
        <div className="flex h-9 shrink-0 items-center gap-2 px-2">
          {toggleButton}
          {statusDot}
          {running && <span className="text-xs text-slate-500">Working…</span>}
        </div>
      )}

      {expanded && (
        <div
          ref={panelRef}
          className={`flex min-h-0 w-full flex-col border-t border-slate-800 ${panelHeight == null ? 'h-[45vh] max-h-[420px]' : ''}`}
          style={panelHeight == null ? undefined : { height: panelHeight }}
        >
          {/* Drag-to-resize handle on the panel's top edge. */}
          <div
            role="separator"
            aria-label="Resize AI agent panel"
            onPointerDown={startResize}
            className="group flex h-2 w-full shrink-0 cursor-ns-resize touch-none items-center justify-center"
          >
            <div className="h-0.5 w-10 rounded bg-slate-700 group-hover:bg-slate-500" />
          </div>
          {/* Header row - carries the toggle + status dot too (flex-wrap keeps it usable
              at phone width, where everything won't fit on one line). */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 py-1.5">
            {toggleButton}
            {statusDot}
            <div className="flex overflow-hidden rounded border border-slate-700">
              {(['chat', 'suggest', 'auto'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  title={
                    m === 'chat'
                      ? 'Answers only - never touches the shell'
                      : m === 'suggest'
                        ? 'Types commands for you to confirm with Enter'
                        : 'Runs safety-checked commands; unsafe ones become suggestions'
                  }
                  className={`px-3 py-1 text-xs font-medium capitalize ${
                    mode === m ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            {modelOptions.length > 0 && (
              <select
                aria-label="AI model"
                value={aiStatus?.model}
                disabled={running || switchingModel}
                onChange={(e) => void switchModel(e.target.value)}
                className="min-w-0 max-w-[45%] rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-300 focus:border-slate-400 focus:outline-none disabled:opacity-50"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={toggleChats}
                className={`rounded px-2 py-1 text-xs ${
                  chatsOpen ? 'bg-slate-800 text-slate-200' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                Chats
              </button>
              <button
                type="button"
                onClick={newChat}
                className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                New chat
              </button>
              <button
                type="button"
                onClick={clear}
                className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                Clear chat
              </button>
            </div>
          </div>

          {aiStatus && !ready && (
            <div className="mx-2 mb-1 shrink-0 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              {aiStatus.reachable ? (
                <>
                  Model "{aiStatus.model}" isn't available on the AI server - pull it with{' '}
                  <code className="text-amber-200">ollama pull {aiStatus.model}</code> or pick another model in
                  Settings under "AI agent".
                </>
              ) : (
                <>
                  Can't reach the local AI server at <code className="text-amber-200">{aiStatus.baseUrl}</code>.
                  Start Ollama (or fix the address in Settings under "AI agent").
                </>
              )}
            </div>
          )}

          {disconnected && (
            <div className="mx-2 mb-1 flex shrink-0 items-center justify-between gap-2 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              <span>Disconnected</span>
              <button
                type="button"
                onClick={() => {
                  setDisconnected(false)
                  setReconnectNonce((n) => n + 1)
                }}
                className="rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700"
              >
                Reconnect
              </button>
            </div>
          )}

          {/* Saved conversations for this host - shown in place of the transcript. */}
          {chatsOpen && (
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
              {chats == null ? (
                <p className="m-auto text-xs text-slate-500">Loading chats…</p>
              ) : chats.length === 0 ? (
                <p className="m-auto max-w-xs text-center text-xs text-slate-500">
                  No saved chats for this host yet - they appear here after the first exchange.
                </p>
              ) : (
                chats.map((c) => (
                  <div
                    key={c.id}
                    className={`flex items-center gap-2 rounded border px-2 py-1.5 ${
                      c.active ? 'border-indigo-700 bg-slate-800/70' : 'border-slate-800 hover:bg-slate-800/50'
                    }`}
                  >
                    <button type="button" onClick={() => openChat(c.id)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm text-slate-200">{c.title}</span>
                      <span className="block text-[11px] text-slate-500">
                        {new Date(c.updatedAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {' · '}
                        {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
                        {c.active ? ' · current' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete chat: ${c.title}`}
                      onClick={() => sendFrame({ type: 'delete_chat', id: c.id })}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-700 hover:text-slate-200"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Transcript. select-text + data-selectable-text opt this read-only surface back
              into browser text selection (the app-wide default is user-select: none, issue
              #61) and into the native context menu, so answers can be selected and copied. */}
          <div
            ref={transcriptRef}
            data-selectable-text
            onScroll={handleTranscriptScroll}
            className={`min-h-0 flex-1 select-text flex-col gap-2 overflow-y-auto px-2 py-2 ${chatsOpen ? 'hidden' : 'flex'}`}
          >
            {messages.length === 0 ? (
              <p className="m-auto max-w-xs text-center text-xs text-slate-500">
                {mode === 'auto'
                  ? 'Give the agent a goal - safe commands run automatically, anything risky is only typed for you to confirm with Enter.'
                  : mode === 'suggest'
                    ? 'Ask for help - the agent types suggested commands into the terminal, and you press Enter to run them.'
                    : 'Ask about what’s happening in this SSH session. Chat mode reads the terminal but never types into it.'}
              </p>
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
          </div>

          {notice && <p className="mx-2 mb-1 shrink-0 text-xs text-red-400">{notice}</p>}

          {/* Input row */}
          <div className="flex shrink-0 items-end gap-2 border-t border-slate-800 p-2">
            <textarea
              className={inputClasses}
              rows={2}
              value={input}
              placeholder={mode === 'auto' ? 'Describe a goal…' : mode === 'suggest' ? 'Ask for a command…' : 'Ask a question…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                onClick={send}
                disabled={sendDisabled}
                className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Send
              </button>
              {running && (
                <button
                  type="button"
                  onClick={stop}
                  className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message }: { message: UiMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded px-3 py-2 text-sm ${
          isUser ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-100'
        }`}
      >
        {!isUser && (
          <span className="mb-1 inline-block rounded bg-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
            {message.mode}
          </span>
        )}
        {!isUser && message.reasoning && <ThinkingBlock message={message} />}
        {message.text && <div>{message.text}</div>}
        {message.activities.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            {message.activities.map((a, i) => (
              <span
                key={i}
                className="flex items-center gap-1 rounded bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-400"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" aria-hidden="true" />
                {a.summary}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// The collapsible "thinking" disclosure shown above a reasoning model's answer. Collapsed by
// default (the chain-of-thought is noise for most reads, signal when debugging a small model).
// While the model is still thinking (no reasoningEnd yet) a 1s tick keeps the elapsed counter
// live; once it answers the counter freezes at the final duration.
function ThinkingBlock({ message }: { message: UiMessage }) {
  const thinking = message.reasoningEnd == null
  const [, tick] = useState(0)
  useEffect(() => {
    if (!thinking) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [thinking])

  const start = message.reasoningStart ?? 0
  const end = message.reasoningEnd ?? Date.now()
  const secs = start > 0 ? Math.max(0, Math.round((end - start) / 1000)) : 0
  const label = thinking ? `Thinking… ${secs}s` : `Thought for ${secs}s`

  return (
    <details className="group mb-1 rounded bg-slate-900/60">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1 px-2 py-1 text-[11px] text-slate-400 marker:content-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className={thinking ? 'animate-pulse' : ''}>{label}</span>
      </summary>
      <div className="whitespace-pre-wrap break-words px-2 pb-2 text-[11px] leading-relaxed text-slate-500">
        {message.reasoning}
      </div>
    </details>
  )
}
