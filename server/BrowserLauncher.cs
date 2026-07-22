using System.Diagnostics;
using System.Runtime.Versioning;

namespace Slopterm.Server;

/// <summary>
/// Chrome/Edge/Brave all support a "--app=&lt;url&gt;" flag that opens a chromeless window
/// (no tabs, no address bar) instead of a normal browser tab - the standalone-app look
/// without bundling a browser (see AGENTS.md's "No bundled browser/webview" rule). Falls
/// back to the OS's normal default-browser handling if no such browser is found/launchable.
/// Windows-only for now since the tray icon's "Open" action - the only place the app
/// currently launches a browser itself - is Windows-only (see AGENTS.md's system tray
/// section); Linux/macOS still just print the URL for the user to open themselves.
/// </summary>
public static class BrowserLauncher
{
    private static readonly string[] WindowsAppPathExeNames = ["chrome.exe", "msedge.exe", "brave.exe"];

    public static void Launch(string url)
    {
        if (TryLaunchChromiumAppMode(url))
        {
            return;
        }

        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private static bool TryLaunchChromiumAppMode(string url)
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            foreach (var exeName in WindowsAppPathExeNames)
            {
                var path = FindWindowsAppPath(exeName);
                if (path is null || !File.Exists(path))
                {
                    continue;
                }

                var psi = new ProcessStartInfo(path) { UseShellExecute = false };
                psi.ArgumentList.Add($"--app={url}");
                Process.Start(psi);
                return true;
            }
        }
        catch
        {
            // Any failure here (registry access, launch permissions, etc.) just falls
            // back to the default-browser tab above - never worth crashing the app over.
        }

        return false;
    }

    // Chrome/Edge/Brave all register their install path under this "App Paths" registry
    // key - more reliable than guessing Program Files locations, which vary by
    // architecture and per-user vs. per-machine installs.
    [SupportedOSPlatform("windows")]
    private static string? FindWindowsAppPath(string exeName) =>
        (string?)Microsoft.Win32.Registry.GetValue(
            $@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exeName}", null, null)
        ?? (string?)Microsoft.Win32.Registry.GetValue(
            $@"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exeName}", null, null);
}
