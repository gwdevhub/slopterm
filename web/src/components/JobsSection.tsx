import { useEffect, useState, type FormEvent } from 'react'
import {
  cancelJobRun,
  clearJobRuns,
  createJob,
  deleteJob,
  getDeviceId,
  getJobStatus,
  listHosts,
  listJobRuns,
  listJobs,
  listSnippets,
  previewSchedule,
  runJobNow,
  updateJob,
  type JobRecord,
  type JobRun,
  type JobStatus,
  type SavedHost,
  type SavedJob,
  type SavedSnippet,
  type SchedulePreview,
} from '../lib/api'
import { VaultGate } from './VaultGate'
import { CardGrid, EntityCard, cardPrimaryButton, cardSecondaryButton } from './CardGrid'
import { JobsIcon } from './icons'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'
const labelClasses = 'mb-1 block text-xs font-medium text-slate-400'

// Runs a saved command against a saved host on a schedule (backend SchedulerService). Same
// card-grid layout as Port Forwarding / Folder Sync. The banner is not decoration: the
// schedule lives in this app, so a job genuinely does not run while slopterm is closed, and
// the one thing worse than that limitation is not saying so.
export function JobsSection() {
  return (
    <VaultGate>
      <JobList />
    </VaultGate>
  )
}

function JobList() {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [jobs, setJobs] = useState<SavedJob[]>([])
  const [status, setStatus] = useState<JobStatus[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SavedJob | 'new' | null>(null)
  const [historyFor, setHistoryFor] = useState<SavedJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    refreshRecords()
    getDeviceId().then(setDeviceId).catch(() => {})
  }, [])

  // Poll live state so Running/Waiting, the next run time and the last outcome stay current
  // without a manual reload - a job firing in the background should just appear.
  useEffect(() => {
    let alive = true
    const tick = () => getJobStatus().then((s) => alive && setStatus(s)).catch(() => {})
    tick()
    const interval = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [])

  function refreshRecords() {
    listHosts().then(setHosts)
    listSnippets().then(setSnippets)
    listJobs().then(setJobs)
    getJobStatus().then(setStatus).catch(() => {})
  }

  const hostName = (id: string) => hosts.find((h) => h.id === id)?.host.name ?? '(unknown host)'
  const statusOf = (jobId: string) => status.find((s) => s.jobId === jobId)

  function refreshStatusSoon() {
    setTimeout(() => getJobStatus().then(setStatus).catch(() => {}), 300)
  }

  async function handleDelete(id: string) {
    await deleteJob(id)
    refreshRecords()
  }

  async function handleRunOrCancel(job: SavedJob) {
    setError(null)
    try {
      if (statusOf(job.id)?.state === 'running') await cancelJobRun(job.id)
      else await runJobNow(job.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run job')
    }
    refreshStatusSoon()
  }

  // The enable/disable toggle is a plain record edit - the scheduler picks the change up
  // itself, so there's no separate start/stop call the way forwarding rules have.
  async function handleToggleEnabled(job: SavedJob) {
    setError(null)
    try {
      await updateJob(job.id, { ...job.job, enabled: !job.job.enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update job')
    }
    refreshRecords()
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? jobs.filter(
        (j) =>
          j.job.name.toLowerCase().includes(q) ||
          (j.job.command ?? '').toLowerCase().includes(q) ||
          hostName(j.job.hostId).toLowerCase().includes(q),
      )
    : jobs

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <p className="mx-3 mt-3 rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400 sm:mx-4">
          Jobs only run while slopterm is open — a schedule that comes due with the app closed is
          skipped, not caught up later (turn on “Run once at startup” per job to change that). For a
          schedule that has to survive the app being closed, use the host's own cron.
        </p>
        {error && <p className="mx-3 mt-3 text-sm text-red-400 sm:mx-4">{error}</p>}
        <CardGrid
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Find a job…"
          newLabel="New job"
          onNew={() => setEditing('new')}
          isEmpty={filtered.length === 0}
          emptyText={jobs.length === 0 ? 'No scheduled jobs yet.' : 'No jobs match your search.'}
        >
          {filtered.map((j) => {
            const st = statusOf(j.id)
            const running = st?.state === 'running'
            const snippetName = snippets.find((s) => s.id === j.job.snippetId)?.snippet.name
            return (
              <EntityCard
                key={j.id}
                icon={<JobsIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />}
                title={
                  <>
                    <StatusDot status={st} />
                    <span className="truncate font-medium text-slate-100">{j.job.name}</span>
                    {!j.job.enabled && (
                      <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                        Off
                      </span>
                    )}
                  </>
                }
                subtitle={
                  <span className="font-mono" title={snippetName ?? j.job.command ?? ''}>
                    {snippetName ? `snippet: ${snippetName}` : j.job.command}
                  </span>
                }
                extra={
                  <div className="w-full min-w-0 text-xs text-slate-500">
                    <p className="truncate">
                      {describeSchedule(j.job)} on {hostName(j.job.hostId)}
                    </p>
                    <p className="truncate">{describeStatus(st, deviceId, j.job)}</p>
                  </div>
                }
                actions={
                  <>
                    <button type="button" onClick={() => handleRunOrCancel(j)} className={running ? cardSecondaryButton : cardPrimaryButton}>
                      {running ? 'Cancel' : 'Run now'}
                    </button>
                    <button type="button" onClick={() => setHistoryFor(j)} className={cardSecondaryButton}>
                      History
                    </button>
                    <button type="button" onClick={() => handleToggleEnabled(j)} className={cardSecondaryButton}>
                      {j.job.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button type="button" onClick={() => setEditing(j)} className={cardSecondaryButton}>
                      Edit
                    </button>
                    <button type="button" onClick={() => handleDelete(j.id)} className={cardSecondaryButton}>
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
        <JobModal
          job={editing === 'new' ? null : editing}
          hosts={hosts}
          snippets={snippets}
          deviceId={deviceId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refreshRecords()
          }}
        />
      )}

      {historyFor && <JobHistoryModal job={historyFor} onClose={() => setHistoryFor(null)} />}
    </>
  )
}

interface FormState {
  hostId: string
  name: string
  source: 'command' | 'snippet'
  command: string
  snippetId: string
  scheduleKind: JobRecord['scheduleKind']
  intervalMinutes: number
  dailyTime: string
  cronExpression: string
  enabled: boolean
  runOnStart: boolean
  overlapPolicy: JobRecord['overlapPolicy']
  timeoutSeconds: number
  failurePattern: string
  pinToDevice: boolean
}

function JobModal({
  job,
  hosts,
  snippets,
  deviceId,
  onClose,
  onSaved,
}: {
  job: SavedJob | null
  hosts: SavedHost[]
  snippets: SavedSnippet[]
  deviceId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => ({
    hostId: job?.job.hostId ?? hosts[0]?.id ?? '',
    name: job?.job.name ?? '',
    source: job?.job.snippetId ? 'snippet' : 'command',
    command: job?.job.command ?? '',
    snippetId: job?.job.snippetId ?? snippets[0]?.id ?? '',
    scheduleKind: job?.job.scheduleKind ?? 'interval',
    intervalMinutes: job?.job.intervalMinutes ?? 60,
    dailyTime: job?.job.dailyTime ?? '06:00',
    cronExpression: job?.job.cronExpression ?? '0 6 * * *',
    enabled: job?.job.enabled ?? true,
    runOnStart: job?.job.runOnStart ?? false,
    overlapPolicy: job?.job.overlapPolicy ?? 'skip',
    timeoutSeconds: job?.job.timeoutSeconds ?? 300,
    failurePattern: job?.job.failurePattern ?? '',
    // New jobs pin to this device by default: once the vault syncs, an unpinned nightly
    // backup would run on every device that has the record, not just the one you made it on.
    pinToDevice: job ? Boolean(job.job.ownerDeviceId) : true,
  }))
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // Keep whichever device already owns the job when editing (it might not be this one) -
  // only a brand-new pin, or unpinning, should change ownership.
  const ownerDeviceId = form.pinToDevice ? (job?.job.ownerDeviceId ?? deviceId ?? undefined) : null

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const record: JobRecord = {
      hostId: form.hostId || hosts[0]?.id || '',
      name: form.name.trim(),
      command: form.source === 'command' ? form.command.trim() : undefined,
      snippetId: form.source === 'snippet' ? form.snippetId : undefined,
      scheduleKind: form.scheduleKind,
      intervalMinutes: Number(form.intervalMinutes) || 60,
      dailyTime: form.dailyTime,
      cronExpression: form.scheduleKind === 'cron' ? form.cronExpression.trim() : undefined,
      enabled: form.enabled,
      runOnStart: form.runOnStart,
      overlapPolicy: form.overlapPolicy,
      timeoutSeconds: Number(form.timeoutSeconds) || 300,
      failurePattern: form.failurePattern.trim() || undefined,
      ownerDeviceId,
    }
    try {
      if (job) await updateJob(job.id, record)
      else await createJob(record)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save job')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={handleSubmit} className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">{job ? 'Edit job' : 'New job'}</h3>

        {hosts.length === 0 ? (
          <p className="text-sm text-slate-500">Save a host first — a job runs a command on one over SSH.</p>
        ) : (
          <>
            <div>
              <label className={labelClasses} htmlFor="job-name">Name</label>
              <input id="job-name" className={inputClasses} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. nightly backup" required />
            </div>

            <div>
              <label className={labelClasses} htmlFor="job-host">Host</label>
              <select id="job-host" className={inputClasses} value={form.hostId || hosts[0]?.id} onChange={(e) => set('hostId', e.target.value)} required>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>{h.host.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClasses} htmlFor="job-source">Runs</label>
              <select id="job-source" className={inputClasses} value={form.source} onChange={(e) => set('source', e.target.value as FormState['source'])}>
                <option value="command">A command</option>
                <option value="snippet" disabled={snippets.length === 0}>
                  {snippets.length === 0 ? 'A snippet (none saved yet)' : 'A snippet'}
                </option>
              </select>
            </div>

            {form.source === 'command' ? (
              <div>
                <label className={labelClasses} htmlFor="job-command">Command</label>
                <textarea id="job-command" className={`${inputClasses} font-mono`} rows={2} value={form.command} onChange={(e) => set('command', e.target.value)} placeholder="df -h /" required />
              </div>
            ) : (
              <div>
                <label className={labelClasses} htmlFor="job-snippet">Snippet</label>
                <select id="job-snippet" className={inputClasses} value={form.snippetId} onChange={(e) => set('snippetId', e.target.value)} required>
                  {snippets.map((s) => (
                    <option key={s.id} value={s.id}>{s.snippet.name}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">Resolved when the job runs, so editing the snippet changes the next run.</p>
              </div>
            )}

            <div>
              <label className={labelClasses} htmlFor="job-schedule">Schedule</label>
              <select id="job-schedule" className={inputClasses} value={form.scheduleKind} onChange={(e) => set('scheduleKind', e.target.value as FormState['scheduleKind'])}>
                <option value="interval">Every N minutes</option>
                <option value="daily">Once a day, at a set time</option>
                <option value="cron">On a cron expression</option>
              </select>
            </div>

            {form.scheduleKind === 'interval' && (
              <div>
                <label className={labelClasses} htmlFor="job-interval">Interval (minutes)</label>
                <input id="job-interval" type="number" min={1} className={inputClasses} value={form.intervalMinutes} onChange={(e) => set('intervalMinutes', Number(e.target.value))} required />
              </div>
            )}

            {form.scheduleKind === 'daily' && (
              <div>
                <label className={labelClasses} htmlFor="job-daily-time">Time (24-hour, this machine's local time)</label>
                <input id="job-daily-time" className={inputClasses} value={form.dailyTime} onChange={(e) => set('dailyTime', e.target.value)} placeholder="06:00" pattern="[0-2][0-9]:[0-5][0-9]" required />
              </div>
            )}

            {form.scheduleKind === 'cron' && (
              <div>
                <label className={labelClasses} htmlFor="job-cron">Cron expression (this machine's local time)</label>
                <input id="job-cron" className={`${inputClasses} font-mono`} value={form.cronExpression} onChange={(e) => set('cronExpression', e.target.value)} placeholder="0 6 * * 1-5" required />
                <p className="mt-1 text-xs text-slate-500">
                  Five fields: minute hour day-of-month month day-of-week. Need a hand?{' '}
                  {/* Opens in the user's browser, not this window - the app is otherwise
                      entirely local, and nothing here depends on the site being reachable. */}
                  <a href="https://crontab.guru/" target="_blank" rel="noreferrer noopener" className="text-indigo-400 underline hover:text-indigo-300">
                    crontab.guru
                  </a>{' '}
                  explains one in English.
                </p>
              </div>
            )}

            <SchedulePreviewLine
              scheduleKind={form.scheduleKind}
              intervalMinutes={form.intervalMinutes}
              dailyTime={form.dailyTime}
              cronExpression={form.cronExpression}
            />

            <div>
              <label className={labelClasses} htmlFor="job-timeout">Timeout (seconds)</label>
              <input id="job-timeout" type="number" min={1} className={inputClasses} value={form.timeoutSeconds} onChange={(e) => set('timeoutSeconds', Number(e.target.value))} required />
            </div>

            <div>
              <label className={labelClasses} htmlFor="job-overlap">If the previous run is still going</label>
              <select id="job-overlap" className={inputClasses} value={form.overlapPolicy} onChange={(e) => set('overlapPolicy', e.target.value as FormState['overlapPolicy'])}>
                <option value="skip">Skip this run</option>
                <option value="queue">Run it as soon as the current one finishes</option>
                <option value="kill">Cancel the running one and start over</option>
              </select>
            </div>

            <div>
              <label className={labelClasses} htmlFor="job-failure-pattern">Failure pattern (optional regex)</label>
              <input id="job-failure-pattern" className={`${inputClasses} font-mono`} value={form.failurePattern} onChange={(e) => set('failurePattern', e.target.value)} placeholder="e.g. ERROR|FATAL" />
              <p className="mt-1 text-xs text-slate-500">Matched against the run's output. A match marks the run failed even if it exited 0.</p>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Enabled (run on this schedule)
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.runOnStart} onChange={(e) => set('runOnStart', e.target.checked)} />
              Run once at startup (catch up a run missed while slopterm was closed)
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.pinToDevice} onChange={(e) => set('pinToDevice', e.target.checked)} />
              Only run on this device (off = every synced device runs it)
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
                Cancel
              </button>
              <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
                {job ? 'Save changes' : 'Add job'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

// The job's own output stream. Deliberately not folded into the Logs section: that's a
// connection log (connected/failed/disconnected), and a wall of command output would drown
// it - see todo/scheduled-jobs.md.
function JobHistoryModal({ job, onClose }: { job: SavedJob; onClose: () => void }) {
  const [runs, setRuns] = useState<JobRun[] | null>(null)
  const [expanded, setExpanded] = useState<number | null>(0)

  useEffect(() => {
    let alive = true
    const tick = () => listJobRuns(job.id).then((r) => alive && setRuns(r)).catch(() => alive && setRuns([]))
    tick()
    // A run started from the card is usually still going when history is opened - poll so
    // it appears when it lands instead of needing the modal reopened.
    const interval = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [job.id])

  async function handleClear() {
    await clearJobRuns(job.id)
    setRuns([])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${job.job.name} — run history`}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded border border-slate-700 bg-slate-900 p-5"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate font-semibold text-slate-100">{job.job.name} — run history</h3>
          <span className="shrink-0 text-xs text-slate-500">
            last {runs?.length ?? 0} {runs?.length === 1 ? 'run' : 'runs'}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {runs === null && <p className="text-sm text-slate-500">Loading…</p>}
          {runs?.length === 0 && <p className="text-sm text-slate-500">This job hasn't run yet.</p>}
          {runs?.map((run, index) => (
            <div key={`${run.startedUtc}-${index}`} className="rounded border border-slate-800 bg-slate-900/60">
              <button
                type="button"
                onClick={() => setExpanded(expanded === index ? null : index)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800/50"
              >
                <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${outcomeColor(run.outcome)}`} />
                <span className="text-slate-200 capitalize">{run.outcome}</span>
                <span className="truncate text-xs text-slate-500">
                  {new Date(run.startedUtc).toLocaleString()} · {formatDuration(run)}
                  {run.exitCode !== null && run.exitCode !== undefined && ` · exit ${run.exitCode}`}
                </span>
              </button>
              {expanded === index && (
                <div className="border-t border-slate-800 px-3 py-2">
                  {run.error && <p className="mb-2 text-xs text-red-400">{run.error}</p>}
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-slate-300">
                    {run.output || run.errorOutput ? `${run.output ?? ''}${run.errorOutput ?? ''}` : '(no output)'}
                  </pre>
                  {run.truncated && <p className="mt-1 text-xs text-slate-500">Output was truncated.</p>}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={handleClear} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
            Clear history
          </button>
          <button type="button" onClick={onClose} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function describeSchedule(job: JobRecord): string {
  // Cron shows the expression verbatim rather than a prose translation: rendering one in
  // English is a whole library's worth of work, and a wrong summary on the card is worse
  // than the expression the user typed and can read back.
  if (job.scheduleKind === 'cron') return job.cronExpression ?? 'Cron'
  if (job.scheduleKind === 'daily') return `Daily at ${job.dailyTime}`
  const m = job.intervalMinutes
  if (m % 60 === 0 && m >= 60) return `Every ${m / 60}h`
  return `Every ${m}m`
}

// The next three times the schedule in the form would actually fire, resolved by the backend
// (the same code the scheduler runs on) so a cron expression can be checked before saving
// rather than by waiting to see whether anything happens. Debounced because it re-runs on
// every keystroke in the cron field.
function SchedulePreviewLine(schedule: Pick<JobRecord, 'scheduleKind' | 'intervalMinutes' | 'dailyTime' | 'cronExpression'>) {
  const [preview, setPreview] = useState<SchedulePreview | null>(null)
  const { scheduleKind, intervalMinutes, dailyTime, cronExpression } = schedule

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      previewSchedule({ scheduleKind, intervalMinutes, dailyTime, cronExpression })
        .then((result) => !cancelled && setPreview(result))
        // A preview is a nicety - a failed fetch just leaves the line blank rather than
        // putting an error in front of a form the user can still submit.
        .catch(() => !cancelled && setPreview(null))
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scheduleKind, intervalMinutes, dailyTime, cronExpression])

  if (!preview) return null
  if (preview.error) return <p className="text-xs text-amber-400">{preview.error}</p>
  if (preview.runs.length === 0) return null

  return (
    <p className="text-xs text-slate-500">
      Next runs: {preview.runs.map((r) => new Date(r).toLocaleString()).join(' · ')}
    </p>
  )
}

function describeStatus(status: JobStatus | undefined, deviceId: string | null, job: JobRecord): string {
  if (!status) return ''
  if (status.state === 'running') return 'Running now…'
  if (status.state === 'otherDevice') {
    return deviceId && job.ownerDeviceId !== deviceId ? 'Pinned to another device' : 'Not scheduled here'
  }

  const last = status.lastRun
  const lastText = last ? `Last ${last.outcome} ${new Date(last.startedUtc).toLocaleString()}` : 'Never run'
  if (status.state === 'disabled') return `Disabled · ${lastText}`
  return status.nextRunUtc ? `Next ${new Date(status.nextRunUtc).toLocaleString()} · ${lastText}` : lastText
}

function outcomeColor(outcome: JobRun['outcome']): string {
  return outcome === 'success' ? 'bg-emerald-400' : outcome === 'failed' ? 'bg-red-400' : 'bg-amber-400'
}

function formatDuration(run: JobRun): string {
  const ms = new Date(run.finishedUtc).getTime() - new Date(run.startedUtc).getTime()
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

// Green while scheduled and last successful, red once the last run failed, amber while a run
// is in flight, grey when the job isn't scheduled here at all.
function StatusDot({ status }: { status?: JobStatus }) {
  const color =
    status?.state === 'running'
      ? 'bg-amber-400'
      : status?.state === 'waiting'
        ? status.lastRun && status.lastRun.outcome !== 'success'
          ? 'bg-red-400'
          : 'bg-emerald-400'
        : 'bg-slate-600'
  const title = status ? status.state[0].toUpperCase() + status.state.slice(1) : 'Unknown'
  return <span aria-hidden="true" title={title} className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
}
