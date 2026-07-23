import { useEffect, useState } from 'react'
import {
  getHostShareToken,
  listHosts,
  listSnippets,
  upsertRecentConnection,
  type ConnectRequest,
  type SavedHost,
  type SavedRecentConnection,
  type SavedSnippet,
} from '../lib/api'
import { resolveConnectRequest, resolveRecentConnectRequest, resolveStartupCommands } from '../lib/hosts'
import { VaultGate } from './VaultGate'
import { HostGrid } from './HostGrid'
import { HostDetailsPanel } from './HostDetailsPanel'
import { RecentConnections } from './RecentConnections'
import { QuickConnectModal } from './QuickConnectModal'
import { ContextMenu } from './ContextMenu'
import { ImportHostModal } from './ImportHostModal'
import { ShareTokenModal } from './ShareTokenModal'
import type { ConnectionFormValues } from './ConnectionForm'

interface HostsSectionProps {
  onConnect: (request: ConnectRequest, startupCommands?: string[]) => Promise<boolean>
  onConnectSftp: (request: ConnectRequest, label: string) => Promise<boolean>
  errorMessage: string | null
  isConnecting: boolean
}

export function HostsSection({ onConnect, onConnectSftp, errorMessage, isConnecting }: HostsSectionProps) {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [selection, setSelection] = useState<'none' | 'new' | string>('none')
  // Whether the selected host is showing in edit mode (vs. read-only details). Kept
  // separate from `selection` so both context-menu "Edit" and the details panel's own
  // Edit button just flip this without changing which host is selected.
  const [editing, setEditing] = useState(false)
  const [quickConnectOpen, setQuickConnectOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [recentsRefreshToken, setRecentsRefreshToken] = useState(0)
  const [menu, setMenu] = useState<{ host: SavedHost; x: number; y: number } | null>(null)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    refreshHosts()
    listSnippets()
      .then(setSnippets)
      .catch(() => setSnippets([]))
  }, [])

  // Auto-dismiss the transient "Copied…" pill.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  function refreshHosts() {
    listHosts().then(setHosts)
  }

  function selectHost(id: string) {
    setSelection(id)
    setEditing(false)
  }

  function backToList() {
    setSelection('none')
    setEditing(false)
  }

  // Ad hoc connections (Quick Connect, or reconnecting via an existing Recent) remember
  // their credential so next time is one click/double-click away - see
  // RecentConnectionRecord's doc comment for why this is a separate store from Hosts.
  function rememberRecent(request: ConnectRequest) {
    void upsertRecentConnection({
      host: request.host,
      port: request.port,
      username: request.username,
      authMethod: request.authMethod,
      secret: request.authMethod === 'password' ? request.password : request.privateKey,
      passphrase: request.authMethod === 'privateKey' ? request.passphrase : undefined,
    }).then(() => setRecentsRefreshToken((n) => n + 1))
  }

  async function handleQuickConnectSubmit(values: ConnectionFormValues) {
    const request: ConnectRequest = {
      host: values.host,
      port: values.port,
      username: values.username,
      authMethod: values.authMethod,
      password: values.password,
      privateKey: values.privateKey,
      passphrase: values.passphrase,
      columns: 80,
      rows: 24,
    }
    if (await onConnect(request)) rememberRecent(request)
  }

  function handleSsh(host: SavedHost) {
    const request = resolveConnectRequest(host)
    if (request) void onConnect(request, resolveStartupCommands(host, snippets))
  }

  function handleSftp(host: SavedHost) {
    const request = resolveConnectRequest(host)
    if (request) void onConnectSftp(request, host.host.name)
  }

  // "Copy" - put an encrypted, portable token for this host on the clipboard (see
  // getHostShareToken). Falls back to a manual-copy modal only if the clipboard API is
  // unavailable (blocked by policy); 127.0.0.1 is a secure context, so it normally isn't.
  async function handleCopyShare(host: SavedHost) {
    let token: string
    try {
      token = await getHostShareToken(host.id)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to copy host')
      return
    }
    try {
      await navigator.clipboard.writeText(token)
      setNotice(`Copied “${host.host.name}” — paste into another slopterm to import`)
    } catch {
      setShareToken(token)
    }
  }

  async function handleRecentSsh(recent: SavedRecentConnection) {
    const request = resolveRecentConnectRequest(recent)
    if (await onConnect(request)) rememberRecent(request)
  }

  async function handleRecentSftp(recent: SavedRecentConnection) {
    const request = resolveRecentConnectRequest(recent)
    if (await onConnectSftp(request, `${recent.connection.username}@${recent.connection.host}`)) rememberRecent(request)
  }

  const selectedHost = selection !== 'none' && selection !== 'new' ? hosts.find((h) => h.id === selection) : undefined

  // 'new' mode and the Quick Connect modal both already show this inline via
  // ConnectionForm's own errorMessage prop - showing it a second time here would be
  // redundant (and, for the modal specifically, an ambiguous duplicate match in tests).
  const showBannerHere = selection !== 'new' && !quickConnectOpen

  return (
    <VaultGate>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {showBannerHere && errorMessage && (
            <p className="mx-3 mt-3 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300 sm:mx-4 sm:mt-4">
              {errorMessage}
            </p>
          )}
          <HostGrid
            hosts={hosts}
            selectedId={selection === 'new' || selection === 'none' ? null : selection}
            onSelect={selectHost}
            onNewHost={() => {
              setSelection('new')
              setEditing(false)
            }}
            onQuickConnect={() => setQuickConnectOpen(true)}
            onImport={() => setImportOpen(true)}
            onSsh={handleSsh}
            onSftp={handleSftp}
            onHostContextMenu={(host, x, y) => setMenu({ host, x, y })}
            isConnecting={isConnecting}
          />
          <RecentConnections
            refreshToken={recentsRefreshToken}
            onSsh={handleRecentSsh}
            onSftp={handleRecentSftp}
            isConnecting={isConnecting}
          />
        </div>
        <HostDetailsPanel
          mode={selection === 'new' ? 'new' : selection === 'none' ? 'empty' : editing ? 'edit' : 'view'}
          host={selectedHost}
          onConnect={onConnect}
          onEdit={() => setEditing(true)}
          onDeleted={() => {
            backToList()
            refreshHosts()
          }}
          onSaved={() => {
            backToList()
            refreshHosts()
          }}
          onHostUpdated={refreshHosts}
          onClose={backToList}
          isConnecting={isConnecting}
        />
      </div>
      {quickConnectOpen && (
        <QuickConnectModal
          onSubmit={handleQuickConnectSubmit}
          onClose={() => setQuickConnectOpen(false)}
          errorMessage={errorMessage}
          isConnecting={isConnecting}
        />
      )}
      {importOpen && (
        <ImportHostModal
          onImported={() => {
            setImportOpen(false)
            refreshHosts()
            setNotice('Imported shared host')
          }}
          onClose={() => setImportOpen(false)}
        />
      )}
      {shareToken && <ShareTokenModal token={shareToken} onClose={() => setShareToken(null)} />}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Connect', onClick: () => handleSsh(menu.host), disabled: resolveConnectRequest(menu.host) === undefined },
            {
              label: 'Edit',
              onClick: () => {
                setSelection(menu.host.id)
                setEditing(true)
              },
            },
            { label: 'Show Details', onClick: () => selectHost(menu.host.id) },
            { label: 'Copy', onClick: () => void handleCopyShare(menu.host) },
          ]}
        />
      )}
      {notice && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className="rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 shadow-lg shadow-black/40">
            {notice}
          </div>
        </div>
      )}
    </VaultGate>
  )
}
