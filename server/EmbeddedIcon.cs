using System.Reflection;

namespace Slopterm.Server;

/// <summary>
/// Extracts the embedded app icon (same design as favicon.svg/the PWA icons) to a temp
/// file once - shared by WindowsTrayIcon (needs a file path for Win32's LoadImage, which
/// wants the .ico) and AppWindowManager (Photino's SetIconFile - on Linux this goes
/// through GTK's icon loader, which rejects app.ico's PNG-compressed entries with
/// "Compressed icons are not supported", so a plain .png is used there instead; Windows
/// keeps using the .ico, matching WindowsTrayIcon's LoadImage).
/// </summary>
public static class EmbeddedIcon
{
    public static string? ExtractToTempFile() => ExtractToTempFile(OperatingSystem.IsWindows() ? "app.ico" : "app.png");

    private static string? ExtractToTempFile(string resourceFileName)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = Array.Find(assembly.GetManifestResourceNames(), n => n.EndsWith(resourceFileName, StringComparison.Ordinal));
        if (resourceName is null)
        {
            return null;
        }

        using var stream = assembly.GetManifestResourceStream(resourceName)!;
        var tempPath = Path.Combine(Path.GetTempPath(), $"slopterm-{resourceFileName}");
        using (var fileStream = File.Create(tempPath))
        {
            stream.CopyTo(fileStream);
        }

        return tempPath;
    }
}
