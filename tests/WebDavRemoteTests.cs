using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// Exercises <see cref="WebDavRemote"/> against a REAL WebDAV server, because the whole
/// reason that class exists is that servers disagree with each other about trailing
/// slashes, percent-encoding, whether PROPFIND returns the collection itself, and whether
/// MKCOL on an existing path is 405 or 201. A mocked handler would only ever confirm what
/// this code already assumes.
///
/// Skipped unless SLOPTERM_WEBDAV_URL is set, so a normal `dotnet test` never depends on
/// the network. Point it at any share:
///   SLOPTERM_WEBDAV_URL=https://…  SLOPTERM_WEBDAV_USER=…  SLOPTERM_WEBDAV_PASS=…
/// The integration suite (see WebDavIntegrationTests) sets these from its containers.
/// </summary>
public sealed class WebDavRemoteTests
{
    private static (string Url, string? User, string? Password)? Config()
    {
        var url = Environment.GetEnvironmentVariable("SLOPTERM_WEBDAV_URL");
        return string.IsNullOrEmpty(url)
            ? null
            : (url, Environment.GetEnvironmentVariable("SLOPTERM_WEBDAV_USER"),
                    Environment.GetEnvironmentVariable("SLOPTERM_WEBDAV_PASS"));
    }

    [SkippableFact]
    public async Task RoundTripsRecordsThroughEveryVerbTheSyncLoopUses()
    {
        var config = Config();
        Skip.If(config is null, "SLOPTERM_WEBDAV_URL not set");

        using var remote = new WebDavRemote(config!.Value.Url, config.Value.User, config.Value.Password);
        var root = $"slopterm-test-{Guid.NewGuid():N}";
        var ct = CancellationToken.None;

        try
        {
            // MKCOL, non-recursively, one segment at a time.
            await remote.EnsureDirectoryAsync($"{root}/records/hosts", ct);

            // MKCOL again on the same path: 405 (or 301) has to read as "it exists now".
            await remote.EnsureDirectoryAsync($"{root}/records/hosts", ct);

            var payload = "{\"hello\":\"world\"}"u8.ToArray();
            var created = await remote.PutAsync($"{root}/records/hosts/one.json", payload, null, true, ct);
            Assert.True(created.Ok);

            var fetched = await remote.GetAsync($"{root}/records/hosts/one.json", ct);
            Assert.NotNull(fetched);
            Assert.Equal(payload, fetched);

            // PROPFIND must list the file and NOT the collection describing itself.
            var listing = await remote.ListAsync($"{root}/records/hosts", ct);
            Assert.Single(listing);
            Assert.Equal($"{root}/records/hosts/one.json", listing[0].Path);
            Assert.False(listing[0].IsCollection);

            // A missing directory is an empty listing, never an exception - the sync loop
            // PROPFINDs scopes that may never have been written.
            Assert.Empty(await remote.ListAsync($"{root}/records/never-written", ct));

            // Nothing there yet.
            Assert.Null(await remote.GetAsync($"{root}/records/hosts/missing.json", ct));

            await remote.DeleteAsync($"{root}/records/hosts/one.json", ct);
            Assert.Null(await remote.GetAsync($"{root}/records/hosts/one.json", ct));

            // Deleting what's already gone succeeds: that's the end state the caller wanted.
            await remote.DeleteAsync($"{root}/records/hosts/one.json", ct);
        }
        finally
        {
            try
            {
                await remote.DeleteAsync(root, CancellationToken.None);
            }
            catch (VaultSyncRemoteException)
            {
                // best-effort cleanup
            }
        }
    }

    /// <summary>
    /// If-None-Match: * must fail the second create, and If-Match must fail against a stale
    /// ETag - or report success in a way the caller can tell apart, since some servers
    /// ignore preconditions entirely. Either answer is fine; silently succeeding while
    /// claiming a precondition held is not.
    /// </summary>
    [SkippableFact]
    public async Task ReportsPreconditionFailuresRatherThanThrowing()
    {
        var config = Config();
        Skip.If(config is null, "SLOPTERM_WEBDAV_URL not set");

        using var remote = new WebDavRemote(config!.Value.Url, config.Value.User, config.Value.Password);
        var root = $"slopterm-test-{Guid.NewGuid():N}";
        var path = $"{root}/one.json";
        var ct = CancellationToken.None;

        try
        {
            await remote.EnsureDirectoryAsync(root, ct);
            var first = await remote.PutAsync(path, "1"u8.ToArray(), null, true, ct);
            Assert.True(first.Ok);

            var second = await remote.PutAsync(path, "2"u8.ToArray(), null, true, ct);
            if (!second.Ok)
            {
                Assert.True(second.PreconditionFailed);
            }

            var stale = await remote.PutAsync(path, "3"u8.ToArray(), "\"definitely-not-the-current-etag\"", false, ct);
            if (!stale.Ok)
            {
                Assert.True(stale.PreconditionFailed);
            }
        }
        finally
        {
            try
            {
                await remote.DeleteAsync(root, CancellationToken.None);
            }
            catch (VaultSyncRemoteException)
            {
                // best-effort cleanup
            }
        }
    }

    [Fact]
    public void RejectsAUrlThatIsntHttp()
    {
        Assert.Throws<ArgumentException>(() => new WebDavRemote("ftp://example.com/dav", null, null));
        Assert.Throws<ArgumentException>(() => new WebDavRemote("not a url", null, null));
    }
}
