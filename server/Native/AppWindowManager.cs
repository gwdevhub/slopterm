using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Photino.NET;

namespace Slopterm.Server.Native;

/// <summary>
/// Enforces "only ever one slopterm window": EnsureWindowOpen restores/focuses the
/// window if one already exists, or creates it fresh otherwise - never a second one.
/// Owns a real native window (Photino, a thin WebView2/WebKitGTK/WKWebView wrapper)
/// pointed at the same local Kestrel server everything else already talks to - unlike
/// the previous approach of launching an external browser process (BrowserLauncher.cs,
/// kept as the fallback here if the platform's webview runtime isn't installed), which
/// never gave us a window handle to reliably single-instance or reposition.
///
/// The single PhotinoWindow instance is created once and kept alive for the rest of the
/// process's lifetime - "closing" it (the X button, or the tray icon reopening it later)
/// minimizes it instead of destroying it. This isn't just a UX choice: creating a
/// *second* PhotinoWindow instance after a first one is actually destroyed reliably
/// crashes the whole process natively (a silent, unrecoverable process death - no
/// catchable .NET exception, confirmed by reproducing it directly: the process was
/// consistently gone within ~1s of the second window's Load() call completing). Never
/// destroying the window at all sidesteps that failure mode entirely, which matters more
/// than being able to fully dispose of the native window before quitting the app (which
/// happens automatically as part of process exit anyway).
/// </summary>
public static class AppWindowManager
{
    private static readonly object Lock = new();
    private static readonly ManualResetEventSlim WindowReady = new(false);
    private static PhotinoWindow? _window;

    // Only ever populated by the BrowserLauncher fallback below (no webview runtime
    // installed) - tracked so "Quit" can close these along with the rest of the app
    // instead of leaving an orphaned window pointed at a now-dead server. Every fallback
    // launch appends here rather than replacing, since clicking "Open" repeatedly while
    // still in fallback mode currently opens a new window each time (see EnsureWindowOpen -
    // it can never find a tracked native window to focus in this mode, so it always retries).
    private static readonly List<Process> FallbackBrowserProcesses = [];

    // Guards against a genuine race: EnsureWindowOpen's "does a window exist yet" check
    // and the point where RunWindow actually assigns _window happen on different threads
    // with real work (constructing the PhotinoWindow, loading the icon) in between. Two
    // calls close enough together (e.g. the tray icon's WM_LBUTTONUP firing twice for one
    // click, which does happen) could otherwise both see _window as null and each try to
    // create their own window - the second of which would hit the native crash described
    // above. This flag closes that race.
    private static bool _creating;

    // Set once from Program.cs before the first window opens. _closeToTray reports the live
    // CloseToTray setting value - read at each close, so toggling it in Settings takes
    // effect without a restart; _onQuit runs the same clean shutdown the tray's "Quit" does.
    private static Func<bool>? _closeToTray;
    private static Action? _onQuit;

    /// <summary>
    /// Wires up what closing the window does: minimize it to the tray (keeping the app
    /// running) when <paramref name="closeToTray"/> reports true, or quit outright (the
    /// default) via <paramref name="onQuit"/>. Call once at startup before the first window
    /// is opened. The predicate is evaluated at each close, not captured, so a Settings
    /// toggle applies without a restart.
    /// </summary>
    public static void Configure(Func<bool> closeToTray, Action onQuit)
    {
        _closeToTray = closeToTray;
        _onQuit = onQuit;
    }

    public static void EnsureWindowOpen(string url)
    {
        Thread thread;
        lock (Lock)
        {
            WindowsTaskbarIdentity.ConfigureProcess();

            if (_window is not null)
            {
                RestoreAndFocus(_window);
                return;
            }

            if (_creating)
            {
                return;
            }

            _creating = true;
            WindowReady.Reset();
            thread = new Thread(() => RunWindow(url)) { IsBackground = true, Name = "slopterm-window" };
            if (OperatingSystem.IsWindows())
            {
                // STA is required for the native window/webview message loop on Windows;
                // a documented no-op everywhere else, so no need to guard the call itself.
                thread.SetApartmentState(ApartmentState.STA);
            }
        }

        thread.Start();
        WindowReady.Wait();
    }

    /// <summary>
    /// Called from the tray icon's "Quit" so nothing opened on the user's behalf is left
    /// dangling once the app itself is gone - the Photino window doesn't need any special
    /// handling here (it lives on a background thread that dies with the process once
    /// Program.cs's own shutdown falls through), but a fallback browser window/tab is a
    /// completely separate OS process that Quit would otherwise never touch at all.
    /// </summary>
    public static void CloseAllFallbackBrowserWindows()
    {
        List<Process> toClose;
        lock (Lock)
        {
            toClose = [.. FallbackBrowserProcesses];
            FallbackBrowserProcesses.Clear();
        }

        foreach (var process in toClose)
        {
            try
            {
                if (process.HasExited)
                {
                    continue;
                }

                // CloseMainWindow asks it to close itself gracefully first (its own exit
                // handlers, if any, still get to run) - Kill is the fallback for a window
                // that doesn't respond (e.g. the app-mode window never got focus/a message
                // loop tick to process the close request).
                if (!process.CloseMainWindow())
                {
                    process.Kill();
                }
                else if (!process.WaitForExit(TimeSpan.FromSeconds(2)))
                {
                    process.Kill();
                }
            }
            catch
            {
                // Best-effort - Quit must never hang or crash over a browser window that
                // won't close cleanly.
            }
        }
    }

    private static void RunWindow(string url)
    {
        try
        {
            var window = new PhotinoWindow().SetTitle("slopterm");

            var iconPath = EmbeddedIcon.ExtractToTempFile();
            if (iconPath is not null)
            {
                window.SetIconFile(iconPath);
            }

            var saved = WindowPositionStore.Load();
            if (saved is not null)
            {
                window
                    .SetUseOsDefaultLocation(false)
                    .SetLocation(new Point(saved.X, saved.Y))
                    .SetUseOsDefaultSize(false)
                    .SetSize(new Size(saved.Width, saved.Height));
            }

            // Captured once, right before minimizing - not continuously via
            // LocationChanged/SizeChanged. Many windowing APIs (this one included, in
            // practice) fire spurious move/resize events as part of minimizing or
            // tearing a window down (classic Win32 reports a minimized window "moving"
            // to something like (-32000,-32000)), which would otherwise silently
            // overwrite a perfectly good saved position with garbage.
            //
            // Always returns true (cancel the native close) so Photino never destroys the
            // window here - see the class doc comment for why directly destroying it is a
            // hard "no" (creating another afterward crashes the process natively). What
            // differs is what we do instead:
            //   - CloseToTray on: minimize and leave the app running behind its tray icon.
            //   - CloseToTray off (default): quit slopterm outright. The window still isn't
            //     destroyed here - _onQuit stops the process, and letting process exit tear
            //     the window down is the one destruction path proven safe. It lingers for
            //     the instant shutdown takes, exactly as the tray's own "Quit" already does.
            window.RegisterWindowClosingHandler((_, _) =>
            {
                SavePosition(window);
                if (_closeToTray?.Invoke() == true)
                {
                    window.SetMinimized(true);
                }
                else
                {
                    _onQuit?.Invoke();
                }

                return true;
            });

            window.Load(new Uri(url));

            lock (Lock)
            {
                _window = window;
                _creating = false;
            }

            WindowReady.Set();

            // Give the taskbar window slopterm's icon. This can't be done synchronously
            // here: WebView2 clears the window's shell identity during the async init it
            // starts from Load() above, so a single set is wiped and the taskbar shows a
            // generic tile. The applier re-asserts it on its own thread until it sticks
            // (see WindowsTaskbarIdentity) - it also finds the real top-level frame itself,
            // since Photino's WindowHandle isn't the window that owns the taskbar button.
            StartTaskbarIdentityApplier();

            // Blocks this dedicated thread only - Kestrel and everything else keeps
            // running regardless of whether the window is currently visible or
            // minimized. In normal operation this never actually returns (every close
            // attempt is cancelled above); it's only reached if something outside our
            // control forces the window closed, which process exit handles regardless.
            window.WaitForClose();
        }
        catch (Exception ex)
        {
            lock (Lock)
            {
                _window = null;
                _creating = false;
            }

            WindowReady.Set();
            ReportMissingRuntime(ex);
            var fallbackProcess = BrowserLauncher.Launch(url);
            if (fallbackProcess is not null)
            {
                lock (Lock)
                {
                    FallbackBrowserProcesses.Add(fallbackProcess);
                }
            }
        }
        finally
        {
            lock (Lock)
            {
                _window = null;
                _creating = false;
            }
        }
    }

    private static void SavePosition(PhotinoWindow window)
    {
        try
        {
            var width = window.Width;
            var height = window.Height;
            if (width <= 0 || height <= 0)
            {
                // A minimized (or otherwise torn-down) window reports a nonsense size -
                // never worth persisting over whatever the last real, visible size was.
                return;
            }

            WindowPositionStore.Save(new WindowPosition { X = window.Left, Y = window.Top, Width = width, Height = height });
        }
        catch
        {
            // Best-effort - never worth crashing the window over a failed disk write.
        }
    }

    private static void RestoreAndFocus(PhotinoWindow window)
    {
        try
        {
            if (window.Minimized)
            {
                window.SetMinimized(false);
            }

            // A topmost toggle is the one cross-platform trick that reliably raises a
            // window across window managers; SetForegroundWindow is the correct, more
            // direct mechanism on Windows specifically (allowed here without the usual
            // foreground-stealing restrictions, since this process already owns the
            // window it's asking to be focused).
            window.SetTopMost(true);
            window.SetTopMost(false);
            if (OperatingSystem.IsWindows() && window.WindowHandle != nint.Zero)
            {
                SetForegroundWindow(window.WindowHandle);
            }
        }
        catch
        {
            // Best-effort - the window is still open and usable even if this fails, just
            // not brought to the front automatically.
        }
    }

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    private static void StartTaskbarIdentityApplier()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        // The applier locates the real taskbar window itself (by enumerating this process's
        // visible top-level windows) and re-applies the shell identity until it holds, so
        // there's nothing to capture from the PhotinoWindow here. Best-effort background
        // work: taskbar decoration must never affect whether the window itself opens.
        var thread = new Thread(WindowsTaskbarIdentity.ApplyWindowIdentityWithRetry)
        {
            IsBackground = true,
            Name = "slopterm-taskbar-id",
        };
        thread.Start();
    }

    /// <summary>
    /// Photino throws if the platform's webview runtime isn't installed (WebView2 on
    /// Windows, WebKitGTK on Linux/macOS) - caught in RunWindow above, which falls back
    /// to BrowserLauncher so the user isn't stranded with no way to reach the app at all.
    /// </summary>
    private static void ReportMissingRuntime(Exception ex)
    {
        var message = OperatingSystem.IsWindows()
            ? "slopterm couldn't create its window because the WebView2 Runtime isn't " +
              "installed. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ " +
              "and try again. Opening in your browser instead for now."
            : "slopterm couldn't create its window - a required native webview library " +
              "(WebKitGTK) is missing. Opening in your browser instead for now.";

        Console.WriteLine();
        Console.WriteLine(message);
        Console.WriteLine($"(Details: {ex.Message})");
        Console.WriteLine();

        if (OperatingSystem.IsWindows())
        {
            ShowMissingRuntimeMessageBox(message);
        }
    }

    [SupportedOSPlatform("windows")]
    private static void ShowMissingRuntimeMessageBox(string message)
    {
        try
        {
            MessageBox(nint.Zero, message, "slopterm", MbIconError);
        }
        catch
        {
            // The console message above already covers this - a failed message box is
            // not worth crashing over.
        }
    }

    private const uint MbIconError = 0x00000010;

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(nint hWnd, string text, string caption, uint type);
}
