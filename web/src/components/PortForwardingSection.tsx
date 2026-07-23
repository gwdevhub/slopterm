import { useEffect, useState, type FormEvent } from 'react'
import {
  createPortForward,
  deletePortForward,
  getForwardingStatus,
  listHosts,
  listPortForwards,
  startForward,
  stopForward,
  updatePortForward,
  type ForwardStatus,
  type PortForwardRecord,
  type SavedHost,
  type SavedPortForward,
} from '../lib/api'
import { VaultGate } from './VaultGate'
import { CardGrid, EntityCard, cardPrimaryButton, cardSecondaryButton } from './CardGrid'
import { ForwardingIcon } from './icons'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'
const labelClasses = 'mb-1 block text-xs font-medium text-slate-400'

// SSH port forwarding, tunnelled through a saved host. Rules persist in the vault and come up
// automatically when a terminal/SFTP session to their host connects; AutoStart rules also come
// up in the background at app launch (see the backend ForwardingService). Same card-grid
// layout as the Hosts tab (see CardGrid), with create/edit in a modal.
export function PortForwardingSection() {
  return (
    <VaultGate>
      <PortForwardingList />
    </VaultGate>
  )
}

function PortForwardingList() {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [forwards, setForwards] = useState<SavedPortForward[]>([])
  const [status, setStatus] = useState<ForwardStatus[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SavedPortForward | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    refreshRecords()
  }, [])

  // Poll live forwarding state so Active/Connecting/Error stays current without a manual reload.
  useEffect(() => {
    let alive = true
    const tick = () => getForwardingStatus().then((s) => alive && setStatus(s)).catch(() => {})
    tick()
    const interval = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [])

  function refreshRecords() {
    listHosts().then(setHosts)
    listPortForwards().then(setForwards)
    getForwardingStatus().then(setStatus).catch(() => {})
  }

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.host.name ?? '(unknown host)'
  const statusOf = (ruleId: string) => status.find((s) => s.ruleId === ruleId)

  async function handleDelete(id: string) {
    await deletePortForward(id)
    refreshRecords()
  }

  async function handleToggle(f: SavedPortForward) {
    setError(null)
    const running = statusOf(f.id) !== undefined
    try {
      if (running) await stopForward(f.id)
      else await startForward(f.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change forward')
    }
    setTimeout(() => getForwardingStatus().then(setStatus).catch(() => {}), 300)
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? forwards.filter(
        (f) =>
          (f.forward.description ?? '').toLowerCase().includes(q) ||
          hostName(f.forward.hostId).toLowerCase().includes(q) ||
          describe(f.forward, hostName(f.forward.hostId)).toLowerCase().includes(q),
      )
    : forwards

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <p className="mx-3 mt-3 text-sm text-red-400 sm:mx-4">{error}</p>}
        <CardGrid
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Find a forward…"
          newLabel="New port forward"
          onNew={() => setEditing('new')}
          isEmpty={filtered.length === 0}
          emptyText={forwards.length === 0 ? 'No port forwards yet.' : 'No forwards match your search.'}
        >
          {filtered.map((f) => {
            const st = statusOf(f.id)
            const running = st !== undefined
            const mapping = describe(f.forward, hostName(f.forward.hostId))
            return (
              <EntityCard
                key={f.id}
                icon={<ForwardingIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />}
                title={
                  <>
                    <StatusDot state={st?.state} />
                    <span className="truncate font-medium text-slate-100">{f.forward.description || mapping}</span>
                    {f.forward.autoStart && (
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
                    <button type="button" onClick={() => handleToggle(f)} className={running ? cardSecondaryButton : cardPrimaryButton}>
                      {running ? 'Stop' : 'Start'}
                    </button>
                    <button type="button" onClick={() => setEditing(f)} className={cardSecondaryButton}>
                      Edit
                    </button>
                    <button type="button" onClick={() => handleDelete(f.id)} className={cardSecondaryButton}>
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
        <PortForwardModal
          forward={editing === 'new' ? null : editing}
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
  type: 'local' | 'remote'
  bindAddress: string
  bindPort: string
  destinationAddress: string
  destinationPort: string
  description: string
  autoStart: boolean
}

function PortForwardModal({
  forward,
  hosts,
  onClose,
  onSaved,
}: {
  forward: SavedPortForward | null
  hosts: SavedHost[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => ({
    hostId: forward?.forward.hostId ?? hosts[0]?.id ?? '',
    type: forward?.forward.type ?? 'local',
    bindAddress: forward?.forward.bindAddress ?? '127.0.0.1',
    bindPort: forward ? String(forward.forward.bindPort) : '',
    destinationAddress: forward?.forward.destinationAddress ?? '127.0.0.1',
    destinationPort: forward ? String(forward.forward.destinationPort) : '',
    description: forward?.forward.description ?? '',
    autoStart: forward?.forward.autoStart ?? false,
  }))
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const record: PortForwardRecord = {
      hostId: form.hostId || hosts[0]?.id || '',
      type: form.type,
      bindAddress: form.bindAddress.trim() || '127.0.0.1',
      bindPort: Number(form.bindPort),
      destinationAddress: form.destinationAddress.trim(),
      destinationPort: Number(form.destinationPort),
      description: form.description.trim() || undefined,
      autoStart: form.autoStart,
    }
    try {
      if (forward) await updatePortForward(forward.id, record)
      else await createPortForward(record)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save forward')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={handleSubmit} className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">{forward ? 'Edit forward' : 'New port forward'}</h3>

        {hosts.length === 0 ? (
          <p className="text-sm text-slate-500">Save a host first — a forward tunnels through one.</p>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <label className={labelClasses} htmlFor="pf-host">Host</label>
                <select id="pf-host" className={inputClasses} value={form.hostId || hosts[0]?.id} onChange={(e) => set('hostId', e.target.value)} required>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>{h.host.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className={labelClasses} htmlFor="pf-type">Type</label>
                <select id="pf-type" className={inputClasses} value={form.type} onChange={(e) => set('type', e.target.value as 'local' | 'remote')}>
                  <option value="local">Local (this machine → remote)</option>
                  <option value="remote">Remote (remote → this machine)</option>
                </select>
              </div>
            </div>

            <p className="rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
              {form.type === 'local'
                ? 'Bind a port here and tunnel it through the host to the destination the host can reach.'
                : 'The host binds a port and tunnels connections back to a destination on this machine (e.g. xdebug on the server → your local IDE).'}
            </p>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <label className={labelClasses} htmlFor="pf-bind-addr">{form.type === 'local' ? 'Local bind address' : 'Remote bind address'}</label>
                <input id="pf-bind-addr" className={inputClasses} value={form.bindAddress} onChange={(e) => set('bindAddress', e.target.value)} placeholder="127.0.0.1" />
              </div>
              <div className="w-full sm:w-28">
                <label className={labelClasses} htmlFor="pf-bind-port">Bind port</label>
                <input id="pf-bind-port" type="number" className={inputClasses} value={form.bindPort} onChange={(e) => set('bindPort', e.target.value)} required />
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <label className={labelClasses} htmlFor="pf-dest-addr">{form.type === 'local' ? 'Destination (as the host sees it)' : 'Destination on this machine'}</label>
                <input id="pf-dest-addr" className={inputClasses} value={form.destinationAddress} onChange={(e) => set('destinationAddress', e.target.value)} placeholder="127.0.0.1" required />
              </div>
              <div className="w-full sm:w-28">
                <label className={labelClasses} htmlFor="pf-dest-port">Dest port</label>
                <input id="pf-dest-port" type="number" className={inputClasses} value={form.destinationPort} onChange={(e) => set('destinationPort', e.target.value)} required />
              </div>
            </div>

            <div>
              <label className={labelClasses} htmlFor="pf-desc">Description (optional)</label>
              <input id="pf-desc" className={inputClasses} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. xdebug" />
            </div>

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
                {forward ? 'Save changes' : 'Add forward'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

function describe(f: PortForwardRecord, host: string): string {
  const bind = `${f.bindAddress}:${f.bindPort}`
  const dest = `${f.destinationAddress}:${f.destinationPort}`
  return f.type === 'local' ? `local ${bind}  →  ${dest} · via ${host}` : `${host}:${f.bindPort}  →  local ${dest}`
}

function StatusDot({ state }: { state?: ForwardStatus['state'] }) {
  const color =
    state === 'active' ? 'bg-emerald-400' : state === 'connecting' ? 'bg-amber-400' : state === 'error' ? 'bg-red-400' : 'bg-slate-600'
  const title = state ? state[0].toUpperCase() + state.slice(1) : 'Inactive'
  return <span aria-hidden="true" title={title} className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
}
