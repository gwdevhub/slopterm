using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Slopterm.Server;

/// <summary>
/// Global safety net installed as the very first thing Program.cs does, before the port
/// probe, vault init, or window creation can throw. Without this, an unhandled exception
/// on the published Windows build (no console - see the .csproj's WinExe OutputType, only
/// applied for win-x64) just closes the process with zero visible trace: no console to
/// print to, nothing on disk, nothing on screen. This turns that into a crash.log entry
/// plus (on Windows) a message box, so "it flashed and closed" becomes something
/// diagnosable instead of a dead end.
///
/// Two things it deliberately CANNOT catch, which is exactly why LogPhase (below) exists:
/// a genuine native crash with no .NET exception (e.g. the WebView2 window blowing up - see
/// AppWindowManager's doc comment), and a *clean* process exit (the window closing quits the
/// app by default). Both present to the user as "tray icon appeared, then it vanished with no
/// error." The startup-phase breadcrumb log turns even those into something we can read back:
/// whatever phase startup.log ends on is where it died (or, if it ends on a shutdown line, it
/// exited on purpose rather than crashing).
/// </summary>
public static class CrashLogger
{
    private static string LogPath => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "crash.log");
    private static string StartupLogPath => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "startup.log");
    private static bool _startupLogStarted;

    public static void Install()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Report(e.ExceptionObject as Exception);

        // Exceptions on a fire-and-forget Task don't reach UnhandledException and (in modern
        // .NET) don't terminate the process - they're just silently dropped when the Task is
        // finalized. Several startup paths run background work like that (the window thread,
        // ForwardingService's per-host loops), so log these too rather than lose them.
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Report(e.Exception);
            e.SetObserved();
        };
    }

    /// <summary>
    /// Appends a one-line, timestamped startup/lifecycle breadcrumb to startup.log (truncated
    /// once per process, so the file always reflects the current launch). The last line is the
    /// furthest point startup reached - the single most useful fact when the app dies with no
    /// catchable exception. Best-effort and never throws: diagnostics must not become the crash.
    /// </summary>
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

        // Also to stderr - visible whenever there IS a console (plain `dotnet run`/
        // `dotnet build` without -r stays a normal console app on every OS), not just the
        // no-console published Windows build this exists for.
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
            // The message box below still shows the raw details even when this fails - a
            // crash report that can't write to disk shouldn't also be why the user never
            // learns the process died.
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
