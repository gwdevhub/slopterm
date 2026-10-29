using Slopterm.Server;
using Xunit;

namespace Slopterm.Tests;

public sealed class SftpPathsTests
{
    [Theory]
    [InlineData("/", "folder", "/folder")]
    [InlineData("/home/user/", "nested folder", "/home/user/nested folder")]
    [InlineData("relative", "資料", "relative/資料")]
    [InlineData("/srv", "a\\b", "/srv/a\\b")]
    public void JoinRemote_AlwaysUsesPosixSeparators(string directory, string name, string expected)
    {
        Assert.Equal(expected, SftpPaths.JoinRemote(directory, name));
    }

    [Fact]
    public void DownloadPaths_PreserveNamesAndNestedDirectories()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Assert.Equal("nested folder", SftpPaths.RemoteName("/srv/nested folder///"));
        Assert.Equal(Path.Combine(root, "nested folder", "資料.txt"), SftpPaths.LocalRelative(root, "nested folder/資料.txt"));
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("/absolute")]
    [InlineData("../outside")]
    [InlineData("nested/../../outside")]
    [InlineData("nested//file")]
    public void DownloadPaths_RejectTraversalAndEmptyNames(string relative)
    {
        Assert.Throws<ArgumentException>(() => SftpPaths.LocalRelative(Path.GetTempPath(), relative));
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/srv/..")]
    [InlineData("/srv/.")]
    public void RemoteName_RejectsRootsAndSpecialEntries(string path)
    {
        Assert.Throws<ArgumentException>(() => SftpPaths.RemoteName(path));
    }

    [Fact]
    public void DownloadPaths_ValidateAgainstTheLocalOperatingSystem()
    {
        if (OperatingSystem.IsWindows())
        {
            foreach (var name in new[] { "..\\outside", "C:\\outside", "file:stream", "folder.", "folder " })
            {
                Assert.Throws<ArgumentException>(() => SftpPaths.LocalChild(Path.GetTempPath(), name));
            }
        }
        else
        {
            Assert.Equal(Path.Combine(Path.GetTempPath(), "a\\b"), SftpPaths.LocalChild(Path.GetTempPath(), "a\\b"));
        }
    }

    [Fact]
    public void DownloadPaths_RejectExistingSymlinkDestinations()
    {
        // Windows link creation needs privileges that a regular test runner may not have.
        if (OperatingSystem.IsWindows()) return;
        var root = Path.Combine(Path.GetTempPath(), $"slopterm-sftp-paths-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            Directory.CreateSymbolicLink(Path.Combine(root, "link"), Path.GetTempPath());
            Assert.Throws<IOException>(() => SftpPaths.LocalChild(root, "link"));
            Assert.Throws<IOException>(() => SftpPaths.LocalRelative(root, "link/outside.txt"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
