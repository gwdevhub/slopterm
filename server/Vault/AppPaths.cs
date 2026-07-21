using System.Runtime.InteropServices;

namespace Slopterm.Server.Vault;

public static class AppPaths
{
    /// <summary>
    /// Per-OS user data directory for the vault. .NET's SpecialFolder.LocalApplicationData
    /// resolves correctly on Windows/Linux out of the box, but on macOS it also maps to
    /// ~/.local/share instead of the platform convention (~/Library/Application Support) -
    /// handled explicitly here rather than repeating the mistake made with tray icons and
    /// crypto earlier in this project (Linux-only testing hiding a real OS difference).
    /// </summary>
    public static string GetVaultDirectory()
    {
        // Lets e2e tests (and anyone else) redirect vault storage away from a real user's
        // actual vault, instead of every test run reading/writing the developer's own data.
        var overridePath = Environment.GetEnvironmentVariable("SLOPTERM_VAULT_DIR");
        if (!string.IsNullOrEmpty(overridePath))
        {
            return overridePath;
        }

        string root;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Library", "Application Support");
        }
        else
        {
            root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        }

        return Path.Combine(root, "slopterm", "vault");
    }
}
