using Android;
using Android.App;
using Android.Content;
using Android.Graphics;
using Android.OS;
using Android.Runtime;
using Android.Views;
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

        var webView = new WebView(this);
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
        webView.AddJavascriptInterface(new BadgeBridge(this), "SloptermAndroid");

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

    private void UpdateAppBadge(int count)
    {
        try
        {
            // Badge support on Android requires a library that's not available
            // as a NuGet package for .NET 10 Android. This is a no-op until we
            // find a suitable replacement or implement it natively.
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
                view.SetPadding(bars.Left, bars.Top, bars.Right, bars.Bottom);
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
