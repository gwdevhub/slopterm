namespace Slopterm.Server;

// The "local" side of the SFTP dual-pane browser - lists directories on the machine
// running slopterm itself, using the same FsListing/FsEntry shape SftpSession returns for
// the remote side so the frontend can render both panes with identical logic.
public static class LocalFileSystem
{
    public static FsListing ListDirectory(string? path)
    {
        var target = string.IsNullOrEmpty(path)
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            : path;

        var dir = new DirectoryInfo(target);
        if (!dir.Exists)
        {
            throw new DirectoryNotFoundException($"Directory not found: {target}");
        }

        var entries = dir.GetFileSystemInfos()
            .Select(e => new FsEntry(e.Name, e is DirectoryInfo, e is FileInfo f ? f.Length : 0, e.LastWriteTimeUtc))
            .OrderByDescending(e => e.IsDirectory)
            .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new FsListing(dir.FullName, dir.Parent?.FullName, entries);
    }
}
