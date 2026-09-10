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
// FOREGROUND_SERVICE_DATA_SYNC is mandatory from Android 14 for the type SessionKeepAliveService
// declares; spelled as strings rather than Manifest.Permission constants absent from older bindings.
[assembly: UsesPermission("android.permission.FOREGROUND_SERVICE")]
[assembly: UsesPermission("android.permission.FOREGROUND_SERVICE_DATA_SYNC")]
// From Android 13 a notification isn't shown without this, and a foreground service must
// post one. The service still runs if the user declines - they just don't see it.
[assembly: UsesPermission("android.permission.POST_NOTIFICATIONS")]

namespace Slopterm.Mobile;

// ConfigurationChanges: handle rotation/dark-mode/resize in-place; a recreation would tear down
// the WebView and every terminal WebSocket, and re-enter OnCreate.
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

    // The backend outlives any one Activity: it owns the live sessions, and starting it twice
    // would bind a second Kestrel. Static so the desktop head, which calls Start once per process, is unaffected.
    private static readonly object HostLock = new();
    internal static SloptermHostContext? HostContext { get; private set; }

    // A pending <input type=file> result callback (Browse / Import), and bytes waiting for the
    // user to pick a save location (Export). Both are one-shot; only one of each is ever live.
    private IValueCallback? _filePathCallback;
    private byte[]? _pendingSaveBytes;

    // Kept so the JS bridge (see SaveFileBridge.FinishComposing below) can reach the live
    // InputConnection through it.
    private TerminalWebView? _webView;

    // Whether the IME was visible as of the last inset change, so OnImeVisibilityChanged only
    // acts on an actual hide, not every inset callback (rotation, nav bar, ...).
    private bool _imeWasVisible;

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        CrashLogger.Install();

        // Draw edge-to-edge and opt into framework dispatch of window insets; without this the
        // inset callback below isn't reliably delivered.
        if (OperatingSystem.IsAndroidVersionAtLeast(30))
        {
            Window?.SetDecorFitsSystemWindows(false);
        }

        // Resize (never pan) for the keyboard; on API 30+ the framework reports it as an inset
        // instead, but this makes older devices shrink rather than slide the window.
        Window?.SetSoftInputMode(SoftInput.AdjustResize);

        var webView = new TerminalWebView(this);
        _webView = webView;
        webView.Settings.JavaScriptEnabled = true;
        webView.Settings.DomStorageEnabled = true;
        webView.Settings.AllowFileAccess = true;
        // Keep navigation inside the WebView instead of bouncing out to a browser.
        webView.SetWebViewClient(new WebViewClient());
        // A plain WebView ignores <input type=file> and blob downloads: the chrome client wires
        // file inputs to the document picker, the JS bridge gives Export a native save dialog.
        webView.SetWebChromeClient(new FileChooserChromeClient(this));
        webView.AddJavascriptInterface(new SaveFileBridge(this), "SloptermAndroid");

        // Inset a container, not the WebView: some WebView builds ignore their own padding, but
        // a FrameLayout lays its child within its padding, reliably shrinking into the safe area.
        var root = new FrameLayout(this);
        root.SetBackgroundColor(Color.ParseColor("#0f172b"));
        root.AddView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MatchParent, ViewGroup.LayoutParams.MatchParent));
        root.SetOnApplyWindowInsetsListener(new SafeAreaInsetsListener(OnImeVisibilityChanged));
        SetContentView(root);

        RequestNotificationPermissionIfNeeded();

        // Start the backend off the UI thread (Argon2 key derivation is too heavy for OnCreate);
        // reuse the running host on recreation so its sessions aren't lost.
        Task.Run(() =>
        {
            SloptermHostContext host;
            lock (HostLock)
            {
                host = HostContext ??= SloptermHost.Start([]);
            }

            // Auto-start rules come up as part of Start; first chance to know if forwards are live.
            RefreshForwardCount();
            RefreshSessionNotificationBadge();
            RunOnUiThread(() => webView.LoadUrl(host.LaunchUrl));
        });
    }

    // Asked for once, on first launch; declining only hides the keep-alive notification, not
    // the service.
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

    // Whether the Activity has left the screen: OnStop, not OnPause - a paused Activity (dialog,
    // share sheet, split screen) is still visible. Static/volatile: the watchdog reads it off-thread.
    private static volatile bool _backgrounded;

    internal static bool IsBackgrounded => _backgrounded;

    protected override void OnStart()
    {
        base.OnStart();
        _backgrounded = false;
    }

    protected override void OnStop()
    {
        base.OnStop();
        _backgrounded = true;
    }

    // Promote to a foreground service on the way out so the process isn't frozen; only OnPause
    // can start one and can't yet tell if the app is leaving, so the start is provisional (see WaitForBackgroundAsync).
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
            // Platform refused the start (background-start restriction); must not crash the app.
        }
    }

    protected override void OnResume()
    {
        base.OnResume();
        RefreshForwardCount();
        RefreshSessionNotificationBadge();
        try
        {
            StopService(new Intent(this, typeof(SessionKeepAliveService)));
        }
        catch (Java.Lang.Exception)
        {
            // Already gone (it stops itself too) - nothing to clean up.
        }
    }

    // Port forwards, counted the last time RefreshForwardCount ran. Cached because GetStatus
    // takes a lock held across blocking SSH work, and the readers (OnPause, OnStartCommand) must not block.
    private static volatile int _forwardCount;

    /// <summary>
    /// Everything the backend holds that dies if the process is frozen: shells, SFTP channels,
    /// and port forwards (which can exist with no tab via auto-start rules). Cheap and non-blocking.
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

    // Refreshes the cached forward count off the UI thread; at most a few seconds stale, fine
    // for the keep-alive decision.
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

    // AppSettings.SessionNotificationBadge as of the last refresh; cached for the same reason
    // as _forwardCount, since GetSettings() is a file read that can throw.
    private static volatile bool _sessionNotificationBadge;

    internal static bool SessionNotificationBadgeEnabled => _sessionNotificationBadge;

    // Refreshes that cache off the UI thread, on the same two occasions as the forward count.
    internal static void RefreshSessionNotificationBadge()
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
                _sessionNotificationBadge = host.Vault.GetSettings().SessionNotificationBadge;
            }
            catch (Exception)
            {
                // Best-effort: an unreadable settings.json leaves the previous value.
            }
        });
    }

    // Called from the JS bridge to save bytes the web app produced; OnActivityResult writes them.
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

    // Exposed to the web app as window.SloptermAndroid.saveFile(...) for the Export backup flow.
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
        [Export("getKeyboardHeight")]
        public int GetKeyboardHeight()
        {
            return _activity.GetKeyboardHeight();
        }

        // Called by the web toolbar right before it acts, so uncommitted IME text lands in the
        // shell first. Fire-and-forget; the ordering guarantee lives on the JS side (androidBridge.ts).
        [JavascriptInterface]
        [Export("finishComposing")]
        public void FinishComposing()
        {
            _activity.RunOnUiThread(() => _activity._webView?.FinishComposingText());
        }

        // Called when the web app opens a panel the keyboard would cover; hiding it natively
        // leaves focus in place, which JS blurring couldn't.
        [JavascriptInterface]
        [Export("hideKeyboard")]
        public void HideKeyboard()
        {
            _activity.RunOnUiThread(_activity.HideSoftKeyboard);
        }
    }

    private void HideSoftKeyboard()
    {
        var token = _webView?.WindowToken;
        if (token is null)
        {
            return;
        }

        var imm = (InputMethodManager?)GetSystemService(InputMethodService);
        // No flags: an unconditional hide. HideImplicitOnly would refuse for a keyboard the user
        // brought up by tapping the terminal, which is every keyboard this is asked to hide.
        imm?.HideSoftInputFromWindow(token, HideSoftInputFlags.None);
    }

    // The IME can dismiss without blurring (back gesture, "hide" chevron); WebView then restores
    // focus on the next touch and reopens it, so blur the active element as the keyboard closes.
    private void OnImeVisibilityChanged(bool imeVisible)
    {
        if (_imeWasVisible && !imeVisible)
        {
            _webView?.EvaluateJavascript("document.activeElement && document.activeElement.blur();", null);
        }
        _imeWasVisible = imeVisible;
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

    // Tells the IME this is a terminal: TextFlagNoSuggestions turns off suggestion strips and
    // autocorrect. Composing stays on so xterm renders the composing region locally (see FinishComposing).
    private sealed class TerminalWebView : WebView
    {
        private IInputConnection? _connection;

        public TerminalWebView(Context context) : base(context) { }

        public override IInputConnection? OnCreateInputConnection(EditorInfo? outAttrs)
        {
            _connection = base.OnCreateInputConnection(outAttrs);
            if (outAttrs is not null)
            {
                outAttrs.InputType = InputTypes.ClassText | InputTypes.TextFlagNoSuggestions;
                outAttrs.ImeOptions |= ImeFlags.NoExtractUi | ImeFlags.NoFullscreen | ImeFlags.NoPersonalizedLearning;
            }
            return _connection;
        }

        // Commits any text the IME is still composing; must run on the UI thread.
        public void FinishComposingText() => _connection?.FinishComposingText();
    }

    // Insets the view by the system bars + display cutout, detected at runtime so it's correct
    // on any device/orientation rather than hard-coded.
    private sealed class SafeAreaInsetsListener : Java.Lang.Object, View.IOnApplyWindowInsetsListener
    {
        private readonly Action<bool> _onImeVisibilityChanged;

        public SafeAreaInsetsListener(Action<bool> onImeVisibilityChanged)
        {
            _onImeVisibilityChanged = onImeVisibilityChanged;
        }

        public WindowInsets OnApplyWindowInsets(View view, WindowInsets insets)
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(30))
            {
                var bars = insets.GetInsets(WindowInsets.Type.SystemBars() | WindowInsets.Type.DisplayCutout());
                // Inset by the IME too: edge-to-edge means the keyboard would otherwise paint
                // over the page. Max, not sum - the keyboard covers the nav bar strip anyway.
                var ime = insets.GetInsets(WindowInsets.Type.Ime());
                _onImeVisibilityChanged(ime.Bottom > 0);
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
