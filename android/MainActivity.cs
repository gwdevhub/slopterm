using Android;
using Android.App;
using Android.Graphics;
using Android.OS;
using Android.Views;
using Android.Webkit;
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

        var webView = new WebView(this);
        // Modern Android draws apps edge-to-edge (behind the status bar and the gesture/nav
        // bar), which left the app's own top bar + Settings sitting half under the system UI.
        // Pad the WebView by the actual system-bar + display-cutout insets so all content lays
        // out inside the safe area - detected at runtime, so it's correct on any device
        // (notch, punch-hole, 3-button vs gesture nav, landscape). The padding strips show the
        // WebView's own background, so paint it the app's dark slate to match seamlessly.
        webView.SetBackgroundColor(Color.ParseColor("#0f172b"));
        webView.SetOnApplyWindowInsetsListener(new SafeAreaInsetsListener());

        webView.Settings.JavaScriptEnabled = true;
        webView.Settings.DomStorageEnabled = true;
        // Keep navigation inside the WebView instead of bouncing out to a browser.
        webView.SetWebViewClient(new WebViewClient());
        SetContentView(webView);
        webView.RequestApplyInsets(); // kick an initial inset pass so padding is right on first paint

        // Start the backend off the UI thread: SloptermHost.Start does vault work (Argon2 key
        // derivation) that's too heavy for OnCreate, then load the UI once it's listening.
        Task.Run(() =>
        {
            var host = SloptermHost.Start([]);
            RunOnUiThread(() => webView.LoadUrl(host.LaunchUrl));
        });
    }

    // Insets the view by the space the system bars + any display cutout occupy, so nothing the
    // app draws ends up underneath them.
    private sealed class SafeAreaInsetsListener : Java.Lang.Object, View.IOnApplyWindowInsetsListener
    {
        public WindowInsets OnApplyWindowInsets(View view, WindowInsets insets)
        {
            if (OperatingSystem.IsAndroidVersionAtLeast(30))
            {
                var bars = insets.GetInsets(WindowInsets.Type.SystemBars() | WindowInsets.Type.DisplayCutout());
                view.SetPadding(bars.Left, bars.Top, bars.Right, bars.Bottom);
            }
            else
            {
#pragma warning disable CA1422 // the pre-API-30 inset accessors are the correct ones there
                view.SetPadding(
                    insets.SystemWindowInsetLeft, insets.SystemWindowInsetTop,
                    insets.SystemWindowInsetRight, insets.SystemWindowInsetBottom);
#pragma warning restore CA1422
            }
            return insets;
        }
    }
}
