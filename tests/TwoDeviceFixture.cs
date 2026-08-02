using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;

namespace Slopterm.Tests;

/// <summary>
/// Two independent vaults - "the laptop" and "the phone" - converging through one remote.
/// Each gets its own vault directory via SLOPTERM_VAULT_DIR, which AppPaths reads on every
/// call, so constructing them one after the other with the variable flipped in between is
/// enough to keep them genuinely separate on disk.
///
/// Caveat worth knowing when reading a failure: DeviceIdentity caches one id per process,
/// so both devices share an HLC node string. That doesn't affect ordering (the shared clock
/// still issues strictly increasing values, which is what merging needs) but it does mean
/// these tests don't exercise the node-name tiebreak - HybridLogicalClockTests covers that
/// directly instead.
/// </summary>
public sealed class TwoDeviceFixture : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "slopterm-sync-tests", Guid.NewGuid().ToString("N"));
    private readonly string? _previousVaultDir = Environment.GetEnvironmentVariable("SLOPTERM_VAULT_DIR");

    public TwoDeviceFixture(Func<string, string?, string?, IVaultSyncRemote> remoteFactory)
    {
        Laptop = new Device(Path.Combine(_root, "laptop"), remoteFactory);
        Phone = new Device(Path.Combine(_root, "phone"), remoteFactory);
    }

    public Device Laptop { get; }
    public Device Phone { get; }

    public sealed class Device
    {
        public Device(string vaultDirectory, Func<string, string?, string?, IVaultSyncRemote> remoteFactory)
        {
            Directory.CreateDirectory(vaultDirectory);
            Environment.SetEnvironmentVariable("SLOPTERM_VAULT_DIR", vaultDirectory);
            Vault = new VaultService();
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
        Environment.SetEnvironmentVariable("SLOPTERM_VAULT_DIR", _previousVaultDir);
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
