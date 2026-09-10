import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent, ReactElement, SVGProps } from 'react'
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, MoreHorizontalIcon, SnippetsIcon } from './icons'
import { listSnippets, type SavedSnippet } from '../lib/api'
import { finishAndroidComposing, hideAndroidKeyboard } from '../lib/androidBridge'

// One tappable key: the label the user reads, and the exact bytes it puts on the wire.
interface KeyDef {
  label: string
  send: string
  // Accessible name, for when the visible label is a keycap abbreviation ("PgUp") or a
  // glyph ("^C").
  name?: string
  // Takes two columns of the panel's grid, for a label one column can't hold.
  wide?: boolean
}

// The rows the "More keys" button reveals: modifiers/navigation first, then Ctrl-combos,
// buried punctuation, and function keys. Labels abbreviate the physical keycaps.
const EXTRA_ROWS: KeyDef[][] = [
  [
    { label: 'Shift+Tab', send: '\x1b[Z', wide: true },
    { label: 'Ins', send: '\x1b[2~', name: 'Insert' },
    { label: 'Del', send: '\x1b[3~', name: 'Delete' },
    { label: 'Home', send: '\x1b[H' },
    { label: 'End', send: '\x1b[F' },
    { label: 'PgUp', send: '\x1b[5~', name: 'Page Up' },
    { label: 'PgDn', send: '\x1b[6~', name: 'Page Down' },
  ],
  // The C0 control codes, as one tap each - arming Ctrl (in the row above) and then typing the
  // letter needs the on-screen keyboard open, which these don't.
  [
    { label: '^C', send: '\x03', name: 'Ctrl+C' },
    { label: '^D', send: '\x04', name: 'Ctrl+D' },
    { label: '^Z', send: '\x1a', name: 'Ctrl+Z' },
    { label: '^L', send: '\x0c', name: 'Ctrl+L' },
    { label: '^R', send: '\x12', name: 'Ctrl+R' },
    { label: '^A', send: '\x01', name: 'Ctrl+A' },
    { label: '^E', send: '\x05', name: 'Ctrl+E' },
    { label: '^K', send: '\x0b', name: 'Ctrl+K' },
    { label: '^W', send: '\x17', name: 'Ctrl+W' },
  ],
  // Weighted towards full-screen editor keys (nano: ^O/^X/^G/^U) plus readline keys. ^S/^Q
  // are absent: they freeze the session under flow control, looking like a crash.
  [
    { label: '^O', send: '\x0f', name: 'Ctrl+O' },
    { label: '^X', send: '\x18', name: 'Ctrl+X' },
    { label: '^G', send: '\x07', name: 'Ctrl+G' },
    { label: '^U', send: '\x15', name: 'Ctrl+U' },
    { label: '^Y', send: '\x19', name: 'Ctrl+Y' },
    { label: '^N', send: '\x0e', name: 'Ctrl+N' },
    { label: '^P', send: '\x10', name: 'Ctrl+P' },
    { label: '^F', send: '\x06', name: 'Ctrl+F' },
    { label: '^B', send: '\x02', name: 'Ctrl+B' },
  ],
  [
    { label: '|', send: '|', name: 'Pipe' },
    { label: '~', send: '~', name: 'Tilde' },
    { label: '/', send: '/', name: 'Slash' },
    { label: '\\', send: '\\', name: 'Backslash' },
    { label: '-', send: '-', name: 'Hyphen' },
    { label: '_', send: '_', name: 'Underscore' },
    { label: '$', send: '$', name: 'Dollar' },
    { label: '*', send: '*', name: 'Asterisk' },
    { label: '&', send: '&', name: 'Ampersand' },
  ],
  [
    { label: 'F1', send: '\x1bOP' },
    { label: 'F2', send: '\x1bOQ' },
    { label: 'F3', send: '\x1bOR' },
    { label: 'F4', send: '\x1bOS' },
    { label: 'F5', send: '\x1b[15~' },
    { label: 'F6', send: '\x1b[17~' },
    { label: 'F7', send: '\x1b[18~' },
    { label: 'F8', send: '\x1b[19~' },
    { label: 'F9', send: '\x1b[20~' },
  ],
  [
    { label: 'F10', send: '\x1b[21~' },
    { label: 'F11', send: '\x1b[23~' },
    { label: 'F12', send: '\x1b[24~' },
  ],
]

interface KeyboardToolbarProps {
  ctrlArmed: boolean
  altArmed: boolean
  onToggleCtrl: () => void
  onToggleAlt: () => void
  // Writes raw bytes into the live session (TerminalView owns the socket and the refocus).
  onSendKey: (data: string) => void
  // Inserts text as a paste (bracketed where the remote asked for it) rather than as
  // keystrokes - used for snippets, which can be long and can contain newlines.
  onPasteText: (text: string) => void
}

// Matches a real keyboard's hold-repeat feel: a short pause so a normal tap never
// double-fires, then a useful repeat rate.
const HOLD_REPEAT_DELAY_MS = 450
const HOLD_REPEAT_INTERVAL_MS = 60

// Fires on pointerdown, not click, and preventDefault keeps focus off xterm's hidden
// textarea - Android otherwise tears down and rebuilds the input connection per tap.
// finishAndroidComposing() is awaited first so an in-flight composition commits before the
// key's bytes go out. `repeat` auto-repeats keys a real keyboard would; toggles leave it off.
function usePressProps(action: () => void, repeat = false) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopRepeat() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  // In case the button (e.g. a panel toggling closed) unmounts while still held.
  useEffect(() => stopRepeat, [])

  return {
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault()
      void finishAndroidComposing().then(() => {
        action()
        if (!repeat) return
        timeoutRef.current = setTimeout(() => {
          intervalRef.current = setInterval(action, HOLD_REPEAT_INTERVAL_MS)
        }, HOLD_REPEAT_DELAY_MS)
      })
    },
    onPointerUp: stopRepeat,
    onPointerLeave: stopRepeat,
    onPointerCancel: stopRepeat,
    // Some engines still synthesize a mousedown after a tap; suppressing it stops the
    // button taking focus anyway.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
  }
}

// A key cap. Named keys spell their name out ("Ctrl", "Tab") instead of wearing an
// invented glyph.
function KeyCap({
  label,
  name,
  armed,
  onClick,
  className = '',
  // Off for sticky-modifier toggles (holding one would flip it); on for fixed byte
  // sequences a real keyboard would auto-repeat.
  repeat = true,
}: {
  label: string
  name?: string
  armed?: boolean
  onClick: () => void
  className?: string
  repeat?: boolean
}) {
  return (
    <button
      type="button"
      {...usePressProps(onClick, repeat)}
      aria-label={name ?? label}
      aria-pressed={armed}
      className={`flex h-9 min-w-0 items-center justify-center overflow-hidden rounded px-0.5 text-[11px] font-medium whitespace-nowrap touch-manipulation ${
        armed ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200 active:bg-slate-700'
      } ${className}`}
    >
      {label}
    </button>
  )
}

// A key whose meaning is universally understood as a glyph - the four arrows, plus the two
// panel toggles. Its accessible name still spells the meaning out for tests/screen readers.
function IconKeyCap({
  name,
  Icon,
  active,
  onClick,
  expanded,
  // Off by default (the two panel toggles use it as-is); the arrows opt in below since holding
  // one is exactly how a user walks the cursor across a line.
  repeat = false,
}: {
  name: string
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement
  active?: boolean
  onClick: () => void
  expanded?: boolean
  repeat?: boolean
}) {
  return (
    <button
      type="button"
      {...usePressProps(onClick, repeat)}
      aria-label={name}
      aria-expanded={expanded}
      className={`flex h-9 min-w-0 items-center justify-center rounded touch-manipulation ${
        active ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-300 active:bg-slate-700'
      }`}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  )
}

// One entry in the snippet picker - a real component because usePressProps is a hook and
// can't be called inside a loop body.
function SnippetButton({ name, command, onPick }: { name: string; command: string; onPick: () => void }) {
  return (
    <button
      type="button"
      {...usePressProps(onPick)}
      className="flex w-full flex-col items-start gap-0.5 border-b border-slate-800/60 px-3 py-2 text-left touch-manipulation active:bg-slate-800"
    >
      <span className="text-xs font-medium text-slate-200">{name}</span>
      <span className="w-full truncate font-mono text-[11px] text-slate-400">{command}</span>
    </button>
  )
}

// The keys mobile on-screen keyboards don't expose, below the terminal (rendered only on
// isMobileApp()). A fixed grid rather than a scrolling row so every cell shrinks to fit; a
// panel shrinks the terminal rather than overlaying it.
//
// Presentational apart from fetching the snippet list; putting bytes on the wire stays
// TerminalView's job.
export function KeyboardToolbar({
  ctrlArmed,
  altArmed,
  onToggleCtrl,
  onToggleAlt,
  onSendKey,
  onPasteText,
}: KeyboardToolbarProps) {
  const [panel, setPanel] = useState<'none' | 'keys' | 'snippets'>('none')
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])

  // Fetched when the picker is first opened, so an unopened picker costs no request.
  // Best-effort; a failed read just means an empty list.
  useEffect(() => {
    if (panel !== 'snippets') return
    let cancelled = false
    listSnippets()
      .then((entries) => {
        if (!cancelled) setSnippets(entries)
      })
      .catch(() => {
        if (!cancelled) setSnippets([])
      })
    return () => {
      cancelled = true
    }
  }, [panel])

  // Opening a panel hides the on-screen keyboard first (both shrinking the terminal would
  // leave almost no rows); closing deliberately doesn't bring it back - tapping the
  // terminal does.
  function togglePanel(next: 'keys' | 'snippets') {
    // Read from the rendered value rather than from inside the updater: the hide is a side
    // effect, and an updater can be called more than once for the same tap.
    if (panel !== next) hideAndroidKeyboard()
    setPanel(panel === next ? 'none' : next)
  }

  return (
    <div className="shrink-0 select-none border-t border-slate-800 bg-slate-950">
      <div role="group" aria-label="Terminal keys" className="grid grid-cols-9 gap-1 p-1.5">
        <KeyCap label="Esc" name="Escape" onClick={() => onSendKey('\x1b')} />
        <KeyCap label="Tab" onClick={() => onSendKey('\t')} />
        <KeyCap label="Ctrl" armed={ctrlArmed} onClick={onToggleCtrl} repeat={false} />
        <IconKeyCap
          name="Snippets"
          Icon={SnippetsIcon}
          active={panel === 'snippets'}
          expanded={panel === 'snippets'}
          onClick={() => togglePanel('snippets')}
        />
        <IconKeyCap name="Left" Icon={ArrowLeftIcon} onClick={() => onSendKey('\x1b[D')} repeat />
        <IconKeyCap name="Right" Icon={ArrowRightIcon} onClick={() => onSendKey('\x1b[C')} repeat />
        <IconKeyCap name="Up" Icon={ArrowUpIcon} onClick={() => onSendKey('\x1b[A')} repeat />
        <IconKeyCap name="Down" Icon={ArrowDownIcon} onClick={() => onSendKey('\x1b[B')} repeat />
        <IconKeyCap
          name="More keys"
          Icon={MoreHorizontalIcon}
          active={panel === 'keys'}
          expanded={panel === 'keys'}
          onClick={() => togglePanel('keys')}
        />
      </div>

      {panel === 'keys' && (
        <div className="flex flex-col gap-1 border-t border-slate-800 p-1.5">
          <div className="grid grid-cols-9 gap-1">
            <KeyCap label="Alt" armed={altArmed} onClick={onToggleAlt} repeat={false} />
            {EXTRA_ROWS[0].map((key) => (
              <KeyCap
                key={key.label}
                label={key.label}
                name={key.name}
                onClick={() => onSendKey(key.send)}
                className={key.wide ? 'col-span-2' : ''}
              />
            ))}
          </div>
          {EXTRA_ROWS.slice(1).map((row) => (
            <div key={row[0].label} className="grid grid-cols-9 gap-1">
              {row.map((key) => (
                <KeyCap key={key.label} label={key.label} name={key.name} onClick={() => onSendKey(key.send)} />
              ))}
            </div>
          ))}
        </div>
      )}

      {panel === 'snippets' && (
        <div className="max-h-48 overflow-y-auto border-t border-slate-800">
          {snippets.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">
              No snippets yet - add them on the Snippets screen and they show up here.
            </p>
          ) : (
            snippets.map((entry) => (
              <SnippetButton
                key={entry.id}
                name={entry.snippet.name}
                command={entry.snippet.command}
                onPick={() => {
                  onPasteText(entry.snippet.command)
                  setPanel('none')
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
