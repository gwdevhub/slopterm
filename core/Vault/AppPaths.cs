using System.Runtime.InteropServices;

namespace Slopterm.Server.Vault;

public static class AppPaths
{
    /// <summary>Per-OS user data directory for the vault (macOS uses ~/Library/Application Support).</summary>
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
