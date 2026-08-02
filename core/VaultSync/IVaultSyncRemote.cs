namespace Slopterm.Server.VaultSync;

/// <summary>
/// One entry returned by <see cref="IVaultSyncRemote.ListAsync"/> - a remote path relative
/// to the collection root, plus whatever the server offered as its version tag. ETag is
/// null when a server doesn't return one at all (some don't for collections), which the
/// sync loop treats as "always re-fetch" rather than an error.
/// </summary>
public sealed record RemoteEntry(string Path, string? ETag, bool IsCollection);

/// <summary>
/// The result of a conditional PUT. Etag is the server's new tag when it bothered to
/// return one; PreconditionFailed maps HTTP 412 (someone else wrote first), which the
/// merge loop handles by re-fetching rather than failing the sync.
/// </summary>
public sealed record RemoteWriteResult(bool Ok, bool PreconditionFailed, string? ETag);

/// <summary>
/// The storage side of vault sync, kept deliberately dumb: list/get/put/delete over opaque
/// bytes at opaque paths, with no idea what a collection, record or key is. WebDAV is the
/// only implementation today (see <see cref="WebDavRemote"/>); git or S3 can follow without
/// the merge logic in <see cref="VaultSyncService"/> having to learn anything new.
///
/// Paths are always relative to the collection root the remote was constructed with, use
/// forward slashes, and never start with one - e.g. "records/host/01J….json".
/// </summary>
public interface IVaultSyncRemote
{
    /// <summary>Depth-1 listing. An absent directory is an empty list, not an error.</summary>
    Task<IReadOnlyList<RemoteEntry>> ListAsync(string prefix, CancellationToken ct);

    /// <summary>Null when the path doesn't exist.</summary>
    Task<byte[]?> GetAsync(string path, CancellationToken ct);

    /// <summary>
    /// ifMatch is the caller's last known ETag ("create only" when
    /// <paramref name="ifNoneMatchStar"/> is set instead). Both are best-effort: servers
    /// disagree about precondition support, so a caller must still handle two writers
    /// racing without one - see VaultSyncService's HLC fallback.
    /// </summary>
    Task<RemoteWriteResult> PutAsync(string path, byte[] content, string? ifMatch, bool ifNoneMatchStar, CancellationToken ct);

    /// <summary>Deleting something that's already gone succeeds - that's the desired end state.</summary>
    Task DeleteAsync(string path, CancellationToken ct);

    /// <summary>Creates the collection root and any directories the sync layout needs.</summary>
    Task EnsureDirectoryAsync(string path, CancellationToken ct);
}
