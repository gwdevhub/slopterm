using System.Collections.Concurrent;
using Renci.SshNet;
using Slopterm.Server.Vault;

namespace Slopterm.Server;

/// <summary>Per-rule sync state reported to the UI.</summary>
public sealed record SyncStatus(string RuleId, string HostId, string State, string? Error, DateTimeOffset? LastSyncUtc);

/// <summary>
/// Owns folder sync rules. Each rule gets its own dedicated background worker: a retrying
/// SftpClient connection to the rule's host, plus (depending on Direction) a
/// FileSystemWatcher on the local folder to push local changes out and/or a periodic remote
/// directory listing to pull remote changes in - SFTP has no push/notify, so the remote side
/// can only ever be polled, never truly watched. A file that changes on both sides between
/// passes in "twoWay" mode is resolved by whichever side's modified time is newer - simple
/// last-writer-wins, not real conflict/version handling.
///
/// Same "outlives the tab, AutoStart rules come up at launch" shape as ForwardingService,
/// and the same monitor-loop lesson learned there: every iteration is guarded so a single
/// unexpected failure (including SSH.NET's IsConnected throwing once a session has died) can
/// never permanently end the retry loop.
/// </summary>
public sealed class SyncService : IDisposable
{
    private readonly VaultService _vault;
    private readonly object _lock = new();
    private readonly Dictionary<string, RuleSync> _rules = new(); // key: ruleId
    private bool _disposed;

    public SyncService(VaultService vault) => _vault = vault;

    /// <summary>Starts every AutoStart rule - called once at launch. No-op if the vault is locked.</summary>
    public void StartAutoSyncs()
    {
        foreach (var id in SafeListRules(r => r.AutoStart))
        {
            TryStart(id);
        }
    }

    public void StartRule(string ruleId)
    {
        var (rule, request) = ResolveRule(ruleId);
        RuleSync sync;
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            if (_rules.Remove(ruleId, out var existing))
            {
                existing.Dispose();
            }

            sync = new RuleSync(ruleId, rule);
            _rules[ruleId] = sync;
        }

        sync.Start(request);
    }

    public void StopRule(string ruleId)
    {
        RuleSync? sync;
        lock (_lock)
        {
            if (!_rules.Remove(ruleId, out sync))
            {
                return;
            }
        }

        sync.Dispose();
    }

    public IReadOnlyList<SyncStatus> GetStatus()
    {
        List<RuleSync> rules;
        lock (_lock)
        {
            rules = _rules.Values.ToList();
        }

        return rules.Select(r => r.GetStatus()).ToList();
    }

    private void TryStart(string ruleId)
    {
        try
        {
            StartRule(ruleId);
        }
        catch
        {
            // Best-effort per rule - a missing host/credential for one rule must never stop
            // the others or crash launch. The failure is visible in GetStatus once started.
        }
    }

    private IReadOnlyList<string> SafeListRules(Func<SyncRuleRecord, bool> predicate)
    {
        if (!_vault.IsUnlocked)
        {
            return [];
        }

        try
        {
            return _vault.ListSyncRules().Where(r => predicate(r.Record)).Select(r => r.Id).ToList();
        }
        catch
        {
            return [];
        }
    }

    private (SyncRuleRecord Rule, ConnectRequest Request) ResolveRule(string ruleId)
    {
        var match = _vault.ListSyncRules().FirstOrDefault(r => r.Id == ruleId);
        if (match.Record is null)
        {
            throw new InvalidOperationException("Sync rule not found.");
        }

        var host = _vault.ListHosts().FirstOrDefault(h => h.Id == match.Record.HostId);
        if (host.Record is null)
        {
            throw new InvalidOperationException("The host this sync rule uses no longer exists.");
        }

        var request = HostConnect.Resolve(host.Record)
            ?? throw new InvalidOperationException("That host has no usable SSH credential.");
        return (match.Record, request);
    }

    public void Dispose()
    {
        List<RuleSync> rules;
        lock (_lock)
        {
            _disposed = true;
            rules = _rules.Values.ToList();
            _rules.Clear();
        }

        foreach (var rule in rules)
        {
            rule.Dispose();
        }
    }

    /// <summary>One rule's watcher/poller + SFTP connection + retry loop.</summary>
    private sealed class RuleSync(string ruleId, SyncRuleRecord rule) : IDisposable
    {
        private static readonly TimeSpan RemotePollInterval = TimeSpan.FromSeconds(5);

        private readonly ConcurrentQueue<(string RelativePath, bool Deleted)> _pending = new();
        private readonly HashSet<string> _knownRemoteDirs = new();
        private readonly ManualResetEventSlim _wake = new(false);
        private ConnectRequest _request = null!;
        private SftpClient? _client;
        private FileSystemWatcher? _watcher;
        private CancellationTokenSource? _cts;
        private Task? _monitor;
        private volatile string _state = "connecting"; // connecting | active | error
        private volatile string? _error;
        // Not volatile - DateTimeOffset? isn't a valid volatile field type. Status-display
        // only, so a reader briefly seeing a slightly stale value is harmless.
        private DateTimeOffset? _lastSyncUtc;
        // Snapshot from the last remote poll (remoteToLocal/twoWay only) - diffed against the
        // next poll's listing to notice files removed on the remote side, the same way a
        // Deleted FileSystemWatcher event does for the local side.
        private Dictionary<string, (long Size, DateTime ModifiedUtc)> _knownRemoteEntries = new();
        private DateTimeOffset _nextRemotePollUtc;

        private bool PushLocal => rule.Direction is "localToRemote" or "twoWay";
        private bool PullRemote => rule.Direction is "remoteToLocal" or "twoWay";

        public void Start(ConnectRequest request)
        {
            _request = request;
            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            _monitor = Task.Run(() => MonitorLoop(token));
        }

        public SyncStatus GetStatus() => new(ruleId, rule.HostId, _state, _error, _lastSyncUtc);

        private void MonitorLoop(CancellationToken token)
        {
            var backoff = TimeSpan.FromSeconds(2);
            while (!token.IsCancellationRequested)
            {
                try
                {
                    RunIteration(token, ref backoff);
                }
                catch (Exception ex) when (!token.IsCancellationRequested)
                {
                    // Anything unexpected here (a missing local folder, a dropped connection
                    // surfacing through some other call, IsConnected itself throwing) must
                    // never end this loop - see ForwardingService's own history with exactly
                    // this failure mode.
                    SetError(ex.Message);
                    TearDown();
                    Wait(token, backoff);
                    backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 1.5, 30));
                }
            }

            TearDown();
        }

        private void RunIteration(CancellationToken token, ref TimeSpan backoff)
        {
            if (_client is not { IsConnected: true })
            {
                SftpClient? fresh = null;
                try
                {
                    fresh = new SftpClient(SshConnectionInfoFactory.Create(_request))
                    {
                        KeepAliveInterval = TimeSpan.FromSeconds(30),
                    };
                    fresh.Connect();
                }
                catch (Exception ex)
                {
                    fresh?.Dispose();
                    SetError(ex.Message);
                    Wait(token, backoff);
                    backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 1.5, 30));
                    return;
                }

                StopWatcher();
                _client = fresh;
                _knownRemoteDirs.Clear();
                _knownRemoteEntries.Clear();
                EnsureRoots();
                if (PushLocal)
                {
                    RunInitialLocalScan(token);
                    StartWatcher();
                }

                if (PullRemote)
                {
                    PollRemote(token);
                }

                _nextRemotePollUtc = DateTimeOffset.UtcNow + RemotePollInterval;
                _state = "active";
                _error = null;
                backoff = TimeSpan.FromSeconds(2);
            }

            if (PushLocal)
            {
                DrainPendingEvents();
            }

            if (PullRemote && DateTimeOffset.UtcNow >= _nextRemotePollUtc)
            {
                PollRemote(token);
                _nextRemotePollUtc = DateTimeOffset.UtcNow + RemotePollInterval;
            }

            _wake.Wait(TimeSpan.FromMilliseconds(500), token);
            _wake.Reset();
        }

        // Local folder is the source when pushing (must already exist - an auto-created empty
        // folder would just silently sync nothing, masking a typo) and the destination when
        // only pulling (created on demand, same as EnsureRemoteDir does for a push destination).
        // Remote folder is the mirror image: destination when pushing (created on demand),
        // source when only pulling (must already exist - nothing to pull from otherwise).
        private void EnsureRoots()
        {
            if (PushLocal && !Directory.Exists(rule.LocalPath))
            {
                throw new DirectoryNotFoundException($"Local folder not found: {rule.LocalPath}");
            }

            Directory.CreateDirectory(rule.LocalPath);

            var remoteRoot = NormalizedRemoteRoot();
            if (PushLocal)
            {
                EnsureRemoteDir(remoteRoot);
            }
            else if (!_client!.Exists(remoteRoot))
            {
                throw new DirectoryNotFoundException($"Remote folder not found: {remoteRoot}");
            }
        }

        private string NormalizedRemoteRoot()
        {
            var trimmed = rule.RemotePath.TrimEnd('/');
            return trimmed.Length == 0 ? "/" : trimmed;
        }

        private void RunInitialLocalScan(CancellationToken token)
        {
            foreach (var localFile in Directory.EnumerateFiles(rule.LocalPath, "*", SearchOption.AllDirectories))
            {
                token.ThrowIfCancellationRequested();
                var relative = Path.GetRelativePath(rule.LocalPath, localFile);
                UploadIfChanged(relative, localFile);
            }
        }

        // Remote -> local: SFTP has no push/notify, so this is a poll, not a watch - list the
        // whole remote tree, download anything new/changed, and (if DeleteExtraneous) remove
        // local files whose relative path was in the previous poll's listing but isn't in this
        // one. The very first poll after (re)connect never deletes anything (nothing to diff
        // against yet), matching how the local watcher can't see deletions predating its start.
        private void PollRemote(CancellationToken token)
        {
            var remoteRoot = NormalizedRemoteRoot();
            var entries = new Dictionary<string, (long Size, DateTime ModifiedUtc)>();
            CollectRemoteFiles(remoteRoot, remoteRoot, entries, token);

            foreach (var (relative, info) in entries)
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    DownloadIfChanged(relative, info.Size, info.ModifiedUtc);
                    _lastSyncUtc = DateTimeOffset.UtcNow;
                }
                catch (Exception ex)
                {
                    SetError($"{relative}: {ex.Message}");
                }
            }

            if (rule.DeleteExtraneous)
            {
                foreach (var relative in _knownRemoteEntries.Keys.Except(entries.Keys))
                {
                    try
                    {
                        var localPath = Path.Combine(rule.LocalPath, relative.Replace('/', Path.DirectorySeparatorChar));
                        if (File.Exists(localPath))
                        {
                            File.Delete(localPath);
                            _lastSyncUtc = DateTimeOffset.UtcNow;
                        }
                    }
                    catch (Exception ex)
                    {
                        SetError($"{relative}: {ex.Message}");
                    }
                }
            }

            _knownRemoteEntries = entries;
        }

        private void CollectRemoteFiles(string dir, string remoteRoot, Dictionary<string, (long, DateTime)> into, CancellationToken token)
        {
            foreach (var entry in _client!.ListDirectory(dir).Where(e => e.Name != "." && e.Name != ".."))
            {
                token.ThrowIfCancellationRequested();
                if (entry.IsDirectory)
                {
                    CollectRemoteFiles(entry.FullName, remoteRoot, into, token);
                }
                else
                {
                    into[RelativeToRemoteRoot(entry.FullName, remoteRoot)] = (entry.Length, entry.LastWriteTimeUtc);
                }
            }
        }

        private static string RelativeToRemoteRoot(string fullPath, string remoteRoot)
        {
            var trimmedRoot = remoteRoot.TrimEnd('/');
            return trimmedRoot.Length == 0 ? fullPath.TrimStart('/') : fullPath[(trimmedRoot.Length + 1)..];
        }

        private void DownloadIfChanged(string relativePath, long remoteSize, DateTime remoteModifiedUtc)
        {
            var localPath = Path.Combine(rule.LocalPath, relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (rule.SkipUnchanged && File.Exists(localPath))
            {
                var localInfo = new FileInfo(localPath);
                if (localInfo.Length == remoteSize && localInfo.LastWriteTimeUtc >= remoteModifiedUtc)
                {
                    return; // already up to date
                }
            }

            var localDir = Path.GetDirectoryName(localPath);
            if (!string.IsNullOrEmpty(localDir))
            {
                Directory.CreateDirectory(localDir);
            }

            using (var stream = File.Create(localPath))
            {
                _client!.DownloadFile(RemotePathFor(relativePath), stream);
            }

            // Keeps the next pass's skip-unchanged comparison meaningful - otherwise the local
            // copy's write time would be "now" instead of matching the remote file's.
            File.SetLastWriteTimeUtc(localPath, remoteModifiedUtc);
        }

        private void StartWatcher()
        {
            var watcher = new FileSystemWatcher(rule.LocalPath)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size,
            };
            watcher.Created += OnChanged;
            watcher.Changed += OnChanged;
            watcher.Deleted += OnDeleted;
            watcher.Renamed += OnRenamed;
            watcher.Error += (_, args) => SetError(args.GetException().Message);
            watcher.EnableRaisingEvents = true;
            _watcher = watcher;
        }

        private void StopWatcher()
        {
            if (_watcher is null)
            {
                return;
            }

            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
            _watcher = null;
        }

        private void OnChanged(object sender, FileSystemEventArgs e)
        {
            _pending.Enqueue((RelativeOf(e.FullPath), Deleted: false));
            _wake.Set();
        }

        private void OnDeleted(object sender, FileSystemEventArgs e)
        {
            _pending.Enqueue((RelativeOf(e.FullPath), Deleted: true));
            _wake.Set();
        }

        private void OnRenamed(object sender, RenamedEventArgs e)
        {
            _pending.Enqueue((RelativeOf(e.OldFullPath), Deleted: true));
            if (Directory.Exists(e.FullPath))
            {
                // The watcher only fires one event for the renamed directory itself, not its
                // contents - re-walk it so every file underneath lands at its new remote path.
                foreach (var file in SafeEnumerateFiles(e.FullPath))
                {
                    _pending.Enqueue((RelativeOf(file), Deleted: false));
                }
            }
            else
            {
                _pending.Enqueue((RelativeOf(e.FullPath), Deleted: false));
            }

            _wake.Set();
        }

        private void DrainPendingEvents()
        {
            if (_pending.IsEmpty)
            {
                return;
            }

            // Last event per path wins - coalesces the burst of Changed events a single save
            // typically fires, and a delete-then-recreate of the same path in one batch.
            var batch = new Dictionary<string, bool>();
            while (_pending.TryDequeue(out var evt))
            {
                batch[evt.RelativePath] = evt.Deleted;
            }

            foreach (var (relativePath, deleted) in batch)
            {
                try
                {
                    if (deleted)
                    {
                        DeleteRemote(relativePath);
                    }
                    else
                    {
                        UpsertLocalPath(relativePath);
                    }

                    _lastSyncUtc = DateTimeOffset.UtcNow;
                }
                catch (Exception ex)
                {
                    // One bad file (permission error, vanished mid-upload) must not stop the
                    // rest of the batch or kill the watcher.
                    SetError($"{relativePath}: {ex.Message}");
                }
            }
        }

        private void UpsertLocalPath(string relativePath)
        {
            var localPath = Path.Combine(rule.LocalPath, relativePath);
            if (Directory.Exists(localPath))
            {
                EnsureRemoteDir(RemotePathFor(relativePath));
                return;
            }

            if (!File.Exists(localPath))
            {
                return; // vanished between the event firing and this batch draining
            }

            UploadFile(relativePath, localPath);
        }

        private void UploadIfChanged(string relativePath, string localFile)
        {
            var remotePath = RemotePathFor(relativePath);
            if (rule.SkipUnchanged && _client!.Exists(remotePath))
            {
                var localInfo = new FileInfo(localFile);
                var remoteAttrs = _client.GetAttributes(remotePath);
                if (!remoteAttrs.IsDirectory && remoteAttrs.Size == localInfo.Length && remoteAttrs.LastWriteTimeUtc >= localInfo.LastWriteTimeUtc)
                {
                    return; // already up to date
                }
            }

            UploadFile(relativePath, localFile);
        }

        private void UploadFile(string relativePath, string localFile)
        {
            var remotePath = RemotePathFor(relativePath);
            EnsureRemoteDir(PosixParent(remotePath) ?? rule.RemotePath.TrimEnd('/'));
            using var stream = File.OpenRead(localFile);
            _client!.UploadFile(stream, remotePath, true);
        }

        private void DeleteRemote(string relativePath)
        {
            if (!rule.DeleteExtraneous)
            {
                return; // copy-only: leave the remote file in place
            }

            var remotePath = RemotePathFor(relativePath);
            if (!_client!.Exists(remotePath))
            {
                return;
            }

            if (_client.GetAttributes(remotePath).IsDirectory)
            {
                DeleteDirectoryRecursive(remotePath);
            }
            else
            {
                _client.DeleteFile(remotePath);
            }
        }

        // SSH.NET's DeleteDirectory only removes an empty directory, so drain the children first.
        private void DeleteDirectoryRecursive(string path)
        {
            foreach (var entry in _client!.ListDirectory(path).Where(e => e.Name != "." && e.Name != ".."))
            {
                if (entry.IsDirectory)
                {
                    DeleteDirectoryRecursive(entry.FullName);
                }
                else
                {
                    _client.DeleteFile(entry.FullName);
                }
            }

            _client.DeleteDirectory(path);
        }

        private void EnsureRemoteDir(string remoteDir)
        {
            if (string.IsNullOrEmpty(remoteDir) || remoteDir == "/" || _knownRemoteDirs.Contains(remoteDir))
            {
                return;
            }

            var parent = PosixParent(remoteDir);
            if (parent is not null)
            {
                EnsureRemoteDir(parent);
            }

            if (!_client!.Exists(remoteDir))
            {
                _client.CreateDirectory(remoteDir);
            }

            _knownRemoteDirs.Add(remoteDir);
        }

        private string RemotePathFor(string relativePath)
        {
            var posixRelative = relativePath.Replace('\\', '/');
            var basePath = rule.RemotePath.TrimEnd('/');
            return posixRelative.Length == 0 ? basePath : $"{basePath}/{posixRelative}";
        }

        private string RelativeOf(string fullPath) => Path.GetRelativePath(rule.LocalPath, fullPath);

        private static IEnumerable<string> SafeEnumerateFiles(string dir)
        {
            try
            {
                return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).ToList();
            }
            catch
            {
                return [];
            }
        }

        private static string? PosixParent(string path)
        {
            var trimmed = path.TrimEnd('/');
            var idx = trimmed.LastIndexOf('/');
            return idx <= 0 ? null : trimmed[..idx];
        }

        private void SetError(string message)
        {
            _state = "error";
            _error = message;
        }

        private void TearDown()
        {
            StopWatcher();
            if (_client is null)
            {
                return;
            }

            try
            {
                if (_client.IsConnected)
                {
                    _client.Disconnect();
                }

                _client.Dispose();
            }
            catch
            {
                // Best-effort.
            }

            _client = null;
        }

        private static void Wait(CancellationToken token, TimeSpan delay)
        {
            try
            {
                Task.Delay(delay, token).Wait(token);
            }
            catch
            {
                // Cancelled - the loop's own token check ends it.
            }
        }

        public void Dispose()
        {
            _cts?.Cancel();
            _wake.Set();
            try
            {
                _monitor?.Wait(TimeSpan.FromSeconds(5));
            }
            catch
            {
                // Best-effort - the loop's own cancellation-guarded catch already stopped it.
            }
        }
    }
}
