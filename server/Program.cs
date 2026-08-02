using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Slopterm.Server;
using Slopterm.Server.Ai;
using Slopterm.Server.Native;
using Slopterm.Server.Vault;

// Installed before anything else below gets a chance to throw - see CrashLogger's doc
// comment for why this matters specifically for the published (no-console) Windows build.
CrashLogger.Install();
CrashLogger.LogPhase("process starting");

// Build + start the whole backend (Kestrel, endpoints, vault, forwarding, sync). Everything
// below this call is the desktop shell: the Photino window and Windows tray icon that wrap
// the returned launch URL. See SloptermHost.
var host = SloptermHost.Start(args);
var app = host.App;
var launchUrl = host.LaunchUrl;
var vault = host.Vault;
var sessions = host.Sessions;
var sftpSessions = host.SftpSessions;
var forwarding = host.Forwarding;
var sync = host.Sync;
var scheduler = host.Scheduler;

void OpenWindow() => AppWindowManager.EnsureWindowOpen(launchUrl);

void Quit()
{
    // Closes anything opened on the user's behalf that stopping this process alone
    // wouldn't - a fallback browser window (no webview runtime installed) is a separate
    // OS process Program.cs's own shutdown never touches. The main Photino window needs
    // no equivalent call here: it lives on a background thread that already dies once
    // StopApplication unblocks WaitForShutdownAsync below and the process exits.
    // Records who asked to quit (window close vs tray "Quit") - a spurious window close right
    // after launch presents to the user exactly like a crash ("tray showed, then it vanished"),
    // so the breadcrumb is what tells the two apart after the fact.
    CrashLogger.LogPhase("shutdown requested (window closed or tray Quit)");
    AppWindowManager.CloseAllFallbackBrowserWindows();

    // Tear down live sessions BEFORE stopping the host: their WS handlers only return once
    // the blocking shell-read pump unblocks, and the graceful stop below waits for exactly
    // those handlers - without this, quitting with an SSH session open stalls until the
    // session happens to end. Disposal makes the shell reads throw ObjectDisposedException
    // immediately; ApplicationStopping (linked into the WS receive loops) and the 2s
    // ShutdownTimeout backstop cover everything else.
    //
    // Time-boxed, because this runs before StopApplication and so isn't covered by that
    // ShutdownTimeout at all: SSH.NET's channel close and disconnect are synchronous and both
    // wait on a host that may be unreachable - which is now a likelier state for a session to
    // be in, since a session whose transport broke sits in the store until it's reaped rather
    // than dying with its WebSocket. Stragglers keep unwinding on their own thread; the
    // process exiting takes care of them.
    var teardown = Task.Run(() =>
    {
        sessions.DisposeAll();
        sftpSessions.DisposeAll();
    });
    teardown.Wait(TimeSpan.FromSeconds(2));
    app.Lifetime.StopApplication();
}

// Closing the app window quits by default; a user can opt into the old minimize-to-tray
// behavior via Settings (CloseToTray). The flag is read live at each close, so toggling it
// takes effect without a restart, and closing runs the same clean Quit the tray menu does.
AppWindowManager.Configure(() => vault.GetSettings().CloseToTray, Quit);

WindowsTrayIcon? trayIcon = null;
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    // No console window on the published build (see the .csproj) - the tray icon is the
    // only way to reach the app. Left-click/"Open" focuses the one slopterm window if
    // it's already open, or creates it fresh otherwise (see AppWindowManager);
    // "Quit" stops it.
    trayIcon = new WindowsTrayIcon("slopterm", OpenWindow, Quit);
    trayIcon.Start();
    CrashLogger.LogPhase("tray icon started, opening window");

    // Create the native window immediately so Windows gives the running application a
    // taskbar button as well as its tray icon. The window already uses the embedded app
    // icon (AppWindowManager.SetIconFile). Closing it quits the app by default; only when
    // the user opts into CloseToTray does the close handler hide-and-keep-running instead,
    // dropping the taskbar button so the tray icon is the only entry left.
    OpenWindow();
    CrashLogger.LogPhase("window opened");
}
else
{
    // No tray icon on Linux/macOS yet (see AGENTS.md's system tray section) - printing
    // the URL to the console is still the only way to reach the app there.
    Console.WriteLine();
    Console.WriteLine("slopterm is running. Open this URL in your browser:");
    Console.WriteLine($"  {launchUrl}");
    Console.WriteLine();
}

CrashLogger.LogPhase("running");
await app.WaitForShutdownAsync();
CrashLogger.LogPhase("shut down cleanly");
forwarding.Dispose(); // tears down every background forwarding connection cleanly
sync.Dispose(); // tears down every background sync watcher/connection cleanly
scheduler.Dispose(); // stops the job loop and cancels any run still in flight
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    trayIcon?.Dispose();
}
