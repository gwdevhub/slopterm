using Renci.SshNet;
using Renci.SshNet.Sftp;

namespace Slopterm.Server;

public sealed record FsEntry(string Name, bool IsDirectory, long Size, DateTime ModifiedUtc);

public sealed record FsListing(string Path, string? Parent, IReadOnlyList<FsEntry> Entries);

public sealed class SftpSession : IDisposable
{
    private readonly SftpClient _client;

    public string Id { get; }
    public string Host { get; }
    public int Port { get; }
    public string Username { get; }
    public string HomeDirectory { get; }

    /// <summary>Whether the SSH link under this SFTP channel is still up - nothing else would
    /// notice it going stale, and a stale session looks connected but fails on every click.</summary>
    public bool IsConnected
    {
        get
        {
            try
            {
                return _client.IsConnected;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    private SftpSession(string id, SftpClient client, string host, int port, string username)
    {
        Id = id;
        _client = client;
        Host = host;
        Port = port;
        Username = username;
        HomeDirectory = client.WorkingDirectory;
    }

    public static SftpSession Connect(ConnectRequest request)
    {
        var connectionInfo = SshConnectionInfoFactory.Create(request);
        var client = new SftpClient(connectionInfo)
        {
            // An idle SFTP channel is reaped just like an idle shell, which showed up as the
            // first click after a long idle failing. Set on the client (BaseClient, not ConnectionInfo).
            KeepAliveInterval = TimeSpan.FromSeconds(30),
        };
        client.Connect();
        return new SftpSession(Guid.NewGuid().ToString("N"), client, request.Host, request.Port, request.Username);
    }

    // Remote paths are always POSIX-style (the server's own OS, not this SFTP client's),
    // regardless of what OS slopterm itself is running on.
    public FsListing ListDirectory(string? path)
    {
        var target = string.IsNullOrEmpty(path) ? HomeDirectory : path;
        var entries = _client.ListDirectory(target)
            .Where(e => e.Name != "." && e.Name != "..")
            .Select(e => new FsEntry(e.Name, e.IsDirectory, e.IsDirectory ? 0 : e.Length, e.LastWriteTimeUtc))
            .OrderByDescending(e => e.IsDirectory)
            .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new FsListing(target, ComputePosixParent(target), entries);
    }

    /// <summary>Copies a local file or folder into a remote directory, keeping its name.</summary>
    public async Task UploadAsync(string localPath, string remoteDir, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        localPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(localPath));
        SftpPaths.RejectLocalLink(localPath);
        var name = Path.GetFileName(localPath);
        if (string.IsNullOrEmpty(name))
        {
            throw new ArgumentException("Select a file or folder, rather than a filesystem root.");
        }

        if (!Directory.Exists(localPath))
        {
            await UploadFileAsync(localPath, remoteDir, ct);
            return;
        }

        var destination = SftpPaths.JoinRemote(remoteDir, name);
        EnsureRemoteDirectory(destination);
        foreach (var child in Directory.EnumerateFileSystemEntries(localPath))
        {
            await UploadAsync(child, destination, ct);
        }
    }

    private async Task UploadFileAsync(string localPath, string remoteDir, CancellationToken ct)
    {
        var remotePath = JoinPosixPath(remoteDir, Path.GetFileName(localPath));
        await using var stream = File.OpenRead(localPath);
        await _client.UploadFileAsync(stream, remotePath, ct);
    }

    /// <summary>Writes raw bytes to a remote directory under the given name; backs the SSH
    /// tab's paste/drag-to-upload flow (bytes from the browser, not a local file).</summary>
    public async Task<string> WriteBytesAsync(string remoteDir, string fileName, byte[] data, CancellationToken ct)
    {
        var remotePath = JoinPosixPath(remoteDir, fileName);
        using var stream = new MemoryStream(data);
        await _client.UploadFileAsync(stream, remotePath, ct);
        return remotePath;
    }

    /// <summary>Uploads raw file bytes (an OS-dragged file, which only exists in the browser
    /// as bytes - no path on disk) into a remote directory under the given file name.</summary>
    public async Task UploadBytesAsync(Stream content, string fileName, string remoteDir, CancellationToken ct)
    {
        var remotePath = JoinPosixPath(remoteDir, Path.GetFileName(fileName));
        await _client.UploadFileAsync(content, remotePath, ct);
    }

    /// <summary>Copies a remote file or folder into a local directory, including empty folders.</summary>
    public async Task DownloadAsync(string remotePath, string localDir, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        remotePath = remotePath.TrimEnd('/');
        SftpPaths.RemoteName(remotePath);
        var source = FindRemoteEntry(_client, remotePath)
            ?? throw new FileNotFoundException($"Remote file or folder not found: {remotePath}");
        await DownloadEntryAsync(remotePath, localDir, source, ct);
    }

    private async Task DownloadEntryAsync(string remotePath, string localDir, ISftpFile source, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var localPath = SftpPaths.LocalChild(localDir, SftpPaths.RemoteName(remotePath));
        if (source.IsSymbolicLink)
        {
            throw new IOException($"Symbolic links are not supported for folder transfers: {remotePath}");
        }

        if (!source.IsDirectory)
        {
            await DownloadFileAsync(remotePath, localPath, ct);
            return;
        }

        Directory.CreateDirectory(localPath);
        foreach (var entry in _client.ListDirectory(remotePath).Where(e => e.Name != "." && e.Name != ".."))
        {
            // Validate the server-supplied leaf itself, before composing a remote path.
            SftpPaths.LocalChild(localPath, entry.Name);
            await DownloadEntryAsync(SftpPaths.JoinRemote(remotePath, entry.Name), localPath, entry, ct);
        }
    }

    private async Task DownloadFileAsync(string remotePath, string localPath, CancellationToken ct)
    {
        await using var stream = File.Create(localPath);
        await _client.DownloadFileAsync(remotePath, stream, ct);
    }

    private void EnsureRemoteDirectory(string path)
    {
        var entry = FindRemoteEntry(_client, path);
        if (entry is null)
        {
            _client.CreateDirectory(path);
            return;
        }

        if (!entry.IsDirectory || entry.IsSymbolicLink)
        {
            throw new IOException($"The remote destination is not a regular folder: {path}");
        }
    }

    // SSH.NET canonicalizes Get/GetAttributes paths before lstat, which can resolve a
    // symlink. Parent listings retain the entry's actual type, including dangling links.
    internal static ISftpFile? FindRemoteEntry(SftpClient client, string path)
    {
        var trimmed = path.TrimEnd('/');
        var separator = trimmed.LastIndexOf('/');
        var parent = separator < 0 ? "." : separator == 0 ? "/" : trimmed[..separator];
        var name = trimmed[(separator + 1)..];
        return client.ListDirectory(parent).FirstOrDefault(entry => entry.Name == name);
    }

    /// <summary>Renames (or moves within the same parent) a remote file or directory to a new leaf name.</summary>
    public void Rename(string path, string newName)
    {
        var parent = ComputePosixParent(path) ?? "/";
        _client.RenameFile(path, JoinPosixPath(parent, newName));
    }

    /// <summary>Deletes a remote file or directory (directories are removed recursively).</summary>
    public void Delete(string path)
    {
        if (_client.GetAttributes(path).IsDirectory)
        {
            DeleteDirectoryRecursive(path);
        }
        else
        {
            _client.DeleteFile(path);
        }
    }

    /// <summary>Creates a new directory under the given remote parent directory.</summary>
    public void MakeDirectory(string parentDir, string name) => _client.CreateDirectory(JoinPosixPath(parentDir, name));

    // SSH.NET's DeleteDirectory only removes an empty directory, so drain the children first.
    private void DeleteDirectoryRecursive(string path)
    {
        foreach (var entry in _client.ListDirectory(path).Where(e => e.Name != "." && e.Name != ".."))
        {
            if (entry.IsDirectory)
            {
                DeleteDirectoryRecursive(entry.FullName);
            }
            else
            {
                _client.DeleteFile(entry.FullName);
            }
        }

        _client.DeleteDirectory(path);
    }

    private static string JoinPosixPath(string dir, string name) => dir.EndsWith('/') ? dir + name : dir + "/" + name;

    private static string? ComputePosixParent(string path)
    {
        var trimmed = path.TrimEnd('/');
        if (string.IsNullOrEmpty(trimmed))
        {
            return null;
        }

        var idx = trimmed.LastIndexOf('/');
        if (idx < 0)
        {
            return null;
        }

        return idx == 0 ? "/" : trimmed[..idx];
    }

    public void Dispose()
    {
        if (_client.IsConnected)
        {
            _client.Disconnect();
        }

        _client.Dispose();
    }
}
