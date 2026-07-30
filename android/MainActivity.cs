using Android;
using Android.App;
using Android.Content;
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

namespace Slopterm.Mobile;

// The Android head. It hosts the identical slopterm backend (SloptermHost, shared with the
// desktop app via Slopterm.Core) in-process and shows its web UI in a WebView - the phone
// equivalent of the desktop Photino window. The backend is a normal loopback Kestrel server,
// so SSH.NET gets the real TCP sockets it needs (unlike a browser-sandboxed WASM build - see
// AGENTS.md's Mobile section for why that route was rejected).
[Activity(Label = "slopterm", MainLauncher = true, Theme = "@android:style/Theme.Material.NoActionBar")]
public class MainActivity : Activity
{
    private const int RequestFileChooser = 1001;
    private const int RequestCreateDocument = 1002;

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

        // Start the backend off the UI thread: SloptermHost.Start does vault work (Argon2 key
        // derivation) that's too heavy for OnCreate, then load the UI once it's listening.
        Task.Run(() =>
        {
            var host = SloptermHost.Start([]);
            RunOnUiThread(() => webView.LoadUrl(host.LaunchUrl));
        });
    }

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
    // keystroke into its personalized dictionary. NoSuggestions also stops the keyboard holding
    // typed characters in a composing region instead of committing them, which is what makes a
    // half-typed command reach the shell (and therefore complete on Tab) at all.
    private sealed class TerminalWebView : WebView
    {
        public TerminalWebView(Context context) : base(context) { }

        public override IInputConnection? OnCreateInputConnection(EditorInfo? outAttrs)
        {
            var connection = base.OnCreateInputConnection(outAttrs);
            if (outAttrs is not null)
            {
                outAttrs.InputType |= InputTypes.TextFlagNoSuggestions;
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
