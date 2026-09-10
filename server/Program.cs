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

// --apply-update is a privileged helper mode: swap the downloaded binary before starting
// Kestrel/window/tray, then relaunch non-elevated and exit immediately.
if (args.Length >= 3 && args[0] == "--apply-update")
{
    var tempPath = args[1];
    var exePath = args[2];

    try
    {
        UpdateService.ApplyElevatedSwap(tempPath, exePath);
    }
    catch (Exception ex)
    {
        CrashLogger.Install();
        CrashLogger.LogPhase($"--apply-update swap failed: {ex.Message}");
        // The temp file is left behind on failure so the user can retry manually.
        Environment.Exit(1);
    }

    // UseShellExecute=true goes through the shell, so the new process launches at the
    // normal integrity level even though this helper is elevated.
    Process.Start(new ProcessStartInfo
    {
        FileName = exePath,
        UseShellExecute = true,
    });

    try { File.Delete(tempPath); } catch { }

    Environment.Exit(0);
}

// Installed before anything else below gets a chance to throw - see CrashLogger's doc
// comment for why this matters specifically for the published (no-console) Windows build.
CrashLogger.Install();
CrashLogger.LogPhase("process starting");

var host = SloptermHost.Start(args);
var app = host.App;
var launchUrl = host.LaunchUrl;
var vault = host.Vault;
var sessions = host.Sessions;
var sftpSessions = host.SftpSessions;
var forwarding = host.Forwarding;
var sync = host.Sync;
var scheduler = host.Scheduler;
var vaultSync = host.VaultSync;

void OpenWindow() => AppWindowManager.EnsureWindowOpen(launchUrl);

void Quit()
{
    // Records who asked to quit (window close vs tray "Quit") to tell a spurious close apart
    // from a crash; closes fallback browser windows that would otherwise be orphaned.
    CrashLogger.LogPhase("shutdown requested (window closed or tray Quit)");
    AppWindowManager.CloseAllFallbackBrowserWindows();

    // Tear down live sessions before stopping the host, or quitting with an open SSH session
    // stalls; time-boxed since a broken session may block on an unreachable host.
    var teardown = Task.Run(() =>
    {
        sessions.DisposeAll();
        sftpSessions.DisposeAll();
    });
    teardown.Wait(TimeSpan.FromSeconds(2));
    app.Lifetime.StopApplication();
}

// Closing the window quits by default; Settings CloseToTray opts into minimize-to-tray.
// The flag is read live at each close, so toggling it takes effect without a restart.
AppWindowManager.Configure(() => vault.GetSettings().CloseToTray, Quit);

WindowsTrayIcon? trayIcon = null;
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    // No console window on the published build - the tray icon is the only way to reach
    // the app (Open focuses/creates the window, Quit stops it).
    trayIcon = new WindowsTrayIcon("slopterm", OpenWindow, Quit);
    trayIcon.Start();
    CrashLogger.LogPhase("tray icon started, opening window");

    // Create the native window immediately so Windows gives the app a taskbar button as
    // well as its tray icon.
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
forwarding.Dispose();
sync.Dispose();
await vaultSync.DisposeAsync();
scheduler.Dispose();
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
{
    trayIcon?.Dispose();
}
