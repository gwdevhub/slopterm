using System.Diagnostics;
using System.Runtime.Versioning;

namespace Slopterm.Server;

/// <summary>
/// Chrome/Edge/Brave's "--app=&lt;url&gt;" flag opens a chromeless window without bundling a
/// browser; falls back to the OS default browser if none is launchable.
/// </summary>
public static class BrowserLauncher
{
    private static readonly string[] WindowsAppPathExeNames = ["chrome.exe", "msedge.exe", "brave.exe"];

    /// <returns>
    /// The launched process if a dedicated chromeless app-mode window was opened (tracked so
    /// Quit can close it), or null for the default-browser fallback which must never be force-closed.
    /// </returns>
    public static Process? Launch(string url)
    {
        var appModeProcess = TryLaunchChromiumAppMode(url);
        if (appModeProcess is not null)
        {
            return appModeProcess;
        }

        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        return null;
    }

    private static Process? TryLaunchChromiumAppMode(string url)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
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

                // Restore to wherever it was last moved/resized (persisted by the frontend -
                // there's no API to read an open window's live bounds back out).
                var saved = WindowPositionStore.Load();
                if (saved is not null)
                {
                    psi.ArgumentList.Add($"--window-position={saved.X},{saved.Y}");
                    psi.ArgumentList.Add($"--window-size={saved.Width},{saved.Height}");
                }

                return Process.Start(psi);
            }
        }
        catch
        {
            // Any failure here (registry access, launch permissions, etc.) just falls
            // back to the default-browser tab above - never worth crashing the app over.
        }

        return null;
    }

    // Chrome/Edge/Brave register their install path under this "App Paths" registry key -
    // more reliable than guessing Program Files locations, which vary by install type.
    [SupportedOSPlatform("windows")]
    private static string? FindWindowsAppPath(string exeName) =>
        (string?)Microsoft.Win32.Registry.GetValue(
            $@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exeName}", null, null)
        ?? (string?)Microsoft.Win32.Registry.GetValue(
            $@"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exeName}", null, null);
}
