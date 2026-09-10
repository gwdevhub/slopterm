using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// The same convergence scenarios as <see cref="VaultSyncServiceTests"/>, but through a REAL
/// WebDAV server rather than the in-memory fake. Skipped unless SLOPTERM_WEBDAV_URL is set.
/// </summary>
[Collection("vault-dir")]
public sealed class WebDavIntegrationTests : IDisposable
{
    private readonly TwoDeviceFixture? _fixture;
    private readonly string _root = $"slopterm-it-{Guid.NewGuid():N}";
    private readonly string? _baseUrl;
    private readonly string? _user;
    private readonly string? _password;

    public WebDavIntegrationTests()
    {
        _baseUrl = Environment.GetEnvironmentVariable("SLOPTERM_WEBDAV_URL");
        _user = Environment.GetEnvironmentVariable("SLOPTERM_WEBDAV_USER");
        _password = Environment.GetEnvironmentVariable("SLOPTERM_WEBDAV_PASS");
        if (string.IsNullOrEmpty(_baseUrl))
        {
            return;
        }

        // Both devices get the same URL, so they land on one share - the whole point. The
        // per-run subfolder keeps concurrent runs from colliding.
        _fixture = new TwoDeviceFixture((_, user, password) =>
            new WebDavRemote(Combine(_baseUrl, _root), user, password));
    }

    private static string Combine(string baseUrl, string suffix) =>
        baseUrl.TrimEnd('/') + "/" + suffix + "/";

    public void Dispose()
    {
        if (_fixture is null)
        {
            return;
        }

        try
        {
            using var remote = new WebDavRemote(Combine(_baseUrl!, _root), _user, _password);
            remote.DeleteAsync(string.Empty, CancellationToken.None).GetAwaiter().GetResult();
        }
        catch (Exception ex) when (ex is VaultSyncRemoteException or HttpRequestException)
        {
            // best-effort cleanup - a leftover test folder isn't worth failing a run over
        }

        _fixture.Dispose();
    }

    private async Task<string> PairAsync()
    {
        // WebDAV never creates missing parent collections, so the per-run folder has to exist
        // before a collection is pointed at it.
        using (var root = new WebDavRemote(_baseUrl!, _user, _password))
        {
            await root.EnsureDirectoryAsync(_root, CancellationToken.None);
        }

        var created = _fixture!.Laptop.Collections.Create("Integration", _baseUrl!, _user, _password, null);
        await _fixture.Laptop.SyncAsync(created.Id);

        _fixture.Phone.Collections.Join(_fixture.Laptop.Collections.BuildInviteToken(created.Id, null), null);
        await _fixture.Phone.SyncAsync(created.Id);
        return created.Id;
    }

    /// <summary>
    /// The whole feature in one test: add on one device, see it on the other, edit, delete,
    /// and have the delete stick. Everything else is a refinement of this.
    /// </summary>
    [SkippableFact]
    public async Task TwoDevicesConvergeThroughARealServer()
    {
        Skip.If(_fixture is null, "SLOPTERM_WEBDAV_URL not set");

        var collectionId = await PairAsync();

        var id = _fixture!.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);
        Assert.Equal(["prod-db"], _fixture.Phone.HostNames());

        _fixture.Phone.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.9" });
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);
        Assert.Equal("10.0.0.9", _fixture.Laptop.Host("prod-db")!.Address);

        _fixture.Laptop.Vault.DeleteHost(id);
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);
        Assert.Empty(_fixture.Phone.HostNames());

        // The resurrection check: neither side may re-upload the copy it used to hold.
        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);
        Assert.Empty(_fixture.Phone.HostNames());
        Assert.Empty(_fixture.Laptop.HostNames());
    }

    /// <summary>
    /// Both devices edit between syncs: HLC picks the winner, and the loser survives as a
    /// conflict copy even when the server's precondition handling can't be relied on.
    /// </summary>
    [SkippableFact]
    public async Task ConcurrentEditsKeepBothSidesThroughARealServer()
    {
        Skip.If(_fixture is null, "SLOPTERM_WEBDAV_URL not set");

        var collectionId = await PairAsync();
        var id = _fixture!.Laptop.SaveHost(collectionId, "prod-db", "10.0.0.5");
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        _fixture.Phone.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.7" });
        _fixture.Laptop.Vault.SaveHost(id, new HostRecord { Name = "prod-db", Address = "10.0.0.8" });

        await _fixture.Phone.SyncAsync(collectionId);
        await _fixture.Laptop.SyncAsync(collectionId);
        await _fixture.Phone.SyncAsync(collectionId);

        var names = _fixture.Phone.HostNames();
        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n.StartsWith("prod-db (conflict ", StringComparison.Ordinal));
        Assert.Equal("10.0.0.8", _fixture.Phone.Host("prod-db")!.Address);
    }

    /// <summary>
    /// Nothing readable may reach the server: read the records back as bytes and look for
    /// the host's name, address and password.
    /// </summary>
    [SkippableFact]
    public async Task TheServerOnlyEverHoldsCiphertext()
    {
        Skip.If(_fixture is null, "SLOPTERM_WEBDAV_URL not set");

        var collectionId = await PairAsync();
        _fixture!.Laptop.SaveHost(collectionId, "secret-host", "10.9.9.9",
            new CredentialRecord { Id = "c1", Kind = "password", Username = "deploy", Secret = "hunter2" });
        await _fixture.Laptop.SyncAsync(collectionId);

        using var remote = new WebDavRemote(Combine(_baseUrl!, _root), _user, _password);
        var listing = await remote.ListAsync("slopterm/v1/records/hosts", CancellationToken.None);
        Assert.NotEmpty(listing);

        foreach (var entry in listing)
        {
            var bytes = await remote.GetAsync(entry.Path, CancellationToken.None);
            var text = System.Text.Encoding.UTF8.GetString(bytes!);
            Assert.DoesNotContain("secret-host", text, StringComparison.Ordinal);
            Assert.DoesNotContain("10.9.9.9", text, StringComparison.Ordinal);
            Assert.DoesNotContain("hunter2", text, StringComparison.Ordinal);
        }
    }
}
