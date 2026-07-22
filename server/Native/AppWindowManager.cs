using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Photino.NET;

namespace Slopterm.Server.Native;

/// <summary>
/// Enforces "only ever one slopterm window": EnsureWindowOpen either focuses the window
/// that's already showing, or creates a fresh one - never a second one. Owns a real
/// native window (Photino, a thin WebView2/WebKitGTK/WKWebView wrapper) pointed at the
/// same local Kestrel server everything else already talks to - unlike the previous
/// approach of launching an external browser process (BrowserLauncher.cs, kept as the
/// fallback here if the platform's webview runtime isn't installed), which never gave us
/// a window handle to reliably single-instance or reposition.
/// </summary>
public static class AppWindowManager
{
    private static readonly object Lock = new();
    private static readonly ManualResetEventSlim WindowReady = new(false);
    private static PhotinoWindow? _window;

    public static void EnsureWindowOpen(string url)
    {
        lock (Lock)
        {
            if (_window is not null)
            {
                FocusExistingWindow(_window);
                return;
            }
        }

        WindowReady.Reset();
        var thread = new Thread(() => RunWindow(url)) { IsBackground = true, Name = "slopterm-window" };
        if (OperatingSystem.IsWindows())
        {
            // STA is required for the native window/webview message loop on Windows;
            // a documented no-op everywhere else, so no need to guard the call itself.
            thread.SetApartmentState(ApartmentState.STA);
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

            window.RegisterLocationChangedHandler((_, _) => SavePosition(window));
            window.RegisterSizeChangedHandler((_, _) => SavePosition(window));
            window.RegisterWindowClosingHandler((_, _) =>
            {
                lock (Lock)
                {
                    _window = null;
                }

                return false; // false = allow the close to proceed, don't cancel it
            });

            window.Load(new Uri(url));

            lock (Lock)
            {
                _window = window;
            }

            WindowReady.Set();

            // Blocks this dedicated thread only - Kestrel and everything else keeps
            // running regardless of whether a window is currently open.
            window.WaitForClose();
        }
        catch (Exception ex)
        {
            lock (Lock)
            {
                _window = null;
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
            }
        }
    }

    private static void SavePosition(PhotinoWindow window)
    {
        try
        {
            WindowPositionStore.Save(new WindowPosition { X = window.Left, Y = window.Top, Width = window.Width, Height = window.Height });
        }
        catch
        {
            // Best-effort - never worth crashing the window over a failed disk write.
        }
    }

    private static void FocusExistingWindow(PhotinoWindow window)
    {
        try
        {
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
