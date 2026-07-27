import type { ReactElement, SVGProps } from 'react'
import {
  AltIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CtrlIcon,
  DeleteIcon,
  EscapeIcon,
  InsertIcon,
  ShiftIcon,
  TabIcon,
} from './icons'

interface KeyboardToolbarProps {
  ctrlArmed: boolean
  altArmed: boolean
  shiftArmed: boolean
  onToggleCtrl: () => void
  onToggleAlt: () => void
  onToggleShift: () => void
  onTab: () => void
  onEscape: () => void
  onArrowUp: () => void
  onArrowDown: () => void
  onArrowLeft: () => void
  onArrowRight: () => void
  onDelete: () => void
  onInsert: () => void
}

function ToolbarButton({
  onClick,
  armed,
  label,
  Icon,
}: {
  onClick: () => void
  armed?: boolean
  label: string
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={armed}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded ${
        armed ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
      }`}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  )
}

// A row of keys mobile on-screen keyboards don't expose - Ctrl/Escape/arrows/etc - sitting
// below the terminal itself (see TerminalView, which only renders this on isMobileApp()).
// Deliberately a single horizontally-scrolling row (Termux's own "extra keys" row takes the
// same approach) rather than a second, toggled row: simpler state, and swiping is no worse
// on a real phone than reaching for a "more" button. Purely presentational - every button
// just calls the callback prop TerminalView already wired to the live session (sendKey/
// toggleModifier there own all the actual escape-sequence/control-code knowledge), so this
// component has no notion of what a control code or an ANSI sequence even is.
export function KeyboardToolbar({
  ctrlArmed,
  altArmed,
  shiftArmed,
  onToggleCtrl,
  onToggleAlt,
  onToggleShift,
  onTab,
  onEscape,
  onArrowUp,
  onArrowDown,
  onArrowLeft,
  onArrowRight,
  onDelete,
  onInsert,
}: KeyboardToolbarProps) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-slate-800 bg-slate-950 p-1.5">
      <ToolbarButton onClick={onToggleCtrl} armed={ctrlArmed} label="Ctrl" Icon={CtrlIcon} />
      <ToolbarButton onClick={onToggleAlt} armed={altArmed} label="Alt" Icon={AltIcon} />
      <ToolbarButton onClick={onToggleShift} armed={shiftArmed} label="Shift" Icon={ShiftIcon} />
      <ToolbarButton onClick={onTab} label="Tab" Icon={TabIcon} />
      <ToolbarButton onClick={onEscape} label="Escape" Icon={EscapeIcon} />
      <ToolbarButton onClick={onArrowLeft} label="Left" Icon={ArrowLeftIcon} />
      <ToolbarButton onClick={onArrowUp} label="Up" Icon={ArrowUpIcon} />
      <ToolbarButton onClick={onArrowDown} label="Down" Icon={ArrowDownIcon} />
      <ToolbarButton onClick={onArrowRight} label="Right" Icon={ArrowRightIcon} />
      <ToolbarButton onClick={onInsert} label="Insert" Icon={InsertIcon} />
      <ToolbarButton onClick={onDelete} label="Delete" Icon={DeleteIcon} />
    </div>
  )
}
