import { useCallback, useEffect, useRef, useState } from 'react'
import {
  agentSocketUrl,
  getAiStatus,
  type AgentClientMessage,
  type AgentMode,
  type AgentServerEvent,
  type AiStatus,
  type ChatMessage,
  type ChatSummary,
} from '../lib/api'
import { AiAgentIcon } from './icons'
import { onAiSettingsChanged } from '../lib/aiSettingsEvents'

const inputClasses =
  'w-full resize-none rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-slate-400 focus:outline-none'

// A transcript message plus the ephemeral reasoning stream - populated from live
// reasoning_delta frames only; the server never persists or replays them.
type UiMessage = ChatMessage & {
  reasoning?: string
  reasoningStart?: number
  reasoningEnd?: number
}

// The optional AI-agent bottom region of an SSH terminal tab, rendered only when an AI
// endpoint is actually configured; nothing shows for a feature that can't run.
export function AgentBar({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<AgentMode>('chat')
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
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
  // Whether the transcript is scrolled near the bottom. Deltas only auto-scroll when true.
  const atBottomRef = useRef(true)
  const panelRef = useRef<HTMLDivElement>(null)
  // null = the default size (45vh capped at 420px); a number once the user drag-resizes.
  const [panelHeight, setPanelHeight] = useState<number | null>(null)

  // Refresh the server/model readout on mount and whenever the bar is (re-)expanded,
  // so a change saved in Settings shows without a reload. Best-effort.
  useEffect(() => {
    let cancelled = false
    const refresh = () =>
      getAiStatus()
        .then((s) => {
          if (!cancelled) {
            setAiStatus(s)
            setSelectedModel((current) => (s.models.includes(current) ? current : (s.models[0] ?? '')))
          }
        })
        .catch(() => {
          if (!cancelled) setAiStatus(null)
        })

    void refresh()
    // Saving an endpoint in Settings has to make the bar appear here and then - with no bar
    // there is nothing to expand, so the `expanded` dependency alone would never fire again.
    const unsubscribe = onAiSettingsChanged(() => void refresh())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [expanded])

  // Reducer for server -> client frames. Functional updates only so it stays stable (empty
  // dep array); ignores frames whose id isn't a known assistant bubble.
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

  // Opens a socket the first time the bar is expanded; stays open across tab switches so
  // agent turns keep streaming in the background.
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
      setRunning(false)
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

  // Follow new content only when the user is already at the bottom, so scrolling up to
  // read isn't yanked back down on every delta.
  useEffect(() => {
    const el = transcriptRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Recompute the sticky flag from the user's own scrolling; the 24px threshold absorbs
  // sub-pixel rounding. Programmatic growth doesn't fire scroll.
  function handleTranscriptScroll() {
    const el = transcriptRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  function send() {
    const text = input.trim()
    const socket = socketRef.current
    // Sending while a turn runs is allowed - the backend queues messages and processes
    // them in order (a queued message also interrupts waiting-for-Enter on a suggestion).
    if (!text || !selectedModel || !socket || socket.readyState !== WebSocket.OPEN) return
    // Sending while the saved-chats list is open starts a fresh conversation (the backend
    // folds the new-chat into this send so no empty history frame wipes the optimistic bubble).
    const startNewChat = chatsOpen
    if (startNewChat) setChatsOpen(false)
    // Render the user bubble optimistically; history only arrives on connect/clear, so no double-render.
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text, mode, activities: [] }
    // Sending is a deliberate "bring me to the latest" action - re-pin to the bottom.
    atBottomRef.current = true
    // A new-chat send replaces the transcript; a normal send appends.
    setMessages((prev) => (startNewChat ? [userMessage] : [...prev, userMessage]))
    setNotice(null)
    const frame: AgentClientMessage = { type: 'send', mode, model: selectedModel, text, newChat: startNewChat }
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
    // Local clear keeps the UI instant; the server emits no turn_done for the turn it cancels.
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

  // Drag the panel's top edge to resize; pointer capture keeps the drag alive outside the
  // handle and the height is clamped so neither panel nor terminal is squeezed away.
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

  const ready = aiStatus?.reachable === true && selectedModel.length > 0
  const dotColor = aiStatus == null ? 'bg-slate-500' : ready ? 'bg-emerald-500' : 'bg-amber-500'
  const modelOptions = aiStatus?.models ?? []
  const sendDisabled = !input.trim() || !socketReady || !selectedModel

  // Shared between the collapsed strip and the expanded header row, so the expanded panel
  // needs no separate strip row.
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
            ? `AI ready (${selectedModel})`
            : aiStatus.reachable
              ? 'AI server returned no models'
              : 'AI server not reachable'
      }
    />
  )

  // Unknown (probe not answered) and unconfigured both render nothing. `configured` absent
  // on an older backend is treated as configured so version skew can't hide the bar.
  if (aiStatus == null || aiStatus.configured === false) {
    return null
  }

  return (
    <div className="shrink-0 border-t border-slate-800 bg-slate-900 text-slate-200">
      {/* Collapsed strip; hidden while expanded, when the toggle + dot move into the header row. */}
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
          <div
            role="separator"
            aria-label="Resize AI agent panel"
            onPointerDown={startResize}
            className="group flex h-2 w-full shrink-0 cursor-ns-resize touch-none items-center justify-center"
          >
            <div className="h-0.5 w-10 rounded bg-slate-700 group-hover:bg-slate-500" />
          </div>
          {/* Header row carries the toggle + status dot; flex-wrap keeps it usable at phone width. */}
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
                value={selectedModel}
                disabled={running}
                onChange={(e) => setSelectedModel(e.target.value)}
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
                <>The AI server returned no models. Add one on the server, then reopen this panel.</>
              ) : aiStatus.unauthorized ? (
                <>
                  <code className="text-amber-200">{aiStatus.baseUrl}</code> rejected the request -{' '}
                  {aiStatus.hasApiKey ? 'the stored API key was refused' : 'this endpoint needs an API key'}. Set
                  it in Settings under "AI agent".
                </>
              ) : (
                <>
                  Can't reach the AI server at <code className="text-amber-200">{aiStatus.baseUrl}</code>. Start
                  Ollama, or fix the address in Settings under "AI agent".
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

          {/* select-text + data-selectable-text opt this surface back into text selection
              (app-wide default is user-select: none, issue #61) so answers can be copied. */}
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

// The collapsible "thinking" disclosure above a reasoning model's answer. A 1s tick keeps
// the elapsed counter live until it answers, then the counter freezes.
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
