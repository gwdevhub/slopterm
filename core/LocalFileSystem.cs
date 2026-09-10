namespace Slopterm.Server;

// The "local" side of the SFTP dual-pane browser: lists directories on the machine running
// slopterm, same FsListing/FsEntry shape as the remote side so both panes render identically.
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

    public static void Rename(string path, string newName)
    {
        var parent = Directory.GetParent(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))?.FullName
            ?? throw new ArgumentException($"Cannot rename a root path: {path}");
        var destination = Path.Combine(parent, newName);
        if (Directory.Exists(path))
        {
            Directory.Move(path, destination);
        }
        else
        {
            File.Move(path, destination);
        }
    }

    public static void Delete(string path)
    {
        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }
        else
        {
            File.Delete(path);
        }
    }

    public static void MakeDirectory(string parentDir, string name) => Directory.CreateDirectory(Path.Combine(parentDir, name));
}
