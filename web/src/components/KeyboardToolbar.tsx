import { useEffect, useState } from 'react'
import type { PointerEvent, ReactElement, SVGProps } from 'react'
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, MoreHorizontalIcon, SnippetsIcon } from './icons'
import { listSnippets, type SavedSnippet } from '../lib/api'

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

// The rows the "More keys" button reveals, laid out the way Termius's own key panel groups
// them: modifiers and navigation/editing first, then the Ctrl-combos worth a dedicated key,
// then the punctuation phone keyboards bury behind a symbol layer, then function keys for
// full-screen TUIs. Cursor/editing keys use the normal-mode CSI forms, matching the arrows in
// the row above (xterm.js sends those same forms unless the remote switches to application
// mode). Abbreviated labels are the ones physical keycaps use, and each still carries the full
// word as its accessible name.
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

// Fires on press instead of on click, and - the important half - keeps the press from moving
// focus off xterm's hidden textarea.
//
// A toolbar button that takes focus makes Android tear the keyboard's input connection down and
// build it back up on every single tap. That is what the half-second lag between tapping a key
// and the shell reacting actually was, and it also destroyed whatever the keyboard was still
// holding in its composing region - which is why tapping the left arrow after typing "ls -al"
// wiped out the "-al" instead of moving the cursor (with a trailing space the word had already
// been committed, so there was nothing left to lose, and the arrow behaved). Handling
// pointerdown rather than click also drops the wait for the tap to complete.
function pressProps(action: () => void) {
  return {
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault()
      action()
    },
  }
}

// A key cap. Named keys spell their own name out ("Ctrl", "Tab", "Shift+Tab") rather than
// wearing an invented glyph - the icons this replaced told the user nothing about what the
// button did, which is the whole complaint this layout answers.
function KeyCap({
  label,
  name,
  armed,
  onClick,
  className = '',
}: {
  label: string
  name?: string
  armed?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      {...pressProps(onClick)}
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
}: {
  name: string
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement
  active?: boolean
  onClick: () => void
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      {...pressProps(onClick)}
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

// The keys mobile on-screen keyboards don't expose, sitting below the terminal itself (see
// TerminalView, which only renders this on isMobileApp()).
//
// Layered rather than crammed into one row: an always-visible row of nine equal-width cells
// holding only what a shell session reaches for constantly (Esc, Tab, the sticky Ctrl
// modifier, snippets, the arrows) plus the two panel toggles, and one panel below it - either
// "More keys" (editing/navigation, one-tap Ctrl-combos, buried punctuation, F1-F12) or the
// snippet picker, never both. A grid, not a scrolling row: at any phone width every cell
// shrinks to fit instead of the last key sliding half-under its neighbour.
//
// Opening a panel shrinks the terminal rather than overlaying it, so fitAddon stays
// parent-driven.
//
// Presentational apart from fetching the snippet list: every key's bytes are declared here as
// data, and putting them on the wire (plus the sticky-modifier semantics behind Ctrl/Alt)
// stays entirely TerminalView's job.
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

  // Fetched when the picker is first opened rather than up front: an unopened picker shouldn't
  // cost a request per terminal tab. Best-effort like every other vault read - a locked vault
  // or a failed fetch just means an empty list, never a broken toolbar.
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

  function togglePanel(next: 'keys' | 'snippets') {
    setPanel((current) => (current === next ? 'none' : next))
  }

  return (
    <div className="shrink-0 select-none border-t border-slate-800 bg-slate-950">
      <div role="group" aria-label="Terminal keys" className="grid grid-cols-9 gap-1 p-1.5">
        <KeyCap label="Esc" name="Escape" onClick={() => onSendKey('\x1b')} />
        <KeyCap label="Tab" onClick={() => onSendKey('\t')} />
        <KeyCap label="Ctrl" armed={ctrlArmed} onClick={onToggleCtrl} />
        <IconKeyCap
          name="Snippets"
          Icon={SnippetsIcon}
          active={panel === 'snippets'}
          expanded={panel === 'snippets'}
          onClick={() => togglePanel('snippets')}
        />
        <IconKeyCap name="Left" Icon={ArrowLeftIcon} onClick={() => onSendKey('\x1b[D')} />
        <IconKeyCap name="Right" Icon={ArrowRightIcon} onClick={() => onSendKey('\x1b[C')} />
        <IconKeyCap name="Up" Icon={ArrowUpIcon} onClick={() => onSendKey('\x1b[A')} />
        <IconKeyCap name="Down" Icon={ArrowDownIcon} onClick={() => onSendKey('\x1b[B')} />
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
            <KeyCap label="Alt" armed={altArmed} onClick={onToggleAlt} />
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
              <button
                key={entry.id}
                type="button"
                {...pressProps(() => {
                  onPasteText(entry.snippet.command)
                  setPanel('none')
                })}
                className="flex w-full flex-col items-start gap-0.5 border-b border-slate-800/60 px-3 py-2 text-left touch-manipulation active:bg-slate-800"
              >
                <span className="text-xs font-medium text-slate-200">{entry.snippet.name}</span>
                <span className="w-full truncate font-mono text-[11px] text-slate-400">{entry.snippet.command}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
