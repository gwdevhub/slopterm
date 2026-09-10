using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;

namespace Slopterm.Tests;

/// <summary>
/// Two independent vaults - "the laptop" and "the phone" - converging through one remote,
/// each with its own directory, node name, and a fixture-controlled wall clock so program
/// order is exactly clock order. <see cref="Freeze"/> opts into genuine ties.
/// </summary>
public sealed class TwoDeviceFixture : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "slopterm-sync-tests", Guid.NewGuid().ToString("N"));

    private DateTimeOffset _now = DateTimeOffset.Parse("2026-08-03T12:00:00Z");
    private bool _frozen;

    public TwoDeviceFixture(Func<string, string?, string?, IVaultSyncRemote> remoteFactory)
    {
        Laptop = new Device(Path.Combine(_root, "laptop"), remoteFactory, "laptop00", Read);
        Phone = new Device(Path.Combine(_root, "phone"), remoteFactory, "phone000", Read);
    }

    // Shared by both devices and advanced on every read, so stamps are ordered by when the
    // test asked for them. Not thread-safe on purpose: these tests await every sync.
    private DateTimeOffset Read()
    {
        if (!_frozen)
        {
            _now = _now.AddMilliseconds(1);
        }

        return _now;
    }

    /// <summary>
    /// Stops the clock, so two edits made afterwards land in the same millisecond and neither
    /// "happened first". Only a test specifically about ties should want this.
    /// </summary>
    public void Freeze() => _frozen = true;

    public Device Laptop { get; }
    public Device Phone { get; }

    public sealed class Device
    {
        public Device(
            string vaultDirectory,
            Func<string, string?, string?, IVaultSyncRemote> remoteFactory,
            string node,
            Func<DateTimeOffset> wallClock)
        {
            Directory.CreateDirectory(vaultDirectory);
            Vault = new VaultService(new HybridLogicalClock(node, wallClock), vaultDirectory);
            Vault.EnsureUnlockedIfPasswordNotRequired();
            Sync = new VaultSyncService(Vault, remoteFactory);
            Collections = new CollectionService(Vault, Sync);
        }

        public VaultService Vault { get; }
        public VaultSyncService Sync { get; }
        public CollectionService Collections { get; }

        /// <summary>One pass, surfacing whatever went wrong rather than swallowing it.</summary>
        public Task SyncAsync(string collectionId) => Sync.SyncNowAsync(collectionId, CancellationToken.None);

        public HostRecord? Host(string name) =>
            Vault.ListHosts().FirstOrDefault(h => h.Record.Name == name).Record;

        public IReadOnlyList<string> HostNames() =>
            Vault.ListHosts().Select(h => h.Record.Name).Order(StringComparer.Ordinal).ToList();

        public string SaveHost(string collectionId, string name, string address, params CredentialRecord[] credentials) =>
            Vault.SaveHost(null, new HostRecord { Name = name, Address = address, Credentials = [.. credentials] }, collectionId);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // best-effort - a leftover temp directory isn't worth failing a test over
        }
    }
}
