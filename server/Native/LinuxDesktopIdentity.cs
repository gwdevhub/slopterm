using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Slopterm.Server.Native;

/// <summary>
/// Wayland shells resolve icons from the desktop entry matching the window's app_id;
/// GTK's per-window PNG only supplies an icon on X11. Configure before GTK initializes.
/// </summary>
[SupportedOSPlatform("linux")]
internal static class LinuxDesktopIdentity
{
    internal const string AppId = "com.gwdevhub.slopterm";

    public static void Configure()
    {
        try
        {
            g_set_prgname(AppId);
            g_set_application_name("slopterm");
            gdk_set_program_class(AppId);

            var dataHome = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
            if (string.IsNullOrEmpty(dataHome) || !Path.IsPathFullyQualified(dataHome))
            {
                dataHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
            }

            // Persist the icon: a desktop shell may resolve it after the temporary files
            // from this launch have gone away. Use the same embedded artwork as Windows.
            var iconPath = Path.Combine(dataHome, "slopterm", "app.png");
            using var icon = typeof(LinuxDesktopIdentity).Assembly.GetManifestResourceStream("Slopterm.Server.Native.app.png");
            if (icon is null || Environment.ProcessPath is not { } executable) return;
            using var bytes = new MemoryStream();
            icon.CopyTo(bytes);
            WriteIfChanged(iconPath, bytes.ToArray());

            var command = QuoteArgument(executable);
            // A development launch uses the dotnet host; a published app uses its apphost.
            if (Path.GetFileName(executable) == "dotnet" && Assembly.GetEntryAssembly()?.Location is { Length: > 0 } assemblyPath)
            {
                command += " " + QuoteArgument(assemblyPath);
            }

            var entry = "[Desktop Entry]\n" +
                "Type=Application\nName=slopterm\n" +
                $"Exec={EscapeValue(command)}\n" +
                $"Icon={EscapeValue(iconPath)}\n" +
                $"StartupWMClass={AppId}\n" +
                "Terminal=false\nNoDisplay=true\nCategories=Network;TerminalEmulator;\n";
            // This is shell identity metadata, not an extra launcher in the user's menu.
            WriteIfChanged(Path.Combine(dataHome, "applications", AppId + ".desktop"),
                System.Text.Encoding.UTF8.GetBytes(entry));
        }
        catch (Exception ex)
        {
            // A read-only profile or missing GTK must not prevent the app from opening.
            Console.WriteLine($"Couldn't register the Linux app icon: {ex.Message}");
        }
    }

    private static string QuoteArgument(string value) => "\"" + value
        .Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("`", "\\`")
        .Replace("$", "\\$").Replace("%", "%%") + "\"";

    private static string EscapeValue(string value) => value.Replace("\\", "\\\\")
        .Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");

    private static void WriteIfChanged(string path, byte[] contents)
    {
        if (File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(contents)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, contents);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    [DllImport("libglib-2.0.so.0")]
    private static extern void g_set_prgname([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport("libglib-2.0.so.0")]
    private static extern void g_set_application_name([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport("libgdk-3.so.0")]
    private static extern void gdk_set_program_class([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
}
