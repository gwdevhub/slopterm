# Scheduled jobs

**Status: idea only. Nothing here is implemented, and nothing here is decided.** This file
exists so the thinking isn't lost, not as a spec to build from.

Run a command against a saved host on a schedule, from slopterm, and keep the result.

The pieces are all already here: a host with credentials, snippets that are exactly
"a command worth keeping", a service layer that already owns long-lived background SSH
connections (`ForwardingService`, `SyncService`), and vault-encrypted per-record storage.
"Run this snippet against this host every morning at 6" is a small step from what exists.

Motivating cases: a nightly backup script, a cert-expiry check, disk space before it bites,
pulling a log summary before you sit down.

## The actual question: where does the schedule live?

Everything else is detail. Three answers, and they're not exclusive:

1. **In the app.** A background task per job inside the running slopterm process, exactly
   like a port forward or a sync rule. Cheapest to build and it reuses a pattern that already
   works. But a job only runs while the app is running - a laptop that was closed at 6am
   simply didn't do it, and on Android "in the background at a fixed time" is not something
   the platform reliably grants at all. Best-effort, and it has to *say* it's best-effort
   rather than quietly not running.
2. **On the host.** Write the schedule into the target's own cron/systemd timer and let the
   machine that's already up 24/7 do the work. Durable, correct, and it keeps running when
   slopterm never starts again. The costs are real though: we'd be writing into a user's
   crontab (surprising, and messy to clean up or reconcile if they edit it by hand), and
   capturing output means agreeing on a convention - a log file we later read back.
3. **Both.** In-app for "while I'm here", plus an explicit "install this on the host" action
   for the jobs that have to survive the app being closed. Probably where this lands, but it
   is two features, so it shouldn't be the first cut.

## Shape it would take (option 1, sketched)

Deliberately mirrors `ForwardingService` / `SyncService`, because a third variation on
"vault record + background loop + status endpoint + section UI" would be the odd one out:

- `JobRecord` in `jobs/{id}.json`: `HostId`, a command (or `SnippetId` - resolve the text at
  run time like startup snippets do, so editing the snippet changes the next run), schedule,
  `Enabled`, and last-run status.
- `SchedulerService` owning the timers, reusing one background `SshClient` per host across
  that host's jobs. Every loop iteration wrapped in a try/catch that can never let the loop
  die - the bug `ForwardingService`'s monitor loop actually had; don't re-learn it.
- `/api/vault/jobs` CRUD + `/api/jobs/status` + run-now/stop, and a `JobsSection` alongside
  Port Forwarding and Folder Sync.
- Runs use an SSH **exec** channel, not the interactive PTY the terminal tabs use: a job wants
  an exit code and clean stdout/stderr, not a shell prompt and escape sequences.

## Open questions

- **Where does output go?** A capped, vault-encrypted run history per job (like `ai-chats/`),
  since command output can contain anything the session could see. How much to keep, and is
  the connection log the right place for "job failed" or is that a separate stream?
- **What is failure?** Non-zero exit is the obvious answer; "output matched this pattern"
  is the one people actually ask for next.
- **Notifications.** The app badge and tray already exist. Does a failed job deserve a
  desktop notification, and what does that mean on Android?
- **Catch-up.** The app was closed for two days: does a daily job run once on startup, or
  skip to the next scheduled time? (Skip is the safer default; `systemd`'s `Persistent=true`
  is the other convention and people expect it.)
- **Overlap.** A run still going when the next one is due - skip, queue, or kill?
- **Schedule format.** A cron expression is familiar but needs a parser (a small one, hand
  rolled - the dependency rule) and drags in timezone/DST questions. A plain interval avoids
  all of that and covers most of the cases.
- **Two devices, one job.** Once vault sync exists, the same job record lives on the laptop
  *and* the phone, and both could fire it. Needs an owner-device flag or a lease in the synced
  record - worth deciding before jobs and sync ship together, not after someone's backup
  script runs twice.

## Non-goals for a first cut

Job chaining/dependencies, output parsing into structured results, per-job notification
routing, and running against a whole group of hosts at once. All reasonable later; none of
them are what makes the feature useful on day one.
