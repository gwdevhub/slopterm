using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Photino.NET;

namespace Slopterm.Server.Native;

/// <summary>
/// Enforces "only ever one slopterm window": EnsureWindowOpen restores/focuses the existing
/// window or creates it. The PhotinoWindow is never destroyed - recreating one after destruction
/// crashes the process natively with no catchable exception.
/// </summary>
public static class AppWindowManager
{
    private static readonly object Lock = new();
    private static readonly ManualResetEventSlim WindowReady = new(false);
    private static PhotinoWindow? _window;

    // Only populated by the BrowserLauncher fallback; tracked so Quit can close these rather
    // than leave an orphaned window pointed at a now-dead server.
    private static readonly List<Process> FallbackBrowserProcesses = [];

    // Guards the race where two EnsureWindowOpen calls both see _window as null and each try
    // to create a window - the second of which hits the native crash.
    private static bool _creating;

    // Set once from Program.cs before the first window opens; _closeToTray is read live at each
    // close (toggling applies without restart) and _onQuit runs the clean tray "Quit" shutdown.
    private static Func<bool>? _closeToTray;
    private static Action? _onQuit;

    // True once the webview has posted its first message; an outbound SendWebMessage before that
    // (during window creation) dereferences a nonexistent webview - an uncatchable native crash.
    private static volatile bool _webviewReady;

    // The taskbar frame hidden by "close to tray", or Zero when the window is shown. Written on
    // the window thread (a close) and read on the tray thread (a click).
    private static nint _hiddenWindowHandle;

    /// <summary>
    /// Wires up what closing the window does: hide to tray when closeToTray reports true, else
    /// quit via onQuit. Call once before the first window opens.
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
    /// Called from tray Quit so nothing opened on the user's behalf is orphaned - a fallback
    /// browser window is a separate OS process Quit would otherwise never touch.
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

                // Close gracefully first; Kill is the fallback for a window that doesn't
                // respond.
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
        // WebView2 ignores CSS -webkit-app-region: drag unless non-client region support is
        // enabled via its browser-args env var, before the webview is created below.
        EnableWebViewDraggableRegions();

        try
        {
            // Chromeless so the React app can draw its own Termius-style title bar; the window
            // stays resizable and draggable via CSS -webkit-app-region: drag.
            var window = new PhotinoWindow().SetTitle("slopterm").SetChromeless(true);

            var iconPath = EmbeddedIcon.ExtractToTempFile();
            if (iconPath is not null)
            {
                window.SetIconFile(iconPath);
            }

            // A chromeless window MUST have an explicit size and location (Photino rejects OS
            // defaults) - saved position if any, else centered on the primary screen.
            window.SetUseOsDefaultLocation(false).SetUseOsDefaultSize(false);
            var saved = WindowPositionStore.Load();
            if (saved is not null)
            {
                window.SetLocation(new Point(saved.X, saved.Y)).SetSize(new Size(saved.Width, saved.Height));
            }
            else
            {
                const int defaultWidth = 1100, defaultHeight = 720;
                var screenW = OperatingSystem.IsWindows() ? GetSystemMetrics(SmCxScreen) : 1280;
                var screenH = OperatingSystem.IsWindows() ? GetSystemMetrics(SmCyScreen) : 800;
                var x = Math.Max(0, (screenW - defaultWidth) / 2);
                var y = Math.Max(0, (screenH - defaultHeight) / 2);
                window.SetLocation(new Point(x, y)).SetSize(new Size(defaultWidth, defaultHeight));
            }

            // Shared by Alt+F4 and the title-bar close button; save before minimizing since
            // that fires spurious move/resize events. CloseToTray on hides, off quits.
            void HandleClose(PhotinoWindow w)
            {
                SavePosition(w);
                if (_closeToTray?.Invoke() == true)
                {
                    HideToTray(w);
                }
                else
                {
                    _onQuit?.Invoke();
                }
            }

            // The chromeless window has no OS caption, so the React title bar drives window
            // controls through this message bridge, handled on the window's own thread.
            window.RegisterWebMessageReceivedHandler((sender, message) =>
            {
                var w = (PhotinoWindow)sender!;
                _webviewReady = true; // any message from the webview proves it exists
                switch (message)
                {
                    case "wc:min":
                        w.SetMinimized(true);
                        break;
                    case "wc:max":
                        w.SetMaximized(!w.Maximized);
                        break;
                    case "wc:close":
                        HandleClose(w);
                        break;
                    case "wc:drag":
                        BeginNativeDrag(w);
                        break;
                    case "wc:ready":
                        // Reply so the title bar's maximize/restore glyph starts correct -
                        // the frontend can't read the native maximize state directly.
                        w.SendWebMessage(w.Maximized ? "wc:maximized" : "wc:restored");
                        break;
                    case var msg when msg.StartsWith("wc:open-external:", StringComparison.Ordinal):
                        OpenExternalLink(msg["wc:open-external:".Length..]);
                        break;
                    case var msg when msg.StartsWith("wc:set-badge:"):
                        HandleSetBadge(msg);
                        break;
                }
            });

            // Keep the glyph in sync when state changes by other means (Win+Up, aero snap).
            // Gated on _webviewReady - an ungated SendWebMessage here is a native crash.
            window.RegisterMaximizedHandler((sender, _) =>
            {
                if (_webviewReady)
                {
                    ((PhotinoWindow)sender!).SendWebMessage("wc:maximized");
                }
            });
            window.RegisterRestoredHandler((sender, _) =>
            {
                if (_webviewReady)
                {
                    ((PhotinoWindow)sender!).SendWebMessage("wc:restored");
                }
            });

            // Always cancel the native close (return true) so Photino never destroys the
            // window - see the class doc comment for why that's a hard requirement.
            window.RegisterWindowClosingHandler((_, _) =>
            {
                HandleClose(window);
                return true;
            });

            window.Load(new Uri(url));

            lock (Lock)
            {
                _window = window;
                _creating = false;
            }

            WindowReady.Set();

            // Can't be done synchronously: WebView2 clears the shell identity during Load()'s
            // async init, so the applier re-asserts it on its own thread until it sticks.
            StartTaskbarIdentityApplier();

            // Blocks this dedicated thread only; in normal operation it never returns
            // (every close is cancelled above).
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

    private static void OpenExternalLink(string payload)
    {
        try
        {
            var url = JsonSerializer.Deserialize<string>(payload);
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                BrowserLauncher.OpenDefaultBrowser(uri.AbsoluteUri);
            }
        }
        catch
        {
            // A malformed message or failed browser launch must not affect the app window.
        }
    }

    /// <summary>
    /// Turns on WebView2 non-client region support by appending the feature flag to its
    /// additional-browser-args env var. Must run before the webview is created; idempotent.
    /// </summary>
    private static void EnableWebViewDraggableRegions()
    {
        const string variable = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        const string flag = "--enable-features=msWebView2EnableDraggableRegions";

        var existing = Environment.GetEnvironmentVariable(variable);
        if (existing is not null && existing.Contains("msWebView2EnableDraggableRegions", StringComparison.Ordinal))
        {
            return;
        }

        Environment.SetEnvironmentVariable(variable, string.IsNullOrEmpty(existing) ? flag : $"{existing} {flag}");
    }

    private static void SavePosition(PhotinoWindow window)
    {
        try
        {
            if (window.Maximized)
            {
                // Persisting maximized bounds would make the next cold start open as a giant
                // "restored" window - keep whatever the last real windowed size/pos was.
                return;
            }

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

    /// <summary>
    /// Hides the window (SW_HIDE) rather than minimizing - a minimized window still owns its
    /// taskbar button, which close-to-tray is meant to remove. The window is never destroyed.
    /// </summary>
    private static void HideToTray(PhotinoWindow window)
    {
        if (OperatingSystem.IsWindows())
        {
            var frame = ResolveTaskbarWindow(window);
            if (frame != nint.Zero)
            {
                // The lookup only matches visible windows, so this handle is the only way back;
                // stored before the hide so a racing tray click still finds it.
                Volatile.Write(ref _hiddenWindowHandle, frame);
                ShowWindow(frame, SwHide);
                return;
            }
        }

        // Non-Windows (no tray icon there yet anyway), or a frame we couldn't locate:
        // minimizing is all Photino itself offers, and the app keeps running either way.
        window.SetMinimized(true);
    }

    /// <summary>
    /// The top-level frame that owns the taskbar button (see WindowsTaskbarIdentity);
    /// GA_ROOTOWNER off the Photino handle is the fallback when that enumeration comes up empty.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static nint ResolveTaskbarWindow(PhotinoWindow window)
    {
        var frame = WindowsTaskbarIdentity.FindMainTaskbarWindow();
        if (frame != nint.Zero)
        {
            return frame;
        }

        return window.WindowHandle != nint.Zero ? GetAncestor(window.WindowHandle, GaRootOwner) : nint.Zero;
    }

    /// <summary>
    /// Undoes HideToTray: SW_SHOW restores the window (including maximized) and its taskbar
    /// button. A hidden window isn't minimized, so un-minimizing wouldn't reveal it.
    /// </summary>
    private static void ShowIfHidden()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var hwnd = Interlocked.Exchange(ref _hiddenWindowHandle, nint.Zero);
        if (hwnd != nint.Zero)
        {
            ShowWindow(hwnd, SwShow);
        }
    }

    private static void RestoreAndFocus(PhotinoWindow window)
    {
        try
        {
            ShowIfHidden();
            if (window.Minimized)
            {
                window.SetMinimized(false);
            }

            // A topmost toggle reliably raises a window cross-platform; SetForegroundWindow is
            // the direct Windows mechanism, allowed since this process already owns the window.
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

    /// <summary>
    /// Hands the current mouse-down to the OS caption drag loop - the reliable way to move a
    /// borderless window, since some WebView2 runtimes ignore the draggable-regions flag. Runs
    /// on the window's UI thread.
    /// </summary>
    private static void BeginNativeDrag(PhotinoWindow window)
    {
        if (!OperatingSystem.IsWindows() || window.WindowHandle == nint.Zero)
        {
            return;
        }

        try
        {
            ReleaseCapture();
            SendMessage(window.WindowHandle, WmNcLButtonDown, HtCaption, nint.Zero);
        }
        catch
        {
            // Best-effort - a failed drag handoff just means the window doesn't move this
            // time, never a reason to take the window (or the app) down.
        }
    }

    private const uint WmNcLButtonDown = 0x00A1;
    private static readonly nint HtCaption = 2;

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint hWnd, uint msg, nint wParam, nint lParam);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    private const int SwHide = 0;
    private const int SwShow = 5;
    private const uint GaRootOwner = 3;

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(nint hWnd, int nCmdShow);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern nint GetAncestor(nint hWnd, uint gaFlags);

    private const int SmCxScreen = 0;
    private const int SmCyScreen = 1;

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    private static void StartTaskbarIdentityApplier()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        // The applier locates the real taskbar window itself and re-applies until it holds;
        // best-effort so taskbar decoration never affects whether the window opens.
        var thread = new Thread(WindowsTaskbarIdentity.ApplyWindowIdentityWithRetry)
        {
            IsBackground = true,
            Name = "slopterm-taskbar-id",
        };
        thread.Start();
    }

    /// <summary>
    /// Photino throws when the platform webview runtime (WebView2/WebKitGTK) isn't installed;
    /// caught in RunWindow, which falls back to BrowserLauncher.
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

    private static void HandleSetBadge(string message)
    {
        try
        {
            var json = message.Substring("wc:set-badge:".Length);
            var payload = System.Text.Json.JsonSerializer.Deserialize<BadgePayload>(json);
            UpdateBadgeCount(payload?.Count ?? 0);
        }
        catch { }
    }

    private static int _badgeCount;

    private static void UpdateBadgeCount(int count)
    {
        _badgeCount = Math.Max(0, Math.Min(count, 99));
        if (OperatingSystem.IsWindows()) { WindowsTrayIcon.SetBadgeCount(_badgeCount); }
    }

    private sealed class BadgePayload { public int Count { get; set; } }

    private const uint MbIconError = 0x00000010;

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(nint hWnd, string text, string caption, uint type);
}
