import { useState } from 'react'
import type { ReactElement, SVGProps } from 'react'
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, MoreHorizontalIcon } from './icons'

// One tappable key: the label the user reads, and the exact bytes it puts on the wire.
interface KeyDef {
  label: string
  send: string
  // Accessible name, for when the visible label is an abbreviation ("Pg Up") or a glyph ("^C").
  name?: string
  // Takes two columns of the expanded panel's grid, for a label one column can't hold.
  wide?: boolean
}

// The rows the "More keys" button reveals, laid out the way Termius's own key panel groups
// them: navigation/editing first, then the Ctrl-combos worth a dedicated key, then the
// punctuation phone keyboards bury behind a symbol layer, then function keys for full-screen
// TUIs. Cursor/editing keys use the normal-mode CSI forms, matching the arrows in the row
// above (xterm.js sends those same forms unless the remote switches to application mode).
const EXTRA_ROWS: KeyDef[][] = [
  [
    { label: 'Shift+Tab', send: '\x1b[Z', wide: true },
    { label: 'Insert', send: '\x1b[2~' },
    { label: 'Delete', send: '\x1b[3~' },
    { label: 'Home', send: '\x1b[H' },
    { label: 'End', send: '\x1b[F' },
    { label: 'Pg Up', send: '\x1b[5~', name: 'Page Up' },
    { label: 'Pg Dn', send: '\x1b[6~', name: 'Page Down' },
  ],
  // The C0 control codes, as one tap each - arming Ctrl (above) and then typing the letter
  // needs the on-screen keyboard open, which these don't.
  [
    { label: '^C', send: '\x03', name: 'Ctrl+C' },
    { label: '^D', send: '\x04', name: 'Ctrl+D' },
    { label: '^Z', send: '\x1a', name: 'Ctrl+Z' },
    { label: '^L', send: '\x0c', name: 'Ctrl+L' },
    { label: '^R', send: '\x12', name: 'Ctrl+R' },
    { label: '^A', send: '\x01', name: 'Ctrl+A' },
    { label: '^E', send: '\x05', name: 'Ctrl+E' },
    { label: '^K', send: '\x0b', name: 'Ctrl+K' },
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
  ],
  [
    { label: 'F9', send: '\x1b[20~' },
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
      onClick={onClick}
      aria-label={name ?? label}
      aria-pressed={armed}
      className={`flex h-9 items-center justify-center rounded px-1 text-xs font-medium tabular-nums touch-manipulation ${
        armed ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200 active:bg-slate-700'
      } ${className}`}
    >
      {label}
    </button>
  )
}

// A key whose meaning is universally understood as a glyph - the four arrows, and nothing
// else. Its accessible name still spells the direction out for the tests/screen readers.
function ArrowKeyCap({
  name,
  Icon,
  onClick,
}: {
  name: string
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-slate-800 text-slate-200 active:bg-slate-700 touch-manipulation"
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  )
}

// The keys mobile on-screen keyboards don't expose, sitting below the terminal itself (see
// TerminalView, which only renders this on isMobileApp()).
//
// Two rows deep on purpose, after the single crammed row of icon-only buttons this replaced:
// an always-visible row holding only what a shell session reaches for constantly (Esc, Tab,
// the sticky Ctrl/Alt modifiers, the arrows), and a "More keys" panel with everything else -
// editing/navigation keys, one-tap Ctrl-combos, buried punctuation, F1-F12. Expanding it
// shrinks the terminal rather than overlaying it, so fitAddon stays parent-driven.
//
// Presentational: every key's bytes are declared here as data, and pushing them into the
// live session (plus the sticky-modifier semantics behind Ctrl/Alt) stays entirely
// TerminalView's job.
export function KeyboardToolbar({ ctrlArmed, altArmed, onToggleCtrl, onToggleAlt, onSendKey }: KeyboardToolbarProps) {
  const [showExtraKeys, setShowExtraKeys] = useState(false)

  return (
    <div className="shrink-0 select-none border-t border-slate-800 bg-slate-950">
      <div className="flex items-center gap-1 p-1.5">
        <div className="flex flex-1 gap-1 overflow-x-auto">
          <KeyCap label="Esc" name="Escape" onClick={() => onSendKey('\x1b')} className="w-10 shrink-0" />
          <KeyCap label="Tab" onClick={() => onSendKey('\t')} className="w-10 shrink-0" />
          <KeyCap label="Ctrl" armed={ctrlArmed} onClick={onToggleCtrl} className="w-10 shrink-0" />
          <KeyCap label="Alt" armed={altArmed} onClick={onToggleAlt} className="w-10 shrink-0" />
          <ArrowKeyCap name="Left" Icon={ArrowLeftIcon} onClick={() => onSendKey('\x1b[D')} />
          <ArrowKeyCap name="Up" Icon={ArrowUpIcon} onClick={() => onSendKey('\x1b[A')} />
          <ArrowKeyCap name="Down" Icon={ArrowDownIcon} onClick={() => onSendKey('\x1b[B')} />
          <ArrowKeyCap name="Right" Icon={ArrowRightIcon} onClick={() => onSendKey('\x1b[C')} />
        </div>
        <button
          type="button"
          onClick={() => setShowExtraKeys((shown) => !shown)}
          aria-label="More keys"
          aria-expanded={showExtraKeys}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded touch-manipulation ${
            showExtraKeys ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-300'
          }`}
        >
          <MoreHorizontalIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {showExtraKeys && (
        <div className="flex flex-col gap-1 border-t border-slate-800 p-1.5">
          {EXTRA_ROWS.map((row) => (
            <div key={row[0].label} className="grid grid-cols-8 gap-1">
              {row.map((key) => (
                <KeyCap
                  key={key.label}
                  label={key.label}
                  name={key.name}
                  onClick={() => onSendKey(key.send)}
                  className={key.wide ? 'col-span-2' : ''}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
