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

    /// <summary>Downloads a remote file into a local directory, keeping its original file name.</summary>
    public async Task DownloadFileAsync(string remotePath, string localDir, CancellationToken ct)
    {
        var fileName = remotePath.TrimEnd('/').Split('/').Last();
        var localPath = Path.Combine(localDir, fileName);
        await using var stream = File.Create(localPath);
        await _client.DownloadFileAsync(remotePath, stream, ct);
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
