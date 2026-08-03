using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;

namespace Slopterm.Tests;

/// <summary>
/// Two independent vaults - "the laptop" and "the phone" - converging through one remote.
/// Each is handed its own vault directory directly. It used to flip the process-wide
/// SLOPTERM_VAULT_DIR between constructing the two, which worked right up until anything else
/// in the process also had a vault: the variable is shared, so which directory the next
/// `new VaultService()` picked up depended on ordering nobody controlled.
///
/// Each device gets its OWN hybrid logical clock, with its own node name, reading a wall
/// clock the FIXTURE controls. Both halves of that matter.
///
/// Separate clocks, because with one process-wide clock the two devices can never issue the
/// same reading and so can never tie - which hides the tiebreak path entirely and couples
/// their stamps in a way no real pair of devices is.
///
/// A controlled wall clock, because once they CAN tie, "the laptop edited after the phone"
/// stops being true just by writing the two lines in that order: if both land in the same
/// millisecond the winner is decided by node name, not by which line ran first. Against a
/// real clock that made these tests fail roughly one run in six, always for the same
/// non-reason - the machine was fast enough that two edits shared a millisecond.
///
/// So the clock advances a millisecond on every read. Program order is then exactly clock
/// order, for both devices, which is what a test that writes "the phone edits, then the
/// laptop edits" actually means. <see cref="Freeze"/> opts out, for the one test that is
/// specifically about what happens when two devices genuinely tie.
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

    // Shared by both devices and advanced on every read, so anything either of them stamps is
    // ordered by when the test asked for it. Not thread-safe on purpose: these tests await
    // every sync, so there is only ever one caller.
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
