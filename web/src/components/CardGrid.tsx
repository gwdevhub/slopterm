import type { MouseEvent, ReactNode } from 'react'
import { PlusIcon } from './icons'

interface CardGridProps {
  query: string
  onQueryChange: (query: string) => void
  searchPlaceholder: string
  newLabel: string
  onNew: () => void
  isEmpty: boolean
  emptyText: string
  children: ReactNode
}

// The shared "toolbar + responsive card grid" shell, so Keychain / Snippets / Port
// Forwarding all use the exact same layout as the Hosts grid (HostGrid) instead of each
// section inventing its own vertical-list-plus-inline-form. Same container, same search +
// "New …" toolbar row, same auto-fill grid. Cards are the `children` (each an EntityCard /
// <li>); the empty-state line renders below the grid.
export function CardGrid({ query, onQueryChange, searchPlaceholder, newLabel, onNew, isEmpty, emptyText, children }: CardGridProps) {
  return (
    <div className="flex flex-1 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          {newLabel}
        </button>
      </div>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">{children}</ul>

      {isEmpty && <p className="text-sm text-slate-500">{emptyText}</p>}
    </div>
  )
}

interface EntityCardProps {
  icon: ReactNode
  // The name row - a ReactNode so callers can compose a status dot / badge alongside the
  // name (kept as a flex row here so a long name truncates while siblings stay put).
  title: ReactNode
  subtitle?: ReactNode
  extra?: ReactNode
  actions?: ReactNode
  onContextMenu?: (event: MouseEvent) => void
}

// One card in a CardGrid, styled exactly like HostCard: an icon + title (+ optional
// subtitle/extra) on the left, a column of action buttons on the right.
export function EntityCard({ icon, title, subtitle, extra, actions, onContextMenu }: EntityCardProps) {
  return (
    <li
      onContextMenu={onContextMenu}
      className="flex items-stretch gap-2 rounded border border-slate-800 bg-slate-900/60 p-3 hover:border-slate-700"
    >
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        {icon}
        <div className="flex w-full min-w-0 items-center gap-1.5">{title}</div>
        {subtitle && <div className="w-full min-w-0 truncate text-xs text-slate-400">{subtitle}</div>}
        {extra}
      </div>
      {actions && <div className="flex shrink-0 flex-col justify-center gap-1">{actions}</div>}
    </li>
  )
}

// Shared small card-action button styles, matching HostCard's SSH/SFTP/edit buttons.
export const cardPrimaryButton =
  'rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50'
export const cardSecondaryButton =
  'rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50'
