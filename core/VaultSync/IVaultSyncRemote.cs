namespace Slopterm.Server.VaultSync;

/// <summary>
/// One listing entry: a collection-root-relative path plus the server's version tag. ETag null
/// means the sync loop always re-fetches rather than erroring.
/// </summary>
public sealed record RemoteEntry(string Path, string? ETag, bool IsCollection);

/// <summary>
/// The result of a conditional PUT. PreconditionFailed maps HTTP 412 (someone else wrote first),
/// which the merge loop handles by re-fetching.
/// </summary>
public sealed record RemoteWriteResult(bool Ok, bool PreconditionFailed, string? ETag);

/// <summary>
/// The storage side of vault sync: list/get/put/delete over opaque bytes at opaque paths, with no
/// idea what a collection or key is. Paths are collection-root-relative and never start with "/".
/// </summary>
public interface IVaultSyncRemote
{
    /// <summary>Depth-1 listing. An absent directory is an empty list, not an error.</summary>
    Task<IReadOnlyList<RemoteEntry>> ListAsync(string prefix, CancellationToken ct);

    /// <summary>Null when the path doesn't exist.</summary>
    Task<byte[]?> GetAsync(string path, CancellationToken ct);

    /// <summary>
    /// ifMatch is the caller's last known ETag ("create only" when <paramref name="ifNoneMatchStar"/>
    /// is set). Best-effort: callers must still handle racing writers - see the HLC fallback.
    /// </summary>
    Task<RemoteWriteResult> PutAsync(string path, byte[] content, string? ifMatch, bool ifNoneMatchStar, CancellationToken ct);

    /// <summary>Deleting something that's already gone succeeds - that's the desired end state.</summary>
    Task DeleteAsync(string path, CancellationToken ct);

    /// <summary>Creates the collection root and any directories the sync layout needs.</summary>
    Task EnsureDirectoryAsync(string path, CancellationToken ct);
}
