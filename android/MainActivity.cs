using Android;
using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.Graphics;
using Android.OS;
using Android.Runtime;
using Android.Text;
using Android.Views;
using Android.Views.InputMethods;
using Android.Webkit;
using Android.Widget;
using Java.Interop;
using Slopterm.Server;

// SSH to remote hosts needs the network; the WebView also talks to our own loopback Kestrel.
[assembly: UsesPermission(Manifest.Permission.Internet)]
// Lets SessionKeepAliveService hold the process out of the cached (and therefore frozen)
// state for a few minutes after the user switches away, so open connections survive it.
// FOREGROUND_SERVICE_DATA_SYNC is mandatory from Android 14 for the type that service
// declares - without it the platform refuses the promotion outright. Spelled out as strings
// rather than via Manifest.Permission constants that only exist in newer bindings.
[assembly: UsesPermission("android.permission.FOREGROUND_SERVICE")]
[assembly: UsesPermission("android.permission.FOREGROUND_SERVICE_DATA_SYNC")]
// From Android 13 a notification isn't shown without this, and a foreground service must
// post one. The service still runs if the user declines - they just don't see it. This is
// also what the existing app-badge notification (UpdateAppBadge below) has always needed.
[assembly: UsesPermission("android.permission.POST_NOTIFICATIONS")]

namespace Slopterm.Mobile;

// The Android head. It hosts the identical slopterm backend (SloptermHost, shared with the
// desktop app via Slopterm.Core) in-process and shows its web UI in a WebView - the phone
// equivalent of the desktop Photino window. The backend is a normal loopback Kestrel server,
// so SSH.NET gets the real TCP sockets it needs (unlike a browser-sandboxed WASM build - see
// AGENTS.md's Mobile section for why that route was rejected).
// ConfigurationChanges: handle rotation, dark-mode toggles and window resizes in-place rather
// than letting the framework destroy and recreate the Activity. A recreation would tear down
// the WebView (and with it every terminal WebSocket) and re-enter OnCreate - which, before the
// static host below, also started a second Kestrel on a fallback port. Users experience that
// as "rotating my phone killed my connections", the same complaint as backgrounding.
[Activity(
    Label = "slopterm",
    MainLauncher = true,
    Theme = "@android:style/Theme.Material.NoActionBar",
    ConfigurationChanges = ConfigChanges.Orientation | ConfigChanges.ScreenSize | ConfigChanges.ScreenLayout
        | ConfigChanges.SmallestScreenSize | ConfigChanges.KeyboardHidden | ConfigChanges.UiMode)]
public class MainActivity : Activity
{
    private const int RequestFileChooser = 1001;
    private const int RequestCreateDocument = 1002;
    private const int RequestPostNotifications = 1003;

    // The backend outlives any one Activity instance: it owns the live SSH sessions, and
    // starting it twice would bind a second Kestrel. Static (rather than a guard inside
    // SloptermHost.Start) so the desktop head, which legitimately calls Start once per
    // process, is left exactly as it was.
    private static readonly object HostLock = new();
    internal static SloptermHostContext? HostContext { get; private set; }

    // A pending <input type=file> result callback (Browse / Import), and bytes waiting for the
    // user to pick a save location (Export). Both are one-shot; only one of each is ever live.
    private IValueCallback? _filePathCallback;
    private byte[]? _pendingSaveBytes;

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        CrashLogger.Install();

        // Draw edge-to-edge AND make the framework dispatch the resulting window insets to our
        // views. Without this explicit opt-in the inset callback below isn't reliably delivered,
        // which is why the first attempt left the app's top bar under the status bar.
        if (OperatingSystem.IsAndroidVersionAtLeast(30))
        {
            Window?.SetDecorFitsSystemWindows(false);
        }

        // Resize (never pan) for the keyboard. On API 30+ with SetDecorFitsSystemWindows(false)
        // the framework doesn't resize the window at all and reports the keyboard as an inset
        // instead - which is what the listener below applies - but this is still what makes
        // older devices shrink the window rather than sliding it up out of the status bar.
        Window?.SetSoftInputMode(SoftInput.AdjustResize);

        var webView = new TerminalWebView(this);
        webView.Settings.JavaScriptEnabled = true;
        webView.Settings.DomStorageEnabled = true;
        webView.Settings.AllowFileAccess = true;
        // Keep navigation inside the WebView instead of bouncing out to a browser.
        webView.SetWebViewClient(new WebViewClient());
        // A plain WebView ignores <input type=file> and blob downloads. The chrome client wires
        // file inputs (Browse / Import backup) to the Android document picker; the JS bridge
        // gives Export a native "save file" dialog (see the web side's androidBridge helper),
        // since a WebView can't turn a blob into a download on its own.
        webView.SetWebChromeClient(new FileChooserChromeClient(this));
        webView.AddJavascriptInterface(new SaveFileBridge(this), "SloptermAndroid");

        // Put the WebView inside a container and inset the *container*, not the WebView. Some
        // WebView builds ignore their own padding for web-content layout, but a FrameLayout
        // always lays its child out within its padding, so this reliably shrinks the WebView's
        // bounds into the safe area (below the status bar, above the nav bar, clear of any
        // cutout). The container's dark background fills the inset strips so they match the UI.
        var root = new FrameLayout(this);
        root.SetBackgroundColor(Color.ParseColor("#0f172b"));
        root.AddView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.MatchParent));
        root.SetOnApplyWindowInsetsListener(new SafeAreaInsetsListener());
        SetContentView(root);

        RequestNotificationPermissionIfNeeded();

        // Start the backend off the UI thread: SloptermHost.Start does vault work (Argon2 key
        // derivation) that's too heavy for OnCreate, then load the UI once it's listening.
        // Reuses the already-running host if this Activity is a recreation - the sessions it
        // holds are the thing we're trying not to lose.
        Task.Run(() =>
        {
            SloptermHostContext host;
            lock (HostLock)
            {
                host = HostContext ??= SloptermHost.Start([]);
            }

            // Auto-start rules come up as part of Start, so this is the first chance to know
            // whether there are forwards to keep alive.
            RefreshForwardCount();
            RunOnUiThread(() => webView.LoadUrl(host.LaunchUrl));
        });
    }

    // Asked for once, on first launch. Declining costs only the visibility of the keep-alive
    // service's notification (and the app badge) - the service itself still runs and the
    // connections are still held.
    private void RequestNotificationPermissionIfNeeded()
    {
        if (!OperatingSystem.IsAndroidVersionAtLeast(33))
        {
            return;
        }

        if (CheckSelfPermission("android.permission.POST_NOTIFICATIONS") == Permission.Granted)
        {
            return;
        }

        try
        {
            RequestPermissions(["android.permission.POST_NOTIFICATIONS"], RequestPostNotifications);
        }
        catch (Java.Lang.Exception)
        {
            // Nothing here is load-bearing - carry on without it.
        }
    }

    // Going to the background is where connections used to die: with no foreground component
    // the process is frozen within seconds and every session goes with it. Promote to a
    // foreground service on the way out so the backend keeps running (see
    // SessionKeepAliveService, which stops itself once the connections are gone or the few
    // minutes are up), and drop it again the moment the user is back.
    //
    // OnPause, not OnStop: from Android 12 an app can't start a foreground service once it's
    // in the background, and OnPause still runs while the Activity is on screen. This is the
    // ONLY hook that can start it, which is why it deliberately doesn't try to exclude the
    // cases where something merely covers the app (our own document picker, a permission
    // dialog): skipping the promotion there wouldn't defer it, it would cancel it outright
    // for however long the user spends in that picker - and browsing Drive for a key file
    // with two shells open is exactly when the connections need holding. The cost is a
    // low-importance notification that appears and disappears again; OnResume removes it.
    protected override void OnPause()
    {
        base.OnPause();

        if (!HasLiveConnections())
        {
            return; // nothing open worth keeping the process up for
        }

        try
        {
            var intent = new Intent(this, typeof(SessionKeepAliveService));
            if (OperatingSystem.IsAndroidVersionAtLeast(26))
            {
                StartForegroundService(intent);
            }
            else
            {
                StartService(intent);
            }
        }
        catch (Java.Lang.Exception)
        {
            // The platform refused the start (a background-start restriction). Nothing to do
            // but let the sessions take their chances - failing here must not crash the app
            // on its way out.
        }
    }

    protected override void OnResume()
    {
        base.OnResume();
        RefreshForwardCount();
        try
        {
            StopService(new Intent(this, typeof(SessionKeepAliveService)));
        }
        catch (Java.Lang.Exception)
        {
            // Already gone (it stops itself too) - nothing to clean up.
        }
    }

    // Port forwards, counted the last time RefreshForwardCount ran. Cached rather than read
    // on demand because ForwardingService.GetStatus takes a lock its monitor loop holds
    // across blocking SSH work (connecting, disconnecting, starting a remote forward - up to
    // the 10s connect timeout), and the two places that need this number are the worst
    // possible threads to block: OnPause, mid-transition on the UI thread, and the keep-alive
    // service's OnStartCommand, which Android kills the app for not returning within ~5s.
    private static volatile int _forwardCount;

    /// <summary>
    /// Everything the backend is holding open that dies if this process is frozen: terminal
    /// shells, SFTP channels, and port forwards. Forwards are counted because they're the one
    /// thing here that can exist with no tab at all - a host with auto-start rules brings up
    /// its own SSH client at launch (see ForwardingService), so a user whose whole use of the
    /// app is a background tunnel would otherwise get no keep-alive at all. Cheap and
    /// non-blocking: two dictionary counts and a cached int.
    /// </summary>
    internal static int LiveConnectionCount()
    {
        var host = HostContext;
        if (host is null)
        {
            return 0;
        }

        return host.Sessions.Count + host.SftpSessions.Count + _forwardCount;
    }

    // Refreshes the cached forward count off the UI thread. Called whenever the app comes
    // forward and from the keep-alive service's own background poll, so the value OnPause
    // reads is at most a few seconds old - fine for a decision about whether to hold the
    // process up for the next few minutes.
    internal static void RefreshForwardCount()
    {
        var host = HostContext;
        if (host is null)
        {
            return;
        }

        Task.Run(() =>
        {
            try
            {
                _forwardCount = host.Forwarding.GetStatus().Count(s => s.State is "active" or "connecting");
            }
            catch (Exception)
            {
                // Status is best-effort; a failed refresh just leaves the previous count.
            }
        });
    }

    private static bool HasLiveConnections() => LiveConnectionCount() > 0;

    // Called from the JS bridge (any thread) to save bytes the web app produced (e.g. a vault
    // backup) - opens the system "create document" dialog so the user picks the destination,
    // then OnActivityResult writes the bytes to the chosen location.
    internal void PromptSaveFile(byte[] bytes, string fileName, string mimeType)
    {
        _pendingSaveBytes = bytes;
        RunOnUiThread(() =>
        {
            var intent = new Intent(Intent.ActionCreateDocument);
            intent.AddCategory(Intent.CategoryOpenable);
            intent.SetType(string.IsNullOrEmpty(mimeType) ? "application/octet-stream" : mimeType);
            intent.PutExtra(Intent.ExtraTitle, fileName);
            StartActivityForResult(intent, RequestCreateDocument);
        });
    }

    protected override void OnActivityResult(int requestCode, [GeneratedEnum] Result resultCode, Intent? data)
    {
        base.OnActivityResult(requestCode, resultCode, data);

        if (requestCode == RequestFileChooser)
        {
            // Hand the picked file URI(s) back to the <input type=file> that asked for them.
            _filePathCallback?.OnReceiveValue(WebChromeClient.FileChooserParams.ParseResult((int)resultCode, data));
            _filePathCallback = null;
        }
        else if (requestCode == RequestCreateDocument)
        {
            var bytes = _pendingSaveBytes;
            _pendingSaveBytes = null;
            if (resultCode == Result.Ok && data?.Data is Android.Net.Uri uri && bytes is not null)
            {
                try
                {
                    using var output = ContentResolver!.OpenOutputStream(uri);
                    output?.Write(bytes, 0, bytes.Length);
                    output?.Flush();
                }
                catch
                {
                    // Best-effort - a failed write just means the backup wasn't saved this time.
                }
            }
        }
    }

    // Routes a web <input type=file> (Browse a key file, Import a backup) to the Android
    // document picker, honoring the input's own `accept` filter via CreateIntent.
    private sealed class FileChooserChromeClient : WebChromeClient
    {
        private readonly MainActivity _activity;
        public FileChooserChromeClient(MainActivity activity) => _activity = activity;

        public override bool OnShowFileChooser(WebView? webView, IValueCallback? filePathCallback, FileChooserParams? fileChooserParams)
        {
            _activity._filePathCallback?.OnReceiveValue(null); // cancel any earlier, still-open picker
            _activity._filePathCallback = filePathCallback;
            try
            {
                var intent = fileChooserParams?.CreateIntent();
                if (intent is null)
                {
                    _activity._filePathCallback = null;
                    return false;
                }
                _activity.StartActivityForResult(intent, RequestFileChooser);
                return true;
            }
            catch
            {
                _activity._filePathCallback = null;
                return false;
            }
        }
    }

    // Exposed to the web app as window.SloptermAndroid.saveFile(base64, name, mime). Used by the
    // Export backup flow, which can't do a blob download inside a WebView.
    private sealed class SaveFileBridge : Java.Lang.Object
    {
        private readonly MainActivity _activity;
        public SaveFileBridge(MainActivity activity) => _activity = activity;

        [JavascriptInterface]
        [Export("saveFile")]
        public void SaveFile(string base64Data, string fileName, string mimeType)
        {
            var bytes = Android.Util.Base64.Decode(base64Data, Android.Util.Base64Flags.Default);
            if (bytes is not null)
            {
                _activity.PromptSaveFile(bytes, fileName, mimeType);
            }
        }

        [JavascriptInterface]
        [Export("setAppBadge")]
        public void SetAppBadge(int count)
        {
            _activity.RunOnUiThread(() => _activity.UpdateAppBadge(count));
        }

        [JavascriptInterface]
        [Export("getKeyboardHeight")]
        public int GetKeyboardHeight()
        {
            return _activity.GetKeyboardHeight();
        }
    }

    private NotificationManager? _notificationManager;
    private bool _badgeChannelCreated = false;
    private const string BadgeChannelId = "slopterm_badge_channel";

    private void UpdateAppBadge(int count)
    {
        try
        {
            // Use Notification.Builder with SetNumber for badge count
            // Badge support requires API 26+ (Android 8.0 Oreo)
            if (Build.VERSION.SdkInt >= BuildVersionCodes.O)
            {
                _notificationManager ??= (NotificationManager)GetSystemService(NotificationService);
                if (_notificationManager != null)
                {
                    // Create notification channel once (required for API 26+)
                    if (!_badgeChannelCreated)
                    {
                        var channel = new NotificationChannel(
                            BadgeChannelId, "App Badge", NotificationImportance.Low)
                        {
                            Description = "App icon badge count"
                        };
                        _notificationManager.CreateNotificationChannel(channel);
                        _badgeChannelCreated = true;
                    }
                    
                    // Build badge notification - SetNumber sets the launcher icon badge
                    var builder = new Notification.Builder(this, BadgeChannelId)
                        .SetSmallIcon(Resource.Drawable.ic_launcher)
                        .SetNumber(count)
                        .SetContentTitle("slopterm")
                        .SetContentText("")
                        .SetOnlyAlertOnce(true)
                        .SetAutoCancel(false)
                        .SetOngoing(true)
                        .SetPriority((int)NotificationPriority.Low);
                    
                    // Use a fixed notification ID for badge updates
                    // If count is 0, the badge is cleared
                    _notificationManager.Notify(1, builder.Build());
                }
            }
        }
        catch { }
    }

    private int GetKeyboardHeight()
    {
        if (Window?.DecorView?.RootView is View rootView)
        {
            var insets = rootView.RootWindowInsets;
            if (insets != null && OperatingSystem.IsAndroidVersionAtLeast(30))
            {
                return insets.GetInsets(WindowInsets.Type.Ime()).Bottom;
            }
        }
        return 0;
    }

    // A WebView that tells the IME this is a terminal, not a message box. Gboard (and every
    // other keyboard) otherwise shows its suggestion/emoji strip above the keys - useless for
    // shell input, and it steals the row the web app's own key toolbar needs - and feeds every
    // keystroke into its personalized dictionary.
    //
    // The variation matters more than it looks: a keyboard in its normal text mode holds the
    // word being typed in a *composing region* and only commits it later, so the shell hasn't
    // actually received "-al" while it's still on screen - Tab has nothing to complete, and
    // anything that tears the composition down (an arrow key, a focus change) takes those
    // characters with it. TextVariationVisiblePassword is the long-standing way to opt out of
    // composing entirely and have each character committed as it's typed; it's what Android
    // terminal apps use, and it means "no autocorrect/suggestions", not "show a password".
    // Every text field in this app is a hostname, a key, a command or a password, so none of
    // them wanted autocorrect anyway.
    private sealed class TerminalWebView : WebView
    {
        public TerminalWebView(Context context) : base(context) { }

        public override IInputConnection? OnCreateInputConnection(EditorInfo? outAttrs)
        {
            var connection = base.OnCreateInputConnection(outAttrs);
            if (outAttrs is not null)
            {
                outAttrs.InputType = InputTypes.ClassText | InputTypes.TextVariationVisiblePassword | InputTypes.TextFlagNoSuggestions;
                outAttrs.ImeOptions |= ImeFlags.NoExtractUi | ImeFlags.NoFullscreen | ImeFlags.NoPersonalizedLearning;
            }
            return connection;
        }
    }

    // Insets the view by the space the system bars + any display cutout occupy, detected at
    // runtime so it's correct on any device/orientation (notch, punch-hole, gesture vs 3-button
    // nav, landscape) rather than hard-coded.
    private sealed class SafeAreaInsetsListener : Java.Lang.Object, View.IOnApplyWindowInsetsListener
    {
        public WindowInsets OnApplyWindowInsets(View view, WindowInsets insets)
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(30))
            {
                var bars = insets.GetInsets(WindowInsets.Type.SystemBars() | WindowInsets.Type.DisplayCutout());
                // The keyboard is an inset too, and drawing edge-to-edge means nothing else
                // accounts for it: without this the WebView keeps its full height and the
                // keyboard is simply painted over the bottom of the page, burying the terminal's
                // own key toolbar. Insetting by it shrinks the WebView to the visible area, so
                // the toolbar ends up directly above the keyboard - and Chromium's
                // visualViewport shrinks with it, which is what the web side keys off (see
                // useVisualViewportHeight). Max, not sum: while the keyboard is up it covers the
                // nav bar's strip anyway.
                var ime = insets.GetInsets(WindowInsets.Type.Ime());
                view.SetPadding(bars.Left, bars.Top, bars.Right, Math.Max(bars.Bottom, ime.Bottom));
                return WindowInsets.Consumed;
            }
#pragma warning disable CA1422 // the pre-API-30 inset accessors are the correct ones there
            view.SetPadding(
                insets.SystemWindowInsetLeft, insets.SystemWindowInsetTop,
                insets.SystemWindowInsetRight, insets.SystemWindowInsetBottom);
#pragma warning restore CA1422
            return insets;
        }
    }
}
