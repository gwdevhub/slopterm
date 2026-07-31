using Slopterm.Server.Vault;

namespace Slopterm.Server;

/// <summary>
/// A stable, non-secret id for this slopterm install, kept in the vault directory as plain
/// text (device-id) alongside settings.json rather than as an encrypted record - it has to
/// be readable with the vault locked, and it identifies a machine, not a person.
///
/// It exists for scheduled jobs: once the vault syncs across devices, the same JobRecord
/// lives on the laptop AND the phone, and both would happily fire it. A job pinned to an
/// OwnerDeviceId only runs on the install whose id matches, so a nightly backup doesn't run
/// twice (see JobRecord.OwnerDeviceId).
///
/// Deliberately NOT included in an exported backup (ExportBackup only packages vault.json,
/// settings.json and the record subfolders): restoring a backup onto a second machine must
/// produce a second identity, or the whole point is lost.
/// </summary>
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
            // An unwritable vault directory shouldn't take the app down - fall back to an
            // id that lasts this process. The only cost is that a job pinned to "this
            // device" stops matching after a restart, which surfaces in the UI as the job
            // belonging to another device rather than as anything silent.
            return Guid.NewGuid().ToString("N");
        }
    }
}
