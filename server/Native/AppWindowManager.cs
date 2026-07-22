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

    // Guards against a genuine race: EnsureWindowOpen's "does a window exist yet" check
    // and the point where RunWindow actually assigns _window happen on different threads
    // with real work (constructing the PhotinoWindow, loading the icon) in between. Two
    // calls close enough together (e.g. the tray icon's WM_LBUTTONUP firing twice for one
    // click, which does happen) could otherwise both see _window as null and each try to
    // create their own window - the second of which would hit the native crash described
    // above. This flag closes that race.
    private static bool _creating;

    public static void EnsureWindowOpen(string url)
    {
        Thread thread;
        lock (Lock)
        {
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
            // Cancels the close (returns true) and minimizes instead of letting the
            // native window actually be destroyed - see the class doc comment for why
            // that's a hard requirement here, not just a nicety.
            window.RegisterWindowClosingHandler((_, _) =>
            {
                SavePosition(window);
                window.SetMinimized(true);
                return true;
            });

            window.Load(new Uri(url));

            lock (Lock)
            {
                _window = window;
                _creating = false;
            }

            WindowReady.Set();

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
            BrowserLauncher.Launch(url);
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
