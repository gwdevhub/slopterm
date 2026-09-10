using System.Text.Json;

namespace Slopterm.Server;

public sealed class WindowPosition
{
    public required int X { get; set; }
    public required int Y { get; set; }
    public required int Width { get; set; }
    public required int Height { get; set; }
}

/// <summary>Remembers the window's last position/size across restarts so the tray "Open" action can restore it. Plain JSON, not vault content (not included in backups).</summary>
public static class WindowPositionStore
{
    private static string PathOnDisk => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "window.json");

    // Parked/garbage coordinates (Win32 minimizes to ~(-32000,-32000)) must never be persisted
    // or restored, or the window comes back off-screen with no size. Both Load and Save gate on this.
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
            // Fall back to OS default placement rather than restoring an off-screen/zero-size rectangle.
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
            // Don't overwrite the last known-good position with parked/garbage geometry.
            return;
        }

        Directory.CreateDirectory(Vault.AppPaths.GetVaultDirectory());
        File.WriteAllText(PathOnDisk, JsonSerializer.Serialize(position));
    }
}
