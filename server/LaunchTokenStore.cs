namespace Slopterm.Server;

/// <summary>
/// Persists the per-process auth token (see Program.cs's auth middleware) across restarts.
/// Previously regenerated fresh on every launch, which is fine for a normal cold start (the
/// tray icon/console always hands out a freshly-token'd URL) but breaks a browser tab that's
/// already open when the *same* process restarts out from under it - e.g. after applying a
/// self-update (UpdateService.ApplyAsync) - the tab's cookie would hold a token the new
/// process no longer recognizes, so a plain reload would 401 instead of picking up cleanly.
/// Plain text, not encrypted - same trust level as WindowPositionStore (local machine only,
/// loopback-gated), and deliberately not part of VaultService.ExportBackup for the same
/// reason a window position isn't: it's per-install, not vault content.
/// </summary>
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
            // Fall through to generating a fresh one - a corrupt/unreadable file shouldn't
            // block startup.
        }

        var token = createNew();
        try
        {
            Directory.CreateDirectory(Vault.AppPaths.GetVaultDirectory());
            File.WriteAllText(PathOnDisk, token);
        }
        catch (IOException)
        {
            // Best-effort - worst case every future restart just re-generates a token again.
        }

        return token;
    }
}
