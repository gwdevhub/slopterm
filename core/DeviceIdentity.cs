using Slopterm.Server.Vault;

namespace Slopterm.Server;

/// <summary>A stable, non-secret id for this install, kept as plain text in the vault directory. Pins scheduled jobs to one install so a synced job doesn't fire on every device (see JobRecord.OwnerDeviceId); deliberately excluded from exported backups.</summary>
public static class DeviceIdentity
{
    private static readonly object Lock = new();
    private static string? _cached;

    public static string Current
    {
        get
        {
            lock (Lock)
            {
                return _cached ??= LoadOrCreate();
            }
        }
    }

    private static string LoadOrCreate()
    {
        var vaultDir = AppPaths.GetVaultDirectory();
        var path = Path.Combine(vaultDir, "device-id");

        try
        {
            if (File.Exists(path))
            {
                var existing = File.ReadAllText(path).Trim();
                if (existing.Length > 0)
                {
                    return existing;
                }
            }

            var id = Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(vaultDir);
            File.WriteAllText(path, id);
            return id;
        }
        catch (IOException)
        {
            // An unwritable vault directory shouldn't take the app down; fall back to a per-process id.
            // The only cost is that a job pinned to "this device" stops matching after a restart.
            return Guid.NewGuid().ToString("N");
        }
    }
}
