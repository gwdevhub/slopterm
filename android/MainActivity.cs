using Android;
using Android.App;
using Android.Graphics;
using Android.OS;
using Android.Views;
using Android.Webkit;
using Android.Widget;
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
        // Keep navigation inside the WebView instead of bouncing out to a browser.
        webView.SetWebViewClient(new WebViewClient());

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
