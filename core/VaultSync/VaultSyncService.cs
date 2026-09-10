using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>What the Collections UI polls: one row per collection, mirroring SyncService's status shape.</summary>
public sealed record CollectionSyncStatus(
    string CollectionId,
    string Name,
    string State, // "idle" | "syncing" | "error" | "paused"
    DateTimeOffset? LastSyncUtc,
    string? Error,
    int RecordCount);

/// <summary>
/// Converges one collection's records with its WebDAV remote, forever, best-effort: a failed
/// pass lands in <see cref="GetStatus"/> and is retried, never thrown into a caller.
/// </summary>
public sealed class VaultSyncService : IAsyncDisposable
{
    // Long enough not to fire per keystroke, short enough to reach another device promptly.
    private static readonly TimeSpan ChangeDebounce = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan PeriodicInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(5);

    // Must exceed how long a device can stay offline holding a record, or it re-uploads a collected one.
    private static readonly TimeSpan TombstoneLifetime = TimeSpan.FromDays(90);

    private const string RemoteRoot = "slopterm/v1";
    private const int PreconditionRetries = 3;

    private readonly VaultService _vault;
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _pending = new();
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastSync = new();
    // Guards _running. A collection's pass is registered before it can finish, which a
    // fire-and-forget Task.Run cannot guarantee on its own - see StartSync.
    private readonly object _runningGate = new();
    private readonly Dictionary<string, Task> _running = [];
    private readonly ConcurrentDictionary<string, string?> _errors = new();
    private readonly Func<string, string?, string?, IVaultSyncRemote> _remoteFactory;
    private Task? _loop;

    /// <param name="remoteFactory">Overridden by integration tests; production builds a <see cref="WebDavRemote"/>.</param>
    public VaultSyncService(VaultService vault, Func<string, string?, string?, IVaultSyncRemote>? remoteFactory = null)
    {
        _vault = vault;
        _remoteFactory = remoteFactory ?? ((url, user, password) => new WebDavRemote(url, user, password));
        _vault.RecordChanged += OnRecordChanged;
    }

    /// <summary>Starts the supervisor loop. Safe to call twice; the second call does nothing.</summary>
    public void Start()
    {
        _loop ??= Task.Run(() => RunAsync(_cts.Token));
    }

    /// <summary>Queues a debounced push for one collection - the "on local change" trigger.</summary>
    public void RequestSync(string collectionId)
    {
        if (collectionId == CollectionStore.LocalCollectionId)
        {
            return; // the local collection has no remote, by definition
        }

        _pending[collectionId] = DateTimeOffset.UtcNow;
    }

    /// <summary>Queues every collection - the "on unlock" and "Android came to the foreground" triggers.</summary>
    public void RequestSyncAll()
    {
        if (!_vault.IsUnlocked)
        {
            return;
        }

        foreach (var collectionId in _vault.Collections.ListCollectionIds())
        {
            _pending[collectionId] = DateTimeOffset.UtcNow;
        }
    }

    public IReadOnlyList<CollectionSyncStatus> GetStatus()
    {
        if (!_vault.IsUnlocked)
        {
            return [];
        }

        var results = new List<CollectionSyncStatus>();
        foreach (var collectionId in _vault.Collections.ListCollectionIds())
        {
            var collection = _vault.Collections.GetCollection(collectionId);
            if (collection is null)
            {
                continue;
            }

            var error = _errors.GetValueOrDefault(collectionId) ?? collection.LastError;
            var state = !collection.Enabled ? "paused"
                : IsSyncing(collectionId) ? "syncing"
                : error is null ? "idle" : "error";

            var recordCount = collection.Scopes.Sum(scope =>
                SyncScopes.FolderFor(scope) is { } folder ? _vault.Collections.ListRecords(collectionId, folder).Count : 0);

            results.Add(new CollectionSyncStatus(
                collectionId, collection.Name, state, collection.LastSyncUtc, error, recordCount));
        }

        return results;
    }

    /// <summary>Runs one pass now and surfaces any failure - what "Sync now" calls, unlike the loop.</summary>
    public async Task SyncNowAsync(string collectionId, CancellationToken ct)
    {
        await StartSync(collectionId, ct);

        if (_errors.GetValueOrDefault(collectionId) is { } error)
        {
            throw new InvalidOperationException(error);
        }
    }

    private bool IsSyncing(string collectionId)
    {
        lock (_runningGate)
        {
            return _running.TryGetValue(collectionId, out var inFlight) && !inFlight.IsCompleted;
        }
    }

    private void OnRecordChanged(string collectionId) => RequestSync(collectionId);

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (_vault.IsUnlocked)
                {
                    foreach (var collectionId in _vault.Collections.ListCollectionIds())
                    {
                        if (IsDue(collectionId))
                        {
                            // Deliberately not awaited: collections sync concurrently, and a
                            // slow or unreachable one must not hold up the rest of the tick.
                            _ = StartSync(collectionId, ct);
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The supervisor itself must never die - a collection whose metadata went
                // unreadable would otherwise stop every other collection from ever syncing.
                CrashLogger.LogPhase($"vault sync supervisor: {ex.Message}");
            }

            try
            {
                await Task.Delay(TickInterval, ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private bool IsDue(string collectionId)
    {
        lock (_runningGate)
        {
            if (_running.TryGetValue(collectionId, out var inFlight) && !inFlight.IsCompleted)
            {
                return false;
            }
        }

        var now = DateTimeOffset.UtcNow;
        if (_pending.TryGetValue(collectionId, out var requestedAt) && now - requestedAt >= ChangeDebounce)
        {
            return true;
        }

        var last = _lastSync.GetValueOrDefault(collectionId, DateTimeOffset.MinValue);
        return now - last >= PeriodicInterval;
    }

    /// <summary>
    /// Starts a pass, or returns the one already in flight. Registered under the gate before the
    /// pass can finish, and a completed entry counts as "not running".
    /// </summary>
    private Task StartSync(string collectionId, CancellationToken ct)
    {
        lock (_runningGate)
        {
            if (_running.TryGetValue(collectionId, out var inFlight) && !inFlight.IsCompleted)
            {
                return inFlight;
            }

            var started = RunPassAsync(collectionId, ct);
            _running[collectionId] = started;
            return started;
        }
    }

    private Task RunPassAsync(string collectionId, CancellationToken ct)
    {
        return Task.Run(async () =>
        {
            try
            {
                _pending.TryRemove(collectionId, out _);
                await SyncCollectionAsync(collectionId, ct);
                _errors[collectionId] = null!;
                _errors.TryRemove(collectionId, out _);
                RecordOutcome(collectionId, null);
            }
            catch (OperationCanceledException)
            {
                // shutting down - not a sync failure worth showing
            }
            catch (Exception ex)
            {
                _errors[collectionId] = Describe(ex);
                RecordOutcome(collectionId, Describe(ex));
            }
            finally
            {
                _lastSync[collectionId] = DateTimeOffset.UtcNow;
            }
        }, ct);
    }

    private static string Describe(Exception ex) => ex switch
    {
        VaultSyncRemoteException { StatusCode: 401 } =>
            "The WebDAV server rejected these credentials (401). Check the username and app password.",
        VaultSyncRemoteException { StatusCode: 403 } =>
            "This collection is read-only for you - the server refused the write (403).",
        VaultSyncRemoteException { StatusCode: 404 } =>
            "That WebDAV path doesn't exist (404). Check the collection's URL.",
        HttpRequestException http => $"Couldn't reach the WebDAV server: {http.Message}",
        TaskCanceledException => "The WebDAV server didn't respond in time.",
        _ => ex.Message,
    };

    private void RecordOutcome(string collectionId, string? error)
    {
        try
        {
            var collection = _vault.Collections.GetCollection(collectionId);
            if (collection is null)
            {
                return;
            }

            collection.LastError = error;
            if (error is null)
            {
                collection.LastSyncUtc = DateTimeOffset.UtcNow;
            }

            _vault.Collections.SaveCollection(collectionId, collection);
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        {
            // Recording the outcome is bookkeeping; failing at it must not mask the sync.
        }
    }

    // --- one pass -------------------------------------------------------------------------

    private async Task SyncCollectionAsync(string collectionId, CancellationToken ct)
    {
        var collection = _vault.Collections.GetCollection(collectionId);
        if (collection is null || !collection.Enabled || string.IsNullOrWhiteSpace(collection.RemoteUrl))
        {
            return;
        }

        var remote = _remoteFactory(collection.RemoteUrl, collection.RemoteUsername, collection.RemotePassword);
        try
        {
            await remote.EnsureDirectoryAsync($"{RemoteRoot}/records", ct);
            await remote.EnsureDirectoryAsync($"{RemoteRoot}/tombstones", ct);

            await EnsureRemoteInfoAsync(remote, collectionId, collection, ct);
            var collectionKey = Convert.FromBase64String(collection.CollectionKey);

            foreach (var scope in collection.Scopes)
            {
                if (SyncScopes.Find(scope) is null)
                {
                    continue; // a scope name from a newer build - skip rather than guess
                }

                await SyncScopeAsync(remote, collectionId, collection, collectionKey, scope, ct);
            }

            _vault.Collections.GcTombstones(collectionId, TombstoneLifetime);
            collection.LastSyncUtc = DateTimeOffset.UtcNow;
            collection.LastError = null;
            _vault.Collections.SaveCollection(collectionId, collection);
        }
        finally
        {
            (remote as IDisposable)?.Dispose();
        }
    }

    /// <summary>
    /// Writes the human-facing collection.json once, so someone browsing the WebDAV folder
    /// can tell what these files are. Carries no secrets, and is never read back for trust.
    /// </summary>
    private static async Task EnsureRemoteInfoAsync(
        IVaultSyncRemote remote, string collectionId, CollectionRecord collection, CancellationToken ct)
    {
        if (await remote.GetAsync($"{RemoteRoot}/collection.json", ct) is not null)
        {
            return;
        }

        var info = new RemoteCollectionInfo
        {
            CollectionId = collectionId,
            Name = collection.Name,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        await remote.PutAsync($"{RemoteRoot}/collection.json", SyncJson.SerializeToUtf8Bytes(info), null, true, ct);
    }

    private async Task SyncScopeAsync(
        IVaultSyncRemote remote,
        string collectionId,
        CollectionRecord collection,
        byte[] collectionKey,
        string scope,
        CancellationToken ct)
    {
        var folder = SyncScopes.FolderFor(scope)!;
        var recordsPath = $"{RemoteRoot}/records/{scope}";
        var tombstonesPath = $"{RemoteRoot}/tombstones";
        await remote.EnsureDirectoryAsync(recordsPath, ct);

        var remoteRecords = (await remote.ListAsync(recordsPath, ct))
            .Where(e => !e.IsCollection && e.Path.EndsWith(".json", StringComparison.Ordinal))
            .ToDictionary(e => Path.GetFileNameWithoutExtension(e.Path), e => e, StringComparer.Ordinal);
        var remoteTombstones = (await remote.ListAsync(tombstonesPath, ct))
            .Where(e => !e.IsCollection && e.Path.EndsWith(".json", StringComparison.Ordinal))
            .ToDictionary(e => Path.GetFileNameWithoutExtension(e.Path), e => e, StringComparer.Ordinal);

        var undecryptable = 0;
        var local = _vault.Collections.ListRecords(collectionId, folder).ToDictionary(r => r.Id, StringComparer.Ordinal);
        var localTombstones = _vault.Collections.ListTombstones(collectionId)
            .Where(t => t.Type == scope)
            .ToDictionary(t => t.Id, StringComparer.Ordinal);

        // --- pull -------------------------------------------------------------------------
        foreach (var (id, entry) in remoteTombstones)
        {
            var stateKey = TombstoneKey(scope, id);
            if (collection.Tombstones.TryGetValue(stateKey, out var seenETag) && seenETag == entry.ETag && entry.ETag is not null)
            {
                continue;
            }

            var body = await remote.GetAsync(entry.Path, ct);
            var tombstone = body is null ? null : SyncJson.Deserialize<SyncTombstone>(body);
            if (tombstone is null || tombstone.Type != scope)
            {
                continue;
            }

            _vault.Collections.Clock.Observe(Hlc.Parse(tombstone.Hlc));
            ApplyRemoteTombstone(collectionId, collection, folder, scope, local, tombstone);
            collection.Tombstones[stateKey] = entry.ETag ?? tombstone.Hlc;
            localTombstones[id] = tombstone;
        }

        foreach (var (id, entry) in remoteRecords)
        {
            var stateKey = RecordKey(scope, id);
            var state = collection.Records.GetValueOrDefault(stateKey);
            if (state?.ETag is not null && entry.ETag is not null && state.ETag == entry.ETag)
            {
                continue; // unchanged since we last agreed - no need to download it
            }

            var body = await remote.GetAsync(entry.Path, ct);
            var envelope = body is null ? null : SyncJson.Deserialize<SyncEnvelope>(body);
            if (envelope is null)
            {
                continue;
            }

            string plaintext;
            try
            {
                plaintext = CollectionCrypto.DecryptRecord(collectionKey, envelope.Nonce, envelope.Ciphertext);
            }
            catch (CryptographicException)
            {
                // Different collection key - counted and reported so a silent non-appearance
                // doesn't go unexplained.
                undecryptable++;
                continue;
            }

            var remoteHlc = Hlc.Parse(envelope.Hlc);
            _vault.Collections.Clock.Observe(remoteHlc);
            MergeRemoteRecord(collectionId, collection, folder, scope, local, localTombstones, envelope, remoteHlc, plaintext, state);
            collection.Records[stateKey] = new RecordSyncState { ETag = entry.ETag, Hlc = envelope.Hlc };
        }

        // Rejoining with "keep records" keeps stable ids, so the pull above restores records
        // rather than duplicating every host.
        var joinedIds = _vault.Collections.ListRecords(collectionId, folder)
            .Select(record => record.Id)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var localCopy in _vault.Collections.ListRecords(CollectionStore.LocalCollectionId, folder))
        {
            if (joinedIds.Contains(localCopy.Id))
            {
                _vault.Collections.DeleteRecord(CollectionStore.LocalCollectionId, folder, localCopy.Id, scope);
            }
        }

        // --- push -------------------------------------------------------------------------
        foreach (var record in _vault.Collections.ListRecords(collectionId, folder))
        {
            var stateKey = RecordKey(scope, record.Id);
            var state = collection.Records.GetValueOrDefault(stateKey);
            if (state?.Hlc == record.Hlc && record.Hlc.Length > 0 && remoteRecords.ContainsKey(record.Id))
            {
                continue; // unchanged here since we last agreed, and still present there
            }

            var pushed = await PushRecordAsync(
                remote, collectionKey, scope, record, state, remoteRecords.ContainsKey(record.Id), ct);
            if (pushed is not null)
            {
                collection.Records[stateKey] = pushed;
            }
        }

        foreach (var (id, tombstone) in localTombstones)
        {
            var stateKey = TombstoneKey(scope, id);
            if (collection.Tombstones.ContainsKey(stateKey) && remoteTombstones.ContainsKey(id))
            {
                continue;
            }

            var result = await remote.PutAsync(
                $"{tombstonesPath}/{id}.json", SyncJson.SerializeToUtf8Bytes(tombstone), null, false, ct);
            if (result.Ok)
            {
                // The record goes only after its tombstone is durable, so a crash in between
                // leaves a visible record rather than an unexplained deletion.
                await remote.DeleteAsync($"{recordsPath}/{id}.json", ct);
                collection.Tombstones[stateKey] = result.ETag ?? tombstone.Hlc;
                collection.Records.Remove(RecordKey(scope, id));
            }
        }

        _vault.Collections.SaveCollection(collectionId, collection);

        if (undecryptable > 0)
        {
            throw new InvalidOperationException(
                $"{undecryptable} of the {scope} records on this share are encrypted with a different key than this " +
                "collection's, so they can't be read here. That means two different collections are pointed at the " +
                "same folder - give one of them its own, or re-join with the other's token.");
        }
    }

    /// <summary>
    /// PUT with a precondition only when the server has given us something to condition on, retrying
    /// a 412 and falling back to an unconditional write - servers disagree about preconditions.
    /// </summary>
    private async Task<RecordSyncState?> PushRecordAsync(
        IVaultSyncRemote remote,
        byte[] collectionKey,
        string scope,
        StoredRecord record,
        RecordSyncState? state,
        bool existsRemotely,
        CancellationToken ct)
    {
        var path = $"{RemoteRoot}/records/{scope}/{record.Id}.json";
        // Stamped once, from the record itself - never re-derived inside the retry loop.
        var hlc = record.Hlc.Length > 0 ? record.Hlc : _vault.Collections.Clock.Now().ToString();

        for (var attempt = 0; attempt <= PreconditionRetries; attempt++)
        {
            var (nonce, ciphertext) = CollectionCrypto.EncryptRecord(collectionKey, record.Json);
            var envelope = new SyncEnvelope
            {
                Id = record.Id,
                Type = scope,
                UpdatedAt = record.UpdatedAt,
                Hlc = hlc,
                Nonce = Convert.ToBase64String(nonce),
                Ciphertext = Convert.ToBase64String(ciphertext),
            };

            // Last attempt goes in unconditionally - see this method's summary.
            var lastAttempt = attempt == PreconditionRetries;
            var ifMatch = lastAttempt ? null : state?.ETag;
            // "Create only" only when we believe the record isn't there - asserting it against
            // an existing record is a permanent 412.
            var ifNoneMatchStar = !lastAttempt && ifMatch is null && !existsRemotely;

            var result = await remote.PutAsync(
                path, SyncJson.SerializeToUtf8Bytes(envelope), ifMatch, ifNoneMatchStar, ct);

            if (result.Ok)
            {
                return new RecordSyncState { ETag = result.ETag, Hlc = hlc };
            }

            if (!result.PreconditionFailed)
            {
                return null;
            }

            existsRemotely = true;

            // Someone wrote first: observe their clock, then retry against their ETag. Never
            // re-stamp with a fresh HLC - the reading describes when the edit happened, not when
            // the push landed, and bumping it would let an older edit outrank a newer one.
            var existing = await remote.GetAsync(path, ct);
            var theirs = existing is null ? null : SyncJson.Deserialize<SyncEnvelope>(existing);
            if (theirs is not null)
            {
                _vault.Collections.Clock.Observe(Hlc.Parse(theirs.Hlc));
            }

            var listing = await remote.ListAsync($"{RemoteRoot}/records/{scope}", ct);
            var refreshed = listing.FirstOrDefault(e => Path.GetFileNameWithoutExtension(e.Path) == record.Id);
            state = new RecordSyncState { ETag = refreshed?.ETag, Hlc = theirs?.Hlc };
        }

        return null;
    }


    // --- merge ----------------------------------------------------------------------------

    /// <summary>
    /// Applies one pulled record. Higher HLC wins; a genuine two-sided edit keeps the loser as a
    /// renamed copy rather than dropping it.
    /// </summary>
    private void MergeRemoteRecord(
        string collectionId,
        CollectionRecord collection,
        string folder,
        string scope,
        Dictionary<string, StoredRecord> local,
        Dictionary<string, SyncTombstone> localTombstones,
        SyncEnvelope envelope,
        Hlc remoteHlc,
        string plaintext,
        RecordSyncState? state)
    {
        if (localTombstones.TryGetValue(envelope.Id, out var tombstone) && Hlc.Parse(tombstone.Hlc) > remoteHlc)
        {
            return; // deleted here, after they wrote it - our delete still wins
        }

        if (!local.TryGetValue(envelope.Id, out var mine))
        {
            _vault.Collections.SaveRecord(collectionId, folder, envelope.Id, plaintext, envelope.Hlc);
            return;
        }

        var localHlc = Hlc.Parse(mine.Hlc);
        var contentsDiffer = !string.Equals(mine.Json, plaintext, StringComparison.Ordinal);

        // A genuine conflict is both sides having moved on from the last agreed state - decided
        // by the sync state, not by HLC. No state at all means "unknown" (e.g. after a rotation),
        // and treating that as a conflict duplicated untouched records.
        var agreedHlc = state?.Hlc;
        if (contentsDiffer && agreedHlc is not null && agreedHlc != mine.Hlc && agreedHlc != envelope.Hlc)
        {
            SaveConflictCopy(collectionId, folder, localHlc >= remoteHlc ? plaintext : mine.Json);
        }

        if (localHlc >= remoteHlc)
        {
            return; // ours stands - the push pass sends it
        }

        _vault.Collections.SaveRecord(collectionId, folder, envelope.Id, plaintext, envelope.Hlc);
    }

    private void ApplyRemoteTombstone(
        string collectionId,
        CollectionRecord collection,
        string folder,
        string scope,
        Dictionary<string, StoredRecord> local,
        SyncTombstone tombstone)
    {
        _vault.Collections.SaveTombstone(collectionId, tombstone);

        if (!local.TryGetValue(tombstone.Id, out var mine))
        {
            return;
        }

        if (Hlc.Parse(mine.Hlc) > Hlc.Parse(tombstone.Hlc))
        {
            // Edited here after they deleted it. The edit wins, and removing the local
            // tombstone lets the push pass republish the record.
            _vault.Collections.DeleteTombstone(collectionId, tombstone.Id);
            collection.Tombstones.Remove(TombstoneKey(scope, tombstone.Id));
            return;
        }

        // DeleteRecord would write a second tombstone of our own; the remote one is already
        // saved above, so the file is simply removed.
        var path = Path.Combine(_vault.Collections.CollectionDirectory(collectionId), folder, $"{tombstone.Id}.json");
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        local.Remove(tombstone.Id);
        collection.Records.Remove(RecordKey(scope, tombstone.Id));
    }

    /// <summary>
    /// Keeps the losing side of a two-sided edit under a new id, name suffixed where one exists.
    /// </summary>
    private void SaveConflictCopy(string collectionId, string folder, string loserJson)
    {
        try
        {
            var suffix = $" (conflict {DateTimeOffset.UtcNow:yyyy-MM-dd})";
            var node = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(loserJson);
            if (node is not null)
            {
                foreach (var field in new[] { "Name", "name", "Description", "description" })
                {
                    if (node.TryGetValue(field, out var value) && value.ValueKind == JsonValueKind.String)
                    {
                        node[field] = JsonSerializer.SerializeToElement(value.GetString() + suffix);
                        break;
                    }
                }
            }

            var json = node is null ? loserJson : JsonSerializer.Serialize(node);
            _vault.Collections.SaveRecord(collectionId, folder, null, json);
        }
        catch (JsonException)
        {
            _vault.Collections.SaveRecord(collectionId, folder, null, loserJson);
        }
    }

    private static string RecordKey(string scope, string id) => $"{scope}/{id}";
    private static string TombstoneKey(string scope, string id) => $"{scope}/{id}";

    public async ValueTask DisposeAsync()
    {
        _vault.RecordChanged -= OnRecordChanged;
        await _cts.CancelAsync();

        if (_loop is not null)
        {
            try
            {
                await _loop.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (Exception ex) when (ex is OperationCanceledException or TimeoutException)
            {
                // A sync in flight must never hold the app open - see the host's 2s shutdown.
            }
        }

        _cts.Dispose();
    }
}
