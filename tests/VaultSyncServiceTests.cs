using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// The merge matrix, end to end: two vaults, one remote, real crypto, real envelopes.
/// </summary>
[Collection("vault-dir")]
public sealed class VaultSyncServiceTests : IDisposable
{
    private readonly InMemoryRemote.Store _store = new();
    private readonly TwoDeviceFixture _fixture;

    public VaultSyncServiceTests()
    {
        _fixture = new TwoDeviceFixture((_, _, _) => new InMemoryRemote(_store));
    }

    public void Dispose() => _fixture.Dispose();

    /// <summary>Creates a collection on the laptop and joins it from the phone, as a real pair of devices would.</summary>
    private async Task<string> PairAsync(params string[] scopes)
    {
        var created = _fixture.Laptop.Collections.Create(
            "Team", "https://webdav.example.com/", "team", "pw", scopes.Length == 0 ? null : scopes);
        await _fixture.Laptop.SyncAsync(created.Id);

        var token = _fixture.Laptop.Collections.BuildInviteToken(created.Id, null);
        _fixture.Phone.Collections.Join(token, null);
        await _fixture.Phone.SyncAsync(created.Id);

        return created.Id;
    }

    [Fact]
    public async Task ARecordSavedOnOneDeviceReachesTheOther()
    {
        var collectionId = await PairAsync();

        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        Assert.Equal(["prod-db"], _fixture.Phone.HostNames());
        Assert.Equal("10.0.0.5", _fixture.Phone.Host("prod-db")!.Address);
    }

    [Fact]
    public async Task AnEditOnOneDeviceOverwritesTheOlderCopyOnTheOther()
    {
        var collectionId = await PairAsync();
        var id = _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Phone.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.9" });
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);

        Assert.Equal("10.0.0.9", _fixture.Laptop.Host("prod-db")!.Address);
        Assert.Single(_fixture.Laptop.HostNames());
    }

    /// <summary>A delete must stay deleted; without a tombstone the other device re-uploads its copy.</summary>
    [Fact]
    public async Task ADeleteOnOneDevicePropagatesAndStaysDeleted()
    {
        var collectionId = await PairAsync();
        var id = _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);
        Assert.Single(_fixture.Phone.HostNames());

        _fixture.Laptop.Vault.DeleteHost(id);
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        Assert.Empty(_fixture.Phone.HostNames());

        // Two more passes: the phone must not resurrect it, and the laptop must not pull
        // its own deleted record back from a stale copy.
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);

        Assert.Empty(_fixture.Phone.HostNames());
        Assert.Empty(_fixture.Laptop.HostNames());
    }

    /// <summary>An edit made after the other side's delete wins - the record comes back.</summary>
    [Fact]
    public async Task AnEditAfterADeleteWinsOverTheTombstone()
    {
        var collectionId = await PairAsync();
        var id = _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Laptop.Vault.DeleteHost(id);
        _fixture.Phone.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.9" });

        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);

        Assert.Equal("10.0.0.9", _fixture.Phone.Host("prod-db")?.Address);
        Assert.Equal("10.0.0.9", _fixture.Laptop.Host("prod-db")?.Address);
    }

    /// <summary>Both sides edited between syncs: higher HLC wins, loser kept as a renamed copy.</summary>
    [Fact]
    public async Task BothSidesEditingKeepsTheLoserAsAConflictCopy()
    {
        var collectionId = await PairAsync();
        var id = _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Phone.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.7" });
        _fixture.Laptop.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.8" });

        // The phone pushes first, so the laptop's later edit wins on HLC - and the phone
        // discovers that on its next pull, with its own edit preserved beside it.
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        var names = _fixture.Phone.HostNames();
        Assert.Equal(2, names.Count);
        Assert.Contains("prod-db", names);
        Assert.Contains(names, n => n.StartsWith("prod-db (conflict ", StringComparison.Ordinal));
        Assert.Equal("10.0.0.8", _fixture.Phone.Host("prod-db")!.Address);
    }

    /// <summary>
    /// Two edits in the same millisecond: the node tiebreak decides, identically on both devices,
    /// and the losing edit is still kept.
    /// </summary>
    [Fact]
    public async Task ATieBetweenTwoDevicesResolvesTheSameWayOnBoth()
    {
        var collectionId = await PairAsync();
        var id = _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Freeze(); // both edits land on the same millisecond on purpose
        _fixture.Phone.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.7" });
        _fixture.Laptop.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.8" });

        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);

        Assert.Equal(_fixture.Laptop.HostNames(), _fixture.Phone.HostNames());
        Assert.Equal(_fixture.Laptop.Host("prod-db")!.Address, _fixture.Phone.Host("prod-db")!.Address);
        Assert.Equal(2, _fixture.Phone.HostNames().Count);
    }

    /// <summary>Every "Sync now" must actually run a pass, not await a completed in-flight entry.</summary>
    [Fact]
    public async Task EverySyncActuallyRunsAPass()
    {
        var collectionId = await PairAsync();

        for (var i = 0; i < 5; i++)
        {
            _fixture.Laptop.SaveHost(collectionId, $"host-{i}", $"10.0.0.{i}");

            var putsBefore = _store.PutCount;
            await _fixture.Laptop.SyncAsync(collectionId);
            Assert.True(_store.PutCount > putsBefore, $"sync {i} pushed nothing");

            await _fixture.Phone.SyncAsync(collectionId);
            Assert.Contains($"host-{i}", _fixture.Phone.HostNames());
        }
    }

    /// <summary>A 412 means somebody wrote first; the push re-reads and retries rather than failing.</summary>
    [Fact]
    public async Task RetriesAWriteThatLostAPreconditionRace()
    {
        var collectionId = await PairAsync();
        var id = _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");

        _store.FailNextPrecondition[$"slopterm/v1/records/hosts/{id}.json"] = 0;
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        Assert.Equal(["prod-db"], _fixture.Phone.HostNames());
    }

    /// <summary>Scopes are opt-in per collection; keychain is off by default for good reason.</summary>
    [Fact]
    public async Task DoesntSyncAScopeTheCollectionDoesntCarry()
    {
        var collectionId = await PairAsync(SyncScopes.Hosts);

        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        _fixture.Laptop.Vault.SaveKeychainEntry(
            null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "PRIVATE" }, collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        Assert.Equal(["prod-db"], _fixture.Phone.HostNames());
        Assert.Empty(_fixture.Phone.Vault.ListKeychainEntries());
        Assert.DoesNotContain(_store.Files.Keys, k => k.Contains("/keychain/", StringComparison.Ordinal));
    }

    /// <summary>
    /// Two devices in one collection can use different WebDAV accounts against the same folder;
    /// swapping in your own changes nothing about the sync.
    /// </summary>
    [Fact]
    public async Task DevicesCanUseTheirOwnWebDavAccounts()
    {
        var created = _fixture.Laptop.Collections.Create(
            "Team", "https://webdav.example.com/", "alice", "alice-pw", null);
        await _fixture.Laptop.SyncAsync(created.Id);

        _fixture.Phone.Collections.Join(_fixture.Laptop.Collections.BuildInviteToken(created.Id, null), null);
        _fixture.Phone.Collections.Update(created.Id, null, null, "bob", "bob-pw", null, null);
        Assert.Equal("bob", _fixture.Phone.Collections.Describe(created.Id)!.RemoteUsername);

        _fixture.Laptop.SaveHost(created.Id, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(created.Id);
        await _fixture.Phone.SyncAsync(created.Id);

        Assert.Equal(["prod-db"], _fixture.Phone.HostNames());
        // Same collection key on both, whatever account each of them authenticates with.
        Assert.Equal(
            _fixture.Laptop.Collections.Describe(created.Id)!.KeyFingerprint,
            _fixture.Phone.Collections.Describe(created.Id)!.KeyFingerprint);
    }

    [Fact]
    public async Task ReportsAReadOnlyShareAsSuchRatherThanAsAGenericFailure()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        _store.ReadOnly = true;

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => _fixture.Laptop.SyncAsync(collectionId));

        Assert.Contains("read-only", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Records are AES-GCM under the collection key; host plaintext never reaches the wire.</summary>
    [Fact]
    public async Task NothingReadableLeavesTheDevice()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5",
            new CredentialRecord { Id = "c1", Kind = "password", Username = "deploy", Secret = "hunter2" });
        await _fixture.Laptop.SyncAsync(collectionId);

        var everything = string.Join("\n", _store.Files.Values.Select(f => System.Text.Encoding.UTF8.GetString(f.Content)));

        Assert.DoesNotContain("prod-db", everything, StringComparison.Ordinal);
        Assert.DoesNotContain("10.0.0.5", everything, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", everything, StringComparison.Ordinal);
    }

    /// <summary>The unchanged-record fast path: a second pass reads listings, not every record.</summary>
    [Fact]
    public async Task ASecondPassDoesntRefetchUnchangedRecords()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        var putsBefore = _store.PutCount;
        await _fixture.Phone.SyncAsync(collectionId);

        // members.json is re-read every pass by design; what must NOT happen is the phone
        // re-uploading a record it already agrees with.
        Assert.Equal(putsBefore, _store.PutCount);
    }

    /// <summary>
    /// Open tabs, logs and the GitHub token have no sync scope at all - asserts the absence
    /// directly, since adding one later would silently start leaving the device.
    /// </summary>
    [Fact]
    public void DeviceLocalRecordKindsHaveNoSyncScope()
    {
        foreach (var neverSynced in new[] { "open-tabs", "secrets", "logs", "github-token", "jobs", "job-runs", "ai-chats" })
        {
            Assert.Null(SyncScopes.Find(neverSynced));
            Assert.Null(SyncScopes.FolderFor(neverSynced));
            Assert.DoesNotContain(SyncScopes.All, scope => scope.Folder == neverSynced);
        }
    }

    /// <summary>A local-shell tab is saved, a full sync runs, and nothing about it reaches the remote.</summary>
    [Fact]
    public async Task ALocalShellTabNeverReachesTheRemote()
    {
        var collectionId = await PairAsync();

        _fixture.Laptop.Vault.SaveOpenTabs(new OpenTabsRecord
        {
            Tabs =
            [
                new OpenTabRecord
                {
                    Kind = "local",
                    Label = "zsh - my-laptop",
                    Host = "local",
                    Port = 0,
                    Username = "shell",
                    AuthMethod = "password",
                },
            ],
            ActiveIndex = 0,
        });

        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        Assert.Equal(["prod-db"], _fixture.Phone.HostNames());
        Assert.Empty(_fixture.Phone.Vault.GetOpenTabs().Tabs);
        Assert.DoesNotContain(_store.Files.Keys, key => key.Contains("open-tabs", StringComparison.Ordinal));

        var everything = string.Join("\n", _store.Files.Values.Select(f => System.Text.Encoding.UTF8.GetString(f.Content)));
        Assert.DoesNotContain("zsh - my-laptop", everything, StringComparison.Ordinal);
    }

    /// <summary>The local collection is not a collection you can sync - it has no remote at all.</summary>
    [Fact]
    public void TheLocalCollectionIsNeverListedAsSyncable()
    {
        Assert.Empty(_fixture.Laptop.Collections.List());
        Assert.DoesNotContain(CollectionStore.LocalCollectionId, _fixture.Laptop.Vault.Collections.ListCollectionIds());
    }

    /// <summary>Leaving keeps this device's copy of the records by default, in the local collection.</summary>
    [Fact]
    public async Task LeavingKeepsTheRecordsLocallyByDefault()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Phone.Collections.Leave(collectionId, keepRecordsLocally: true);

        Assert.Empty(_fixture.Phone.Collections.List());
        var kept = Assert.Single(_fixture.Phone.Vault.ListHosts());
        Assert.Equal("prod-db", kept.Record.Name);
        Assert.Equal(CollectionStore.LocalCollectionId, kept.CollectionId);
    }

    [Fact]
    public async Task RejoiningRemovesCopiesPreviouslyKeptLocally()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        var token = _fixture.Laptop.Collections.BuildInviteToken(collectionId, null);
        _fixture.Phone.Collections.Leave(collectionId, keepRecordsLocally: true);
        _fixture.Phone.Collections.Join(token, null);
        await _fixture.Phone.SyncAsync(collectionId);

        var host = Assert.Single(_fixture.Phone.Vault.ListHosts());
        Assert.Equal("prod-db", host.Record.Name);
        Assert.Equal(collectionId, host.CollectionId);
    }
}
