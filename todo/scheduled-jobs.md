# Scheduled jobs

**Status: shipped (option 1, in-app).** The Scheduled Jobs section runs a saved command
against a saved host on a schedule and keeps the result. This file is now the record of
which questions got answered which way, and what's deliberately still open.

Backend: `core/SchedulerService.cs`, `JobRecord`/`JobRunRecord` in `core/Vault/VaultModels.cs`.
Frontend: `web/src/components/JobsSection.tsx`. Covered end-to-end by
`e2e/tests/scheduled-jobs.spec.ts`, which runs a real job against the disposable sshd and
asserts its actual stdout comes back.

## Where the schedule lives

**In the app** (option 1 of the three below), and it says so: the section leads with a line
telling you a job only runs while slopterm is open. That was the whole condition on picking
this option - best-effort is fine, quietly not running is not.

1. **In the app.** ← shipped. A single background loop inside the running slopterm process.
   Cheapest to build, and a job is idle between runs by definition, so there was nothing
   per-job to keep alive. But a job only runs while the app is running - a laptop that was
   closed at 6am simply didn't do it, and on Android "in the background at a fixed time" is
   not something the platform reliably grants at all.
2. **On the host.** Write the schedule into the target's own cron/systemd timer. Still not
   built, still the right answer for a job that has to survive the app being closed - the
   section's banner points at it in words. The costs that kept it out of the first cut are
   unchanged: writing into a user's crontab is surprising and messy to reconcile if they
   edit it by hand, and capturing output means agreeing on a log-file convention.
3. **Both.** Where this still probably lands. It's two features; this was the first one.

## What it actually does

- `JobRecord` in `jobs/{id}.json`: `HostId`, a command **or** a `SnippetId` (resolved at run
  time like startup snippets, so editing the snippet changes the next run), the schedule,
  `Enabled`, and the answers to the questions below.
- `SchedulerService` owns ONE loop for every job rather than a task per job the way
  `ForwardingService`/`SyncService` do - there's no per-job connection to keep alive, and a
  single loop is the only place that has to know what's due next. Every iteration is wrapped
  so it can never die: the bug `ForwardingService`'s monitor loop actually had, not
  re-learned.
- The loop **re-reads the job records every pass** instead of being told about changes. So
  there's no start/stop call at all (enabling a job is a plain record edit), live state can't
  drift from what's saved, and a locked vault is just a pass that finds no jobs - jobs start
  on their own within one poll of an unlock, with no unlock hook anywhere.
- `/api/vault/jobs` CRUD + `/api/jobs/status` + `/api/jobs/{id}/run|cancel|runs`, and a
  `JobsSection` alongside Port Forwarding and Folder Sync.
- Runs use an SSH **exec** channel, not the interactive PTY the terminal tabs use: a job
  wants an exit code and clean stdout/stderr, not a shell prompt and escape sequences.
- Each run opens its own connection and closes it again — deliberately *not* the sketch's
  shared per-host `SshClient`. An hourly (or nightly) job would otherwise hold an idle
  connection open between runs purely to save a handshake, and inherit the whole "did this
  connection die while we weren't looking" retry problem for nothing.

## The open questions, answered

- **Where does output go?** A capped, vault-encrypted run history per job
  (`job-runs/{jobId}.json`, newest first): 20 runs, 8 000 characters of output each, with a
  "truncated" flag rather than a silent cut. Vault-encrypted because command output can
  contain anything the session could see. It is **not** in the connection log: that's a
  connection log (connected/failed/disconnected) and a wall of command output would drown it.
  A job's history is its own stream, reachable from the card.
- **What is failure?** Non-zero exit, plus the thing people ask for immediately afterwards:
  an optional `FailurePattern` regex matched against the run's output, where a match marks
  the run failed even if it exited 0. A third outcome, `error`, is for "it never ran to
  completion at all" - couldn't connect, no credential, timed out, cancelled - because that
  isn't the command saying no, and conflating the two makes both less useful.
- **Notifications.** The card shows the state (a red dot once the last run failed, amber
  while one is in flight) and the history modal has the detail. No desktop notification and
  no tray change: on Android that machinery doesn't reliably exist anyway, and the section is
  where you'd go to act on it. If this proves too quiet, the Settings dot pattern in
  `Sidebar.tsx` is the cheap next step.
- **Catch-up.** Skip, per-job overridable. A schedule that came due while the app was closed
  is simply skipped and the next run is the next scheduled time - nobody wants two days of
  missed backups firing at once on launch. `RunOnStart` opts into systemd's `Persistent=true`
  convention for the people who do expect the missed run to still happen.
- **Overlap.** All three, per job: `skip` (default - leave the running one alone), `queue`
  (start the next one the moment it finishes, at most one queued so a slow job can't build a
  backlog), or `kill` (cancel the running one and start fresh).
- **Schedule format.** Three kinds: "every N minutes", "daily at HH:mm local", and cron.
  The first cut deliberately left cron out on the grounds that a parser would have to be
  hand-rolled; that reasoning didn't survive contact with the gap it left. There is no way to
  say "weekdays at 09:00" or "every 15 minutes on the quarter hour" with the other two - and
  `intervalMinutes` is measured from the last run, so it drifts and re-anchors on every edit,
  meaning "every hour *on the hour*" wasn't expressible at all. Cron went in via **Cronos**
  (small, no transitive deps, netstandard2.0 so Android takes it): the DST rules alone are
  worth not hand-rolling, and the "no dependencies" premise was never a real rule here -
  SSH.NET and Argon2 predate it. The two simple kinds stay, because cron can't express them
  either: there is no cron for "every 90 minutes".
  Daily takes its UTC offset at the *target* instant, so the runs either side of a DST change
  still land at 6am local; Cronos does the equivalent for cron, firing a skipped
  spring-forward time at the jump and the repeated autumn hour once.
- **Checking a schedule before saving it.** `POST /api/jobs/schedule-preview` returns the next
  three real instants for an unsaved schedule, walking the same `NextRunUtcAfter` the loop
  uses so the preview can't promise something the scheduler won't do. This is the answer to
  "does this cron expression mean what I think": the form shows those three times live under
  the field, and links to crontab.guru for the people who'd rather read it in English.
- **Two devices, one job.** An owner-device flag: `OwnerDeviceId`, matched against a stable
  per-install id (`DeviceIdentity`, kept as plain text in the vault directory - it identifies
  a machine, not a person). **New jobs pin to the creating device by default**, so the moment
  vault sync lands, a synced backup script doesn't start running on the phone too. Unpinning
  is a checkbox. The id is never packaged into an exported backup (restoring onto a second
  machine must produce a second identity) but *is* preserved across import/reset on the same
  machine, so restoring your own backup doesn't strand every job you pinned.

## Non-goals, still

Job chaining/dependencies, output parsing into structured results, per-job notification
routing, and running against a whole group of hosts at once. All reasonable later; none of
them are what makes the feature useful on day one.
