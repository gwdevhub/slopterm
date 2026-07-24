import { useEffect, useState, type FormEvent } from 'react'
import {
  createSyncRule,
  deleteSyncRule,
  getSyncStatus,
  listHosts,
  listSyncRules,
  startSyncRule,
  stopSyncRule,
  updateSyncRule,
  type SavedHost,
  type SavedSyncRule,
  type SyncRuleRecord,
  type SyncRuleStatus,
} from '../lib/api'
import { VaultGate } from './VaultGate'
import { CardGrid, EntityCard, cardPrimaryButton, cardSecondaryButton } from './CardGrid'
import { SyncIcon } from './icons'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'
const labelClasses = 'mb-1 block text-xs font-medium text-slate-400'

// One-way local -> remote folder sync, tunnelled through a saved host over SFTP (see the
// backend SyncService). Watches the local folder and mirrors every create/change/rename/
// delete under the remote folder; remote-side changes are NOT picked up (SFTP has no push/
// notify - see SyncService's doc comment). Same card-grid layout as Port Forwarding.
export function SyncSection() {
  return (
    <VaultGate>
      <SyncRuleList />
    </VaultGate>
  )
}

function SyncRuleList() {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [rules, setRules] = useState<SavedSyncRule[]>([])
  const [status, setStatus] = useState<SyncRuleStatus[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SavedSyncRule | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    refreshRecords()
  }, [])

  // Poll live sync state so Active/Connecting/Error stays current without a manual reload.
  useEffect(() => {
    let alive = true
    const tick = () => getSyncStatus().then((s) => alive && setStatus(s)).catch(() => {})
    tick()
    const interval = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [])

  function refreshRecords() {
    listHosts().then(setHosts)
    listSyncRules().then(setRules)
    getSyncStatus().then(setStatus).catch(() => {})
  }

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.host.name ?? '(unknown host)'
  const statusOf = (ruleId: string) => status.find((s) => s.ruleId === ruleId)

  async function handleDelete(id: string) {
    await deleteSyncRule(id)
    refreshRecords()
  }

  async function handleToggle(r: SavedSyncRule) {
    setError(null)
    const running = statusOf(r.id) !== undefined
    try {
      if (running) await stopSyncRule(r.id)
      else await startSyncRule(r.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change sync rule')
    }
    setTimeout(() => getSyncStatus().then(setStatus).catch(() => {}), 300)
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? rules.filter(
        (r) =>
          (r.rule.description ?? '').toLowerCase().includes(q) ||
          hostName(r.rule.hostId).toLowerCase().includes(q) ||
          describe(r.rule, hostName(r.rule.hostId)).toLowerCase().includes(q),
      )
    : rules

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <p className="mx-3 mt-3 text-sm text-red-400 sm:mx-4">{error}</p>}
        <CardGrid
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Find a sync rule…"
          newLabel="New sync rule"
          onNew={() => setEditing('new')}
          isEmpty={filtered.length === 0}
          emptyText={rules.length === 0 ? 'No sync rules yet.' : 'No sync rules match your search.'}
        >
          {filtered.map((r) => {
            const st = statusOf(r.id)
            const running = st !== undefined
            const mapping = describe(r.rule, hostName(r.rule.hostId))
            return (
              <EntityCard
                key={r.id}
                icon={<SyncIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />}
                title={
                  <>
                    <StatusDot state={st?.state} />
                    <span className="truncate font-medium text-slate-100">{r.rule.description || mapping}</span>
                    {r.rule.autoStart && (
                      <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                        Auto
                      </span>
                    )}
                  </>
                }
                subtitle={<span className="font-mono" title={mapping}>{mapping}</span>}
                extra={st?.state === 'error' && st.error ? <p className="w-full truncate text-xs text-red-400" title={st.error}>{st.error}</p> : undefined}
                actions={
                  <>
                    <button type="button" onClick={() => handleToggle(r)} className={running ? cardSecondaryButton : cardPrimaryButton}>
                      {running ? 'Stop' : 'Start'}
                    </button>
                    <button type="button" onClick={() => setEditing(r)} className={cardSecondaryButton}>
                      Edit
                    </button>
                    <button type="button" onClick={() => handleDelete(r.id)} className={cardSecondaryButton}>
                      Delete
                    </button>
                  </>
                }
              />
            )
          })}
        </CardGrid>
      </div>

      {editing && (
        <SyncRuleModal
          rule={editing === 'new' ? null : editing}
          hosts={hosts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refreshRecords()
          }}
        />
      )}
    </>
  )
}

interface FormState {
  hostId: string
  localPath: string
  remotePath: string
  description: string
  autoStart: boolean
  direction: SyncRuleRecord['direction']
  deleteExtraneous: boolean
  skipUnchanged: boolean
}

function SyncRuleModal({
  rule,
  hosts,
  onClose,
  onSaved,
}: {
  rule: SavedSyncRule | null
  hosts: SavedHost[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => ({
    hostId: rule?.rule.hostId ?? hosts[0]?.id ?? '',
    localPath: rule?.rule.localPath ?? '',
    remotePath: rule?.rule.remotePath ?? '',
    description: rule?.rule.description ?? '',
    autoStart: rule?.rule.autoStart ?? false,
    direction: rule?.rule.direction ?? 'localToRemote',
    deleteExtraneous: rule?.rule.deleteExtraneous ?? true,
    skipUnchanged: rule?.rule.skipUnchanged ?? true,
  }))
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const record: SyncRuleRecord = {
      hostId: form.hostId || hosts[0]?.id || '',
      localPath: form.localPath.trim(),
      remotePath: form.remotePath.trim(),
      description: form.description.trim() || undefined,
      autoStart: form.autoStart,
      direction: form.direction,
      deleteExtraneous: form.deleteExtraneous,
      skipUnchanged: form.skipUnchanged,
    }
    try {
      if (rule) await updateSyncRule(rule.id, record)
      else await createSyncRule(record)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sync rule')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={handleSubmit} className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">{rule ? 'Edit sync rule' : 'New sync rule'}</h3>

        {hosts.length === 0 ? (
          <p className="text-sm text-slate-500">Save a host first — a sync rule pushes to one over SFTP.</p>
        ) : (
          <>
            <div>
              <label className={labelClasses} htmlFor="sr-host">Host</label>
              <select id="sr-host" className={inputClasses} value={form.hostId || hosts[0]?.id} onChange={(e) => set('hostId', e.target.value)} required>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>{h.host.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClasses} htmlFor="sr-direction">Direction</label>
              <select
                id="sr-direction"
                className={inputClasses}
                value={form.direction}
                onChange={(e) => set('direction', e.target.value as FormState['direction'])}
              >
                <option value="localToRemote">Local → Remote (push)</option>
                <option value="remoteToLocal">Remote → Local (pull)</option>
                <option value="twoWay">Two-way</option>
              </select>
            </div>

            <p className="rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
              {form.direction === 'localToRemote' &&
                'Local changes push to the remote folder. Changes made on the remote side directly are not picked up.'}
              {form.direction === 'remoteToLocal' &&
                'Remote changes pull into the local folder (polled - SFTP has no live watch). Local changes are not pushed out.'}
              {form.direction === 'twoWay' &&
                'Both sides sync. If the same file changes on both sides between passes, whichever side was modified most recently wins - this is not real conflict resolution.'}
            </p>

            <div>
              <label className={labelClasses} htmlFor="sr-local">Local folder</label>
              <input id="sr-local" className={inputClasses} value={form.localPath} onChange={(e) => set('localPath', e.target.value)} placeholder="/home/me/project" required />
            </div>

            <div>
              <label className={labelClasses} htmlFor="sr-remote">Remote folder</label>
              <input id="sr-remote" className={inputClasses} value={form.remotePath} onChange={(e) => set('remotePath', e.target.value)} placeholder="/home/user/project" required />
            </div>

            <div>
              <label className={labelClasses} htmlFor="sr-desc">Description (optional)</label>
              <input id="sr-desc" className={inputClasses} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. deploy folder" />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.skipUnchanged} onChange={(e) => set('skipUnchanged', e.target.checked)} />
              Skip files that already match (compare size/modified time, don't re-transfer)
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.deleteExtraneous} onChange={(e) => set('deleteExtraneous', e.target.checked)} />
              Delete files that were removed at the source (off = copy-only, never deletes)
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.autoStart} onChange={(e) => set('autoStart', e.target.checked)} />
              Auto-start in the background when slopterm launches
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
                Cancel
              </button>
              <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
                {rule ? 'Save changes' : 'Add sync rule'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

function describe(r: SyncRuleRecord, host: string): string {
  const arrow = r.direction === 'remoteToLocal' ? '←' : r.direction === 'twoWay' ? '⇄' : '→'
  return `${r.localPath}  ${arrow}  ${host}:${r.remotePath}`
}

function StatusDot({ state }: { state?: SyncRuleStatus['state'] }) {
  const color =
    state === 'active' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : state === 'error' ? 'bg-red-400' : 'bg-slate-600'
  const title = state ? state[0].toUpperCase() + state.slice(1) : 'Inactive'
  return <span aria-hidden="true" title={title} className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
}
