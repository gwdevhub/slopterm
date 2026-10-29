namespace Slopterm.Server;

// Remote paths use POSIX separators even when slopterm runs on Windows. A remote
// name must also be a valid *local* leaf before a download creates anything on disk.
public static class SftpPaths
{
    public static string JoinRemote(string directory, string name) =>
        directory.EndsWith('/') ? directory + name : directory + "/" + name;

    public static string RemoteName(string path)
    {
        var trimmed = path.TrimEnd('/');
        var name = trimmed[(trimmed.LastIndexOf('/') + 1)..];
        ValidateLocalName(name);
        return name;
    }

    public static string LocalChild(string directory, string name)
    {
        ValidateLocalName(name);
        var path = Path.Combine(directory, name);
        RejectLocalLink(path);
        return path;
    }

    public static string LocalRelative(string directory, string relative)
    {
        var path = directory;
        foreach (var name in relative.Split('/'))
        {
            path = LocalChild(path, name);
        }

        return path;
    }

    public static void RejectLocalLink(string path)
    {
        // File.Exists/Directory.Exists alone miss dangling links.
        try
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException($"Symbolic links are not supported for folder transfers: {path}");
            }
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }

    private static void ValidateLocalName(string name)
    {
        if (string.IsNullOrEmpty(name) || name is "." or ".." || name.Contains('/') ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            (OperatingSystem.IsWindows() && (name.EndsWith(' ') || name.EndsWith('.'))))
        {
            throw new ArgumentException($"Not a valid local file or folder name: {name}");
        }
    }
}
