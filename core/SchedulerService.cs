using System.Globalization;
using System.Text.RegularExpressions;
using Cronos;
using Renci.SshNet;
using Slopterm.Server.Vault;

namespace Slopterm.Server;

/// <summary>The outcome of a job's most recent run, without its (potentially large) output.</summary>
public sealed record JobRunSummary(
    DateTimeOffset StartedUtc, DateTimeOffset FinishedUtc, string Outcome, int? ExitCode, string? Error);

/// <summary>Per-job state reported to the UI. Unlike forwarding/sync status, EVERY saved job
/// appears here - "disabled" and "otherDevice" are states the UI needs to show, not absences.</summary>
public sealed record JobStatus(
    string JobId,
    string HostId,
    string State, // "waiting" | "running" | "disabled" | "otherDevice"
    DateTimeOffset? NextRunUtc,
    JobRunSummary? LastRun);

/// <summary>
/// Runs saved commands against saved hosts on a schedule. One background loop owns every job;
/// each run opens its own short-lived SSH exec channel (for an exit code, not a PTY).
/// </summary>
public sealed class SchedulerService : IDisposable
{
    private static readonly TimeSpan MaxSleep = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(1);

    private readonly VaultService _vault;
    private readonly object _lock = new();
    private readonly Dictionary<string, TrackedJob> _tracked = new();
    private readonly ManualResetEventSlim _wake = new(false);
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private bool _disposed;

    public SchedulerService(VaultService vault) => _vault = vault;

    /// <summary>Starts the scheduler loop - called once at launch, safe with a locked vault.</summary>
    public void Start()
    {
        lock (_lock)
        {
            if (_disposed || _loop is not null)
            {
                return;
            }

            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            _loop = Task.Run(() => LoopAsync(token));
        }
    }

    /// <summary>Reconcile now rather than on the next poll - called after any job record changes.</summary>
    public void Poke()
    {
        lock (_lock)
        {
            if (_disposed)
            {
                return; // _wake is gone; there's nothing left to reconcile anyway
            }

            _wake.Set();
        }
    }

    /// <summary>Runs a job immediately regardless of schedule/enabled/ownership, honouring
    /// the overlap policy so a manual run can't collide with a scheduled one.</summary>
    public void RunNow(string jobId)
    {
        var match = _vault.ListJobs().FirstOrDefault(j => j.Id == jobId);
        if (match.Record is null)
        {
            throw new InvalidOperationException("Job not found.");
        }

        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            if (!_tracked.TryGetValue(jobId, out var tracked))
            {
                // Seed the next scheduled run too, so adopting this job on the loop's next
                // pass doesn't read as "brand new" and fire a RunOnStart job a second time.
                tracked = new TrackedJob(match.UpdatedAt)
                {
                    NextRunUtc = NextRunUtcAfter(match.Record, DateTimeOffset.UtcNow),
                };
                _tracked[jobId] = tracked;
            }

            DispatchLocked(jobId, match.Record, tracked);
        }
    }

    /// <summary>Cancels a job's in-flight run (a no-op if it isn't running). The run is
    /// recorded as an "error" outcome - it produced no exit code, so it can't be a result.</summary>
    public void CancelRun(string jobId)
    {
        lock (_lock)
        {
            if (!_disposed && _tracked.TryGetValue(jobId, out var tracked))
            {
                tracked.Queued = false; // an explicit cancel shouldn't immediately re-run
                tracked.Run?.Cts.Cancel();
            }
        }
    }

    public IReadOnlyList<JobStatus> GetStatus()
    {
        var jobs = SafeListJobs();
        var deviceId = DeviceIdentity.Current;

        // Entirely in-memory: reading each job's run history off disk on every poll would mean
        // decrypting every job's full history. LastRun is seeded from disk once on adoption.
        lock (_lock)
        {
            return jobs.Select(j =>
            {
                _tracked.TryGetValue(j.Id, out var tracked);
                var state = tracked?.Run is not null ? "running"
                    : !j.Record.Enabled ? "disabled"
                    : !OwnedByThisDevice(j.Record, deviceId) ? "otherDevice"
                    : "waiting";
                return new JobStatus(j.Id, j.Record.HostId, state, tracked?.NextRunUtc, tracked?.LastRun);
            }).ToList();
        }
    }

    /// <summary>The job's most recent run as recorded on disk, so "the last run failed"
    /// survives a restart.</summary>
    private JobRunSummary? LoadLastRunSummary(string jobId)
    {
        var last = _vault.ListJobRuns(jobId).FirstOrDefault();
        return last is null
            ? null
            : new JobRunSummary(last.StartedUtc, last.FinishedUtc, last.Outcome, last.ExitCode, last.Error);
    }

    private static bool OwnedByThisDevice(JobRecord job, string deviceId) =>
        string.IsNullOrEmpty(job.OwnerDeviceId) || job.OwnerDeviceId == deviceId;

    private IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, JobRecord Record)> SafeListJobs()
    {
        if (!_vault.IsUnlocked)
        {
            return [];
        }

        try
        {
            return _vault.ListJobs();
        }
        catch
        {
            return [];
        }
    }

    private async Task LoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            TimeSpan sleep;
            try
            {
                // Reset BEFORE reconciling, so a Poke that lands while this pass is running
                // is still waiting for us below rather than being cleared and lost.
                _wake.Reset();
                sleep = Reconcile();
            }
            catch
            {
                // Nothing in Reconcile is allowed to end the scheduler - a job whose record
                // is unreadable, a clock that moved, anything. Back off one poll and retry.
                sleep = MaxSleep;
            }

            try
            {
                await _wake.WaitHandle.WaitOneAsync(sleep, token);
            }
            catch (Exception) when (token.IsCancellationRequested)
            {
                // Cancelled, or _wake was disposed out from under us by a shutdown that
                // didn't wait for this pass - either way the loop is done, quietly.
                return;
            }
        }
    }

    /// <summary>One pass: adopt/forget jobs, fire whatever's due, and report how long to sleep.</summary>
    private TimeSpan Reconcile()
    {
        var jobs = SafeListJobs();
        var deviceId = DeviceIdentity.Current;

        // Seed the last-run summary for unseen jobs OUTSIDE the lock - it reads/decrypts a
        // file, and the status endpoint takes this same lock.
        List<string> unseen;
        lock (_lock)
        {
            unseen = jobs.Where(j => !_tracked.ContainsKey(j.Id)).Select(j => j.Id).ToList();
        }

        var seeded = unseen.ToDictionary(id => id, LoadLastRunSummary);

        var now = DateTimeOffset.UtcNow;
        var nextWake = now + MaxSleep;

        lock (_lock)
        {
            if (_disposed)
            {
                return MaxSleep;
            }

            foreach (var id in _tracked.Keys.Where(id => jobs.All(j => j.Id != id)).ToList())
            {
                // Deleted (or the vault locked) - cancel anything still running for it.
                _tracked[id].Run?.Cts.Cancel();
                _tracked.Remove(id);
            }

            foreach (var (id, _, updatedAt, job) in jobs)
            {
                if (!_tracked.TryGetValue(id, out var tracked))
                {
                    tracked = new TrackedJob(updatedAt)
                    {
                        NextRunUtc = FirstRunUtc(job, now),
                        LastRun = seeded.GetValueOrDefault(id),
                    };
                    _tracked[id] = tracked;
                }
                else if (tracked.RecordUpdatedAt != updatedAt)
                {
                    // The schedule may have changed under us - recompute. Deliberately NOT
                    // FirstRunUtc: RunOnStart means "at app start", not "when edited".
                    tracked.RecordUpdatedAt = updatedAt;
                    tracked.NextRunUtc = NextRunUtcAfter(job, now);
                }

                if (tracked.Run is { Task.IsCompleted: true })
                {
                    tracked.Run.Cts.Dispose();
                    tracked.Run = null;
                }

                if (!job.Enabled || !OwnedByThisDevice(job, deviceId))
                {
                    tracked.NextRunUtc = null;
                    tracked.Queued = false;
                    continue;
                }

                // Defensive: a job that lost its next-run time without its record changing.
                // NextRunUtcAfter, not FirstRunUtc - RunOnStart only means the first pickup.
                tracked.NextRunUtc ??= NextRunUtcAfter(job, now);

                if (tracked.Queued && tracked.Run is null)
                {
                    tracked.Queued = false;
                    DispatchLocked(id, job, tracked);
                }

                if (tracked.NextRunUtc <= now)
                {
                    tracked.NextRunUtc = NextRunUtcAfter(job, now);
                    DispatchLocked(id, job, tracked);
                }

                if (tracked.NextRunUtc is { } due && due < nextWake)
                {
                    nextWake = due;
                }
            }
        }

        var sleep = nextWake - DateTimeOffset.UtcNow;
        return sleep < TimeSpan.Zero ? TimeSpan.Zero : sleep;
    }

    /// <summary>Starts a run, or applies the overlap policy if one is already going.</summary>
    private void DispatchLocked(string jobId, JobRecord job, TrackedJob tracked)
    {
        if (tracked.Run is not null)
        {
            switch (job.OverlapPolicy)
            {
                case "queue":
                    tracked.Queued = true; // at most one - a slow job can't build a backlog
                    break;
                case "kill":
                    tracked.Queued = true;
                    tracked.Run.Cts.Cancel();
                    break;
                default:
                    break; // "skip" - leave the running one alone and do nothing
            }

            return;
        }

        var cts = new CancellationTokenSource();
        var task = Task.Run(() => RunOnceAsync(jobId, job, cts.Token));
        // Whatever happens, wake the loop: it's what clears the finished run and starts a
        // queued one, and without this a "queue"/"kill" follow-up would wait for the poll.
        _ = task.ContinueWith(_ => _wake.Set(), TaskScheduler.Default);
        tracked.Run = new ActiveRun(task, cts);
    }

    private async Task RunOnceAsync(string jobId, JobRecord job, CancellationToken token)
    {
        var started = DateTimeOffset.UtcNow;
        var run = new JobRunRecord { StartedUtc = started, FinishedUtc = started, Outcome = "error" };

        try
        {
            var commandText = ResolveCommand(job);
            var request = ResolveHost(job);
            var timeout = TimeSpan.FromSeconds(Math.Clamp(job.TimeoutSeconds, 1, 86_400));

            using var runCts = CancellationTokenSource.CreateLinkedTokenSource(token);
            runCts.CancelAfter(timeout);

            using var client = new SshClient(SshConnectionInfoFactory.Create(request));
            await client.ConnectAsync(runCts.Token);
            using var command = client.CreateCommand(commandText);
            command.CommandTimeout = timeout;

            await command.ExecuteAsync(runCts.Token);
            // Result/Error drain the output streams, so read each exactly once.
            var stdout = command.Result;
            run.Output = stdout;
            run.ErrorOutput = command.Error;
            run.ExitCode = command.ExitStatus;

            if (command.ExitStatus is null && command.ExitSignal is not null)
            {
                // Killed by a signal on the remote side - it ran, and it didn't finish.
                run.Outcome = "failed";
                run.Error = $"Terminated by signal {command.ExitSignal}.";
            }
            else
            {
                var failedByPattern = MatchesFailurePattern(job, stdout, run.ErrorOutput);
                run.Outcome = command.ExitStatus is 0 && !failedByPattern ? "success" : "failed";
                if (failedByPattern)
                {
                    run.Error = "Output matched the failure pattern.";
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Either the timeout fired or someone cancelled/killed it - the caller's token
            // being cancelled is what tells the two apart.
            run.Outcome = "error";
            run.Error = token.IsCancellationRequested
                ? "Cancelled."
                : $"Timed out after {job.TimeoutSeconds}s.";
        }
        catch (Exception ex)
        {
            // Couldn't connect, no usable credential, a deleted snippet, an SSH-level
            // failure - all "it never ran", none of them allowed to escape this task.
            run.Outcome = "error";
            run.Error = ex.Message;
        }

        run.FinishedUtc = DateTimeOffset.UtcNow;
        _vault.AppendJobRun(jobId, run);

        lock (_lock)
        {
            if (_tracked.TryGetValue(jobId, out var tracked))
            {
                tracked.LastRun = new JobRunSummary(run.StartedUtc, run.FinishedUtc, run.Outcome, run.ExitCode, run.Error);
            }
        }
    }

    private static bool MatchesFailurePattern(JobRecord job, string? stdout, string? stderr)
    {
        if (string.IsNullOrEmpty(job.FailurePattern))
        {
            return false;
        }

        try
        {
            return Regex.IsMatch($"{stdout}\n{stderr}", job.FailurePattern, RegexOptions.None, RegexTimeout);
        }
        catch (Exception ex) when (ex is ArgumentException or RegexMatchTimeoutException)
        {
            // A pattern that's invalid (rejected at save time, so only reachable via a
            // record written elsewhere) or too slow must not decide the run's outcome.
            return false;
        }
    }

    private string ResolveCommand(JobRecord job)
    {
        if (!string.IsNullOrEmpty(job.SnippetId))
        {
            var snippet = _vault.ListSnippets().FirstOrDefault(s => s.Id == job.SnippetId);
            if (snippet.Record is null)
            {
                throw new InvalidOperationException("The snippet this job runs no longer exists.");
            }

            return snippet.Record.Command;
        }

        if (string.IsNullOrWhiteSpace(job.Command))
        {
            throw new InvalidOperationException("This job has no command to run.");
        }

        return job.Command;
    }

    private ConnectRequest ResolveHost(JobRecord job)
    {
        var host = _vault.ListHosts().FirstOrDefault(h => h.Id == job.HostId);
        if (host.Record is null)
        {
            throw new InvalidOperationException("The host this job runs on no longer exists.");
        }

        return HostConnect.Resolve(host.Record)
            ?? throw new InvalidOperationException("That host has no usable SSH credential.");
    }

    /// <summary>When a job first comes under the scheduler's care - app launch, creation, or
    /// vault unlock. RunOnStart skips missed windows (systemd Persistent=true convention).</summary>
    private static DateTimeOffset? FirstRunUtc(JobRecord job, DateTimeOffset now) =>
        job.RunOnStart ? now : NextRunUtcAfter(job, now);

    /// <summary>When this job should next fire, or null if a cron expression never matches.</summary>
    private static DateTimeOffset? NextRunUtcAfter(JobRecord job, DateTimeOffset now)
    {
        if (job.ScheduleKind == "cron")
        {
            return NextCronRunUtcAfter(job.CronExpression, now);
        }

        if (job.ScheduleKind == "daily")
        {
            // Local wall-clock time on purpose: "every morning at 6" means 6am where the user
            // is. The offset is taken at the target instant so DST changes don't drift the run.
            var localNow = now.ToLocalTime().DateTime;
            var candidate = localNow.Date + ParseDailyTime(job.DailyTime);
            if (candidate <= localNow)
            {
                candidate = candidate.AddDays(1);
            }

            return new DateTimeOffset(candidate, TimeZoneInfo.Local.GetUtcOffset(candidate)).ToUniversalTime();
        }

        return now + TimeSpan.FromMinutes(Math.Clamp(job.IntervalMinutes, 1, 60 * 24 * 365));
    }

    private static TimeSpan ParseDailyTime(string? value) =>
        TimeSpan.TryParseExact(value, @"hh\:mm", CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : TimeSpan.FromHours(6); // matches JobRecord.DailyTime's default

    /// <summary>The next instant a cron expression matches, in local time ("weekdays at 9"
    /// means 9am where the user is). Null if it never matches or doesn't parse.</summary>
    private static DateTimeOffset? NextCronRunUtcAfter(string? expression, DateTimeOffset now)
    {
        var parsed = TryParseCron(expression);
        return parsed?.GetNextOccurrence(now, TimeZoneInfo.Local)?.ToUniversalTime();
    }

    private static CronExpression? TryParseCron(string? expression)
    {
        if (string.IsNullOrWhiteSpace(expression))
        {
            return null;
        }

        try
        {
            // Standard 5-field cron (plus @daily/@hourly macros). Deliberately not
            // IncludeSeconds - the 6-field form silently shifts what every field means.
            return CronExpression.Parse(expression.Trim(), CronFormat.Standard);
        }
        catch (CronFormatException)
        {
            return null;
        }
    }

    /// <summary>The next <paramref name="count"/> times this job would run, for the job form's
    /// preview. Walks the same NextRunUtcAfter the loop uses so it can't drift.</summary>
    public static IReadOnlyList<DateTimeOffset> PreviewNextRuns(JobRecord job, int count)
    {
        var runs = new List<DateTimeOffset>();
        var cursor = DateTimeOffset.UtcNow;
        for (var i = 0; i < count; i++)
        {
            if (NextRunUtcAfter(job, cursor) is not { } next)
            {
                break;
            }

            runs.Add(next);
            cursor = next;
        }

        return runs;
    }

    /// <summary>Null if the expression is a usable cron schedule, otherwise the user-facing
    /// message. Shared by the save path and preview so both reject the same things.</summary>
    public static string? ValidateCronExpression(string? expression)
    {
        if (string.IsNullOrWhiteSpace(expression))
        {
            return "Enter a cron expression, e.g. 0 6 * * 1-5 for weekdays at 06:00.";
        }

        if (TryParseCron(expression) is not { } parsed)
        {
            return "That isn't a valid cron expression. Use five fields: minute hour day-of-month month day-of-week.";
        }

        // Parses fine but matches no instant that will ever arrive (30 February, say). Saving
        // it would produce a job that sits in the list looking scheduled and never runs.
        return parsed.GetNextOccurrence(DateTimeOffset.UtcNow, TimeZoneInfo.Local) is null
            ? "That expression never matches a real date, so the job would never run."
            : null;
    }

    public void Dispose()
    {
        List<TrackedJob> tracked;
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            tracked = _tracked.Values.ToList();
            _tracked.Clear();
            _cts?.Cancel();
        }

        _wake.Set();
        foreach (var job in tracked)
        {
            job.Run?.Cts.Cancel();
        }

        try
        {
            _loop?.Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
            // Best-effort - shutdown must not block on a run that won't let go.
        }

        _cts?.Dispose();
        _wake.Dispose();
    }

    private sealed class TrackedJob(DateTimeOffset recordUpdatedAt)
    {
        public DateTimeOffset RecordUpdatedAt { get; set; } = recordUpdatedAt;
        public DateTimeOffset? NextRunUtc { get; set; }
        public ActiveRun? Run { get; set; }

        // Seeded from the persisted history when the job is adopted, then kept current by
        // each finished run - so the status endpoint never has to touch the disk.
        public JobRunSummary? LastRun { get; set; }

        // A run came due while one was already going, under the "queue"/"kill" policy -
        // start it as soon as the current one is out of the way.
        public bool Queued { get; set; }
    }

    private sealed record ActiveRun(Task Task, CancellationTokenSource Cts);
}

internal static class WaitHandleExtensions
{
    /// <summary>Awaits a WaitHandle without parking a thread pool thread on it - the
    /// scheduler is idle almost all the time.</summary>
    public static async Task WaitOneAsync(this WaitHandle handle, TimeSpan timeout, CancellationToken token)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = ThreadPool.RegisterWaitForSingleObject(
            handle, (_, _) => completion.TrySetResult(), null, timeout, executeOnlyOnce: true);

        try
        {
            await using var cancellation = token.Register(() => completion.TrySetCanceled(token));
            await completion.Task;
        }
        finally
        {
            registration.Unregister(null);
        }
    }
}
