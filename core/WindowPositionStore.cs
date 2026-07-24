using System.Text.Json;

namespace Slopterm.Server;

public sealed class WindowPosition
{
    public required int X { get; set; }
    public required int Y { get; set; }
    public required int Width { get; set; }
    public required int Height { get; set; }
}

/// <summary>
/// Remembers the app window's last position/size across restarts, so the tray icon's
/// "Open" action can restore it (see BrowserLauncher.TryLaunchChromiumAppMode's
/// --window-position/--window-size flags) instead of the OS/browser picking a default
/// spot every time. Plain JSON, not encrypted - screen coordinates aren't sensitive.
/// Lives alongside vault.json/settings.json but isn't itself vault content: not a named
/// entry in VaultService.ExportBackup, so it naturally doesn't travel with a backup
/// (your desktop layout on one machine has no business being forced onto another).
/// </summary>
public static class WindowPositionStore
{
    private static string PathOnDisk => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "window.json");

    // A minimized or tearing-down native window reports "parked" coordinates - Win32
    // moves a minimized window to roughly (-32000, -32000) - and/or a zero/garbage size.
    // Persisting that once (from a shutdown path, an older build, etc.) would otherwise
    // restore the window off-screen with no size on every subsequent launch, so it never
    // appears to open at all even though it exists (taskbar button, no visible window).
    // Both Load and Save gate on this so neither a bad value already on disk nor a fresh
    // bad capture can strand the window.
    private const int MinSize = 100;
    private const int MaxExtent = 30000;

    private static bool IsSane(WindowPosition p) =>
        p.Width >= MinSize && p.Height >= MinSize &&
        p.Width <= MaxExtent && p.Height <= MaxExtent &&
        p.X >= -MaxExtent && p.X <= MaxExtent &&
        p.Y >= -MaxExtent && p.Y <= MaxExtent;

    public static WindowPosition? Load()
    {
        if (!File.Exists(PathOnDisk))
        {
            return null;
        }

        try
        {
            var position = JsonSerializer.Deserialize<WindowPosition>(File.ReadAllText(PathOnDisk));
            // Fall back to OS default placement (return null) rather than restoring an
            // off-screen/zero-size rectangle that would leave the window invisible.
            return position is not null && IsSane(position) ? position : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static void Save(WindowPosition position)
    {
        if (!IsSane(position))
        {
            // Don't overwrite the last known-good position with parked/garbage geometry -
            // silently keep whatever is already on disk.
            return;
        }

        Directory.CreateDirectory(Vault.AppPaths.GetVaultDirectory());
        File.WriteAllText(PathOnDisk, JsonSerializer.Serialize(position));
    }
}
