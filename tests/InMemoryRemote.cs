using System.Collections.Concurrent;
using System.Security.Cryptography;
using Slopterm.Server.VaultSync;

namespace Slopterm.Tests;

/// <summary>
/// An <see cref="IVaultSyncRemote"/> that lives in a dictionary, shared by every
/// <see cref="Slopterm.Server.VaultSync.VaultSyncService"/> pointed at the same URL - so two
/// "devices" in one test process converge through one store, exactly as they would through
/// one WebDAV share.
///
/// It exists alongside (not instead of) the real-server tests: this one makes the merge
/// matrix deterministic and lets a test force a 412 on demand, which no real server will
/// do reliably. Whether the WIRE format survives contact with a real server is what
/// WebDavRemoteTests and the container suite answer.
/// </summary>
public sealed class InMemoryRemote(InMemoryRemote.Store store) : IVaultSyncRemote
{
    public sealed class Store
    {
        public ConcurrentDictionary<string, (byte[] Content, string ETag)> Files { get; } = new(StringComparer.Ordinal);
        public ConcurrentDictionary<string, byte> Directories { get; } = new(StringComparer.Ordinal);

        /// <summary>Paths whose NEXT write answers 412, to exercise the retry path.</summary>
        public ConcurrentDictionary<string, byte> FailNextPrecondition { get; } = new(StringComparer.Ordinal);

        /// <summary>Set to make every write answer 403, the read-only-share case.</summary>
        public bool ReadOnly { get; set; }

        public int PutCount;
        public int GetCount;
    }

    private readonly Store _store = store;

    public Task<IReadOnlyList<RemoteEntry>> ListAsync(string prefix, CancellationToken ct)
    {
        var directory = prefix.Trim('/');
        var entries = _store.Files
            .Where(kv => IsDirectChild(directory, kv.Key))
            .Select(kv => new RemoteEntry(kv.Key, kv.Value.ETag, false))
            .ToList();

        entries.AddRange(_store.Directories.Keys
            .Where(d => IsDirectChild(directory, d))
            .Select(d => new RemoteEntry(d, null, true)));

        return Task.FromResult<IReadOnlyList<RemoteEntry>>(entries);
    }

    public Task<byte[]?> GetAsync(string path, CancellationToken ct)
    {
        Interlocked.Increment(ref _store.GetCount);
        return Task.FromResult(_store.Files.TryGetValue(path.Trim('/'), out var file) ? file.Content : null);
    }

    public Task<RemoteWriteResult> PutAsync(
        string path, byte[] content, string? ifMatch, bool ifNoneMatchStar, CancellationToken ct)
    {
        var key = path.Trim('/');
        Interlocked.Increment(ref _store.PutCount);

        if (_store.ReadOnly)
        {
            throw new VaultSyncRemoteException(403, "This collection is read-only for you.");
        }

        if (_store.FailNextPrecondition.TryRemove(key, out _))
        {
            return Task.FromResult(new RemoteWriteResult(false, true, null));
        }

        var exists = _store.Files.TryGetValue(key, out var existing);
        if (ifNoneMatchStar && exists)
        {
            return Task.FromResult(new RemoteWriteResult(false, true, null));
        }

        if (!ifNoneMatchStar && ifMatch is not null && (!exists || existing.ETag != ifMatch))
        {
            return Task.FromResult(new RemoteWriteResult(false, true, null));
        }

        var etag = $"\"{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8))}\"";
        _store.Files[key] = (content, etag);
        return Task.FromResult(new RemoteWriteResult(true, false, etag));
    }

    public Task DeleteAsync(string path, CancellationToken ct)
    {
        _store.Files.TryRemove(path.Trim('/'), out _);
        return Task.CompletedTask;
    }

    public Task EnsureDirectoryAsync(string path, CancellationToken ct)
    {
        _store.Directories[path.Trim('/')] = 0;
        return Task.CompletedTask;
    }

    private static bool IsDirectChild(string directory, string path)
    {
        if (directory.Length == 0)
        {
            return !path.Contains('/', StringComparison.Ordinal);
        }

        if (!path.StartsWith(directory + "/", StringComparison.Ordinal))
        {
            return false;
        }

        return !path[(directory.Length + 1)..].Contains('/', StringComparison.Ordinal);
    }
}
