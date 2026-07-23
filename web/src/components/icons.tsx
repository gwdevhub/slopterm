import type { SVGProps } from 'react'

// One consistent outline-style icon family (24x24 viewBox, currentColor stroke) for every
// icon in the app - replaces the ad hoc emoji glyphs that used to render inconsistently
// across OSes/browsers and never matched the surrounding text color. Every icon takes the
// same props as a plain <svg> so callers size/color them purely with className (typically
// `h-5 w-5 text-current`), giving one visual language across nav/buttons/tabs.
type IconProps = SVGProps<SVGSVGElement>

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function HostsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <line x1="8" y1="20" x2="16" y2="20" />
      <line x1="12" y1="16" x2="12" y2="20" />
    </svg>
  )
}

export function KeychainIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="7" cy="12" r="4" />
      <line x1="11" y1="12" x2="21" y2="12" />
      <line x1="17" y1="12" x2="17" y2="16" />
      <line x1="21" y1="12" x2="21" y2="16" />
    </svg>
  )
}

export function SnippetsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="4" width="14" height="17" rx="1.5" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="16" y2="15" />
    </svg>
  )
}

export function LogsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 2 H14 L18 6 V22 H6 Z" />
      <path d="M14 2 V6 H18" />
      <line x1="8.5" y1="11" x2="15.5" y2="11" />
      <line x1="8.5" y1="15" x2="15.5" y2="15" />
      <line x1="8.5" y1="19" x2="13" y2="19" />
    </svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <line x1="5.5" y1="5.5" x2="7.5" y2="7.5" />
      <line x1="16.5" y1="16.5" x2="18.5" y2="18.5" />
      <line x1="18.5" y1="5.5" x2="16.5" y2="7.5" />
      <line x1="7.5" y1="16.5" x2="5.5" y2="18.5" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  )
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="20" y1="12" x2="4" y2="12" />
      <polyline points="10,6 4,12 10,18" />
    </svg>
  )
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  )
}

// A sidebar-with-arrow glyph used for the collapse/expand toggle - the caller rotates it
// 180deg (via className) to flip meaning between "collapse" and "expand" rather than this
// needing two separate icons.
export function SidebarToggleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <polyline points="6,9 4,12 6,15" />
    </svg>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20 L4.7 16.4 L15 6.1 C15.6 5.5 16.5 5.5 17.1 6.1 L17.9 6.9 C18.5 7.5 18.5 8.4 17.9 9 L7.6 19.3 Z" />
      <line x1="13.5" y1="8" x2="16" y2="10.5" />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 6.5 C3 5.5 3.8 5 4.5 5 H9 L11 7 H19.5 C20.2 7 21 7.5 21 8.5 V17.5 C21 18.5 20.2 19 19.5 19 H4.5 C3.8 19 3 18.5 3 17.5 Z" />
    </svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 2 H14 L18 6 V22 H6 Z" />
      <path d="M14 2 V6 H18" />
    </svg>
  )
}

export function TerminalTabIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="4" width="19" height="16" rx="1.5" />
      <polyline points="6.5,9 10.5,12 6.5,15" />
      <line x1="12.5" y1="15" x2="16.5" y2="15" />
    </svg>
  )
}

export function SftpTabIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 7.5 C3 6.5 3.8 6 4.5 6 H9 L10.5 8 H14 C14.7 8 15.5 8.5 15.5 9.5 V16.5 C15.5 17.5 14.7 18 14 18 H4.5 C3.8 18 3 17.5 3 16.5 Z" />
      <polyline points="16,3 20,3 20,7" />
      <line x1="20" y1="3" x2="14" y2="9" />
    </svg>
  )
}
