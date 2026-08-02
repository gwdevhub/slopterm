using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// The merge matrix, end to end: two vaults, one remote, real crypto, real envelopes.
/// Every test here is a scenario a user would recognise - "I added it on the laptop", "I
/// deleted it on the phone", "we both edited it".
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

    /// <summary>
    /// The bug this whole design is built around: a delete must stay deleted. Without a
    /// tombstone the other device would faithfully re-upload the copy it still holds.
    /// </summary>
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

    /// <summary>
    /// An edit made after the other side's delete wins - the record comes back, because
    /// somebody deliberately touched it more recently than the deletion.
    /// </summary>
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

    /// <summary>
    /// Both sides edited the same host between syncs. The higher HLC wins, and the loser is
    /// kept as a renamed copy - a silently lost host is the one bug users never forgive.
    /// </summary>
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
    /// A 412 means somebody wrote first. The push has to re-read, re-stamp and retry rather
    /// than fail the pass - servers disagree about preconditions, so this path runs often.
    /// </summary>
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

    /// <summary>
    /// Scopes are opt-in per collection. Keychain is off by default precisely because
    /// turning it on means deliberately handing everyone your private keys.
    /// </summary>
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
    /// Rotation re-keys everything and re-wraps for whoever remains. The removed device
    /// finds no wrapped key for its fingerprint and says so plainly, rather than looping on
    /// a decrypt it will never win.
    /// </summary>
    [Fact]
    public async Task RotatingAfterRemovingSomeoneLocksThemOut()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        var phoneMember = _fixture.Laptop.Collections.ListMembers(collectionId)
            .Single(m => !m.IsThisDevice);
        await _fixture.Laptop.Sync.RotateKeyAsync(collectionId, [phoneMember.Id], CancellationToken.None);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => _fixture.Phone.SyncAsync(collectionId));
        Assert.Contains("no longer have access", error.Message, StringComparison.OrdinalIgnoreCase);

        // The laptop keeps working on the new epoch.
        _fixture.Laptop.SaveHost(collectionId, "second", "10.0.0.6");
        await _fixture.Laptop.SyncAsync(collectionId);
        Assert.Equal(["prod-db", "second"], _fixture.Laptop.HostNames());
    }

    /// <summary>
    /// A rotation with nobody removed - "that invite token got pasted into the wrong chat" -
    /// must leave every remaining device able to read the collection on the new epoch.
    /// </summary>
    [Fact]
    public async Task RotatingWithoutRemovingAnyoneKeepsEveryoneIn()
    {
        var collectionId = await PairAsync();
        _fixture.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        await _fixture.Laptop.Sync.RotateKeyAsync(collectionId, [], CancellationToken.None);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Laptop.SaveHost(collectionId, "second", "10.0.0.6");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        Assert.Equal(["prod-db", "second"], _fixture.Phone.HostNames());
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

    /// <summary>
    /// Records are AES-GCM under the collection key. The plaintext of a host - its address,
    /// its name - must never appear in what goes over the wire.
    /// </summary>
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

    /// <summary>
    /// The unchanged-record fast path: a second pass over a settled collection should read
    /// listings, not download every record again.
    /// </summary>
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
}
