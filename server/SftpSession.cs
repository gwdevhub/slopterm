using Renci.SshNet;

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
        var client = new SftpClient(connectionInfo);
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

    /// <summary>Uploads a local file into a remote directory, keeping its original file name.</summary>
    public async Task UploadFileAsync(string localPath, string remoteDir, CancellationToken ct)
    {
        var remotePath = JoinPosixPath(remoteDir, Path.GetFileName(localPath));
        await using var stream = File.OpenRead(localPath);
        await _client.UploadFileAsync(stream, remotePath, ct);
    }

    /// <summary>
    /// Writes raw bytes to a remote directory under the given file name, returning the full
    /// remote path they landed at. Backs the SSH tab's paste/drag-to-upload flow, where the
    /// bytes come straight from the browser (a pasted image, an OS-dropped file) rather than
    /// from a local file on disk like <see cref="UploadFileAsync"/>.
    /// </summary>
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

    /// <summary>Downloads a remote file into a local directory, keeping its original file name.</summary>
    public async Task DownloadFileAsync(string remotePath, string localDir, CancellationToken ct)
    {
        var fileName = remotePath.TrimEnd('/').Split('/').Last();
        var localPath = Path.Combine(localDir, fileName);
        await using var stream = File.Create(localPath);
        await _client.DownloadFileAsync(remotePath, stream, ct);
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
            return null; // already root
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
