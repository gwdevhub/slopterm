using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Slopterm.Server;

/// <summary>
/// Global safety net installed before anything else can throw; turns a silent no-console
/// crash into a crash.log entry plus a Windows message box. LogPhase breadcrumbs startup so
/// even native crashes and clean exits are diagnosable.
/// </summary>
public static class CrashLogger
{
    private static string LogPath => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "crash.log");
    private static string StartupLogPath => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "startup.log");
    private static bool _startupLogStarted;

    public static void Install()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Report(e.ExceptionObject as Exception);

        // Exceptions on a fire-and-forget Task don't reach UnhandledException and are silently
        // dropped when the Task is finalized, so log these too.
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Report(e.Exception);
            e.SetObserved();
        };
    }

    /// <summary>Appends a timestamped startup/lifecycle breadcrumb; the last line is the
    /// furthest point reached. Best-effort and never throws.</summary>
    public static void LogPhase(string phase)
    {
        var line = $"[{Now()}] {phase}{Environment.NewLine}";
        try
        {
            Directory.CreateDirectory(Vault.AppPaths.GetVaultDirectory());
            if (!_startupLogStarted)
            {
                _startupLogStarted = true;
                File.WriteAllText(StartupLogPath, line);
            }
            else
            {
                File.AppendAllText(StartupLogPath, line);
            }
        }
        catch
        {
            // A breadcrumb that can't be written is not worth taking the app down over.
        }

        Console.Error.WriteLine($"slopterm startup: {phase}");
    }

    private static void Report(Exception? ex)
    {
        var text = ex?.ToString() ?? "(non-Exception object thrown - no further details available)";

        // Also to stderr, which is visible under plain `dotnet run` even without the
        // no-console published build this exists for.
        Console.Error.WriteLine();
        Console.Error.WriteLine("slopterm crashed:");
        Console.Error.WriteLine(text);

        LogPhase("CRASH (see crash.log)");

        string? loggedTo = null;
        try
        {
            Directory.CreateDirectory(Vault.AppPaths.GetVaultDirectory());
            File.AppendAllText(LogPath, $"[{Now()}]{Environment.NewLine}{text}{Environment.NewLine}{Environment.NewLine}");
            loggedTo = LogPath;
        }
        catch (IOException)
        {
            // The message box still shows the raw details even when this fails.
        }

        if (OperatingSystem.IsWindows())
        {
            var message = loggedTo is not null
                ? $"slopterm hit an unexpected error and needs to close:\n\n{ex?.Message}\n\nFull details were saved to:\n{loggedTo}"
                : $"slopterm hit an unexpected error and needs to close:\n\n{text}";
            ShowMessageBox(message);
        }
    }

    private static string Now() => DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz");

    [SupportedOSPlatform("windows")]
    private static void ShowMessageBox(string message)
    {
        try
        {
            MessageBox(nint.Zero, message, "slopterm", MbIconError);
        }
        catch
        {
            // The stderr/log-file output above already covers this - a failed message box
            // is not worth crashing over (again).
        }
    }

    private const uint MbIconError = 0x00000010;

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(nint hWnd, string text, string caption, uint type);
}
