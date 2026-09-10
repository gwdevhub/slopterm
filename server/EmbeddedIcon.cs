using System.Reflection;

namespace Slopterm.Server;

/// <summary>
/// Extracts the embedded app icon to a temp file once: app.ico on Windows (LoadImage wants
/// it), app.png elsewhere (GTK's icon loader rejects PNG-compressed .ico entries).
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
