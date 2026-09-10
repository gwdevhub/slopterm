namespace Slopterm.Server;

/// <summary>Persists the per-process auth token across restarts so a browser tab open across a self-update restart keeps working instead of 401ing. Plain text, per-install (not vault content, not in backups).</summary>
public static class LaunchTokenStore
{
    private static string PathOnDisk => Path.Combine(Vault.AppPaths.GetVaultDirectory(), "launch-token.txt");

    public static string LoadOrCreate(Func<string> createNew)
    {
        try
        {
            if (File.Exists(PathOnDisk))
            {
                var existing = File.ReadAllText(PathOnDisk).Trim();
                if (existing.Length > 0)
                {
                    return existing;
                }
            }
        }
        catch (IOException)
        {
            // Fall through to generating a fresh one - a corrupt/unreadable file shouldn't block startup.
        }

        var token = createNew();
        try
        {
            Directory.CreateDirectory(Vault.AppPaths.GetVaultDirectory());
            File.WriteAllText(PathOnDisk, token);
        }
        catch (IOException)
        {
            // Best-effort - worst case every future restart just re-generates a token.
        }

        return token;
    }
}
