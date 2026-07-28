using System;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Slopterm.Server;

/// <summary>
/// One literal alias from ~/.ssh/config, resolved enough to offer as a read-only,
/// non-vault card on the Hosts screen (see AGENTS.md's SSH config hosts note). There is
/// nothing here to edit/delete through the app - the file on disk is the only source of
/// truth, and this is re-parsed from it on every request rather than cached or copied
/// into the vault.
/// </summary>
public sealed record SshConfigHostEntry(string Alias, string HostName, int Port, string Username, string? PrivateKey);

/// <summary>
/// Parses `Host`/`HostName`/`User`/`Port`/`IdentityFile` directives out of ~/.ssh/config,
/// the way real ssh resolves them for a target alias: every `Host` block whose pattern
/// matches applies, in file order, and the first block to set a given parameter wins -
/// so a trailing `Host *` block's shared `User`/`IdentityFile` still reaches earlier,
/// more specific aliases. Deliberately narrower than the full OpenSSH grammar: no
/// `Include`, no `Match`, no quoted/`%`-token values, and `!negated` patterns are just
/// never matched rather than excluding a positive match elsewhere on the same line - that
/// covers the common "a handful of named aliases, maybe a shared catch-all" config this
/// feature is for, not every directive ssh_config supports.
/// </summary>
public static class SshConfigService
{
    // Tried in this order for an alias with no explicit IdentityFile, mirroring OpenSSH's
    // own default identity list (minus the legacy DSA key, which SSH.NET doesn't support).
    private static readonly string[] DefaultIdentityFileNames = ["id_ed25519", "id_ecdsa", "id_rsa"];

    public static string GetConfigPath()
    {
        // Lets e2e tests point this at a fixture file instead of a real developer's own
        // ~/.ssh/config, same purpose as AppPaths' SLOPTERM_VAULT_DIR override.
        var overridePath = Environment.GetEnvironmentVariable("SLOPTERM_SSH_CONFIG_PATH");
        if (!string.IsNullOrEmpty(overridePath))
        {
            return overridePath;
        }

        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "config");
    }

    /// <summary>
    /// Best-effort like every other optional lookup in this app (Keychain, Recent, ...):
    /// a missing file, unreadable file, or parse hiccup just yields an empty list rather
    /// than surfacing an error - there is no UI path where this should ever block the
    /// Hosts screen from rendering.
    /// </summary>
    public static List<SshConfigHostEntry> ListHosts()
    {
        if (OperatingSystem.IsAndroid())
        {
            return [];
        }

        var path = GetConfigPath();
        if (!File.Exists(path))
        {
            return [];
        }

        try
        {
            return ParseFile(path);
        }
        catch
        {
            return [];
        }
    }

    private static List<SshConfigHostEntry> ParseFile(string path)
    {
        var sshDir = Path.GetDirectoryName(Path.GetFullPath(path)) ?? "";
        var blocks = ParseBlocks(path);

        // Only a literal (non-glob) pattern names an alias worth showing a card for -
        // there's no single connectable address behind a `Host *.corp.example.com` block.
        var aliases = blocks
            .SelectMany(b => b.Patterns)
            .Where(p => !p.Contains('*') && !p.Contains('?') && !p.StartsWith('!'))
            .Distinct()
            .ToList();

        var entries = new List<SshConfigHostEntry>();
        foreach (var alias in aliases)
        {
            string? hostName = null, user = null, identityFile = null;
            int? port = null;

            foreach (var block in blocks)
            {
                if (!block.Patterns.Any(p => MatchesPattern(alias, p)))
                {
                    continue;
                }

                foreach (var (keyword, value) in block.Directives)
                {
                    if (hostName is null && keyword.Equals("HostName", StringComparison.OrdinalIgnoreCase)) hostName = value;
                    else if (user is null && keyword.Equals("User", StringComparison.OrdinalIgnoreCase)) user = value;
                    else if (port is null && keyword.Equals("Port", StringComparison.OrdinalIgnoreCase) && int.TryParse(value, out var p)) port = p;
                    else if (identityFile is null && keyword.Equals("IdentityFile", StringComparison.OrdinalIgnoreCase)) identityFile = value;
                }
            }

            var resolvedIdentityPath = ResolveIdentityPath(identityFile, sshDir);
            string? privateKey = null;
            if (resolvedIdentityPath is not null)
            {
                try
                {
                    privateKey = File.ReadAllText(resolvedIdentityPath);
                }
                catch
                {
                    // Unreadable key file (permissions, dangling symlink, ...) - the card
                    // still shows, just without a way to auto-connect through it.
                }
            }

            entries.Add(new SshConfigHostEntry(alias, hostName ?? alias, port ?? 22, user ?? Environment.UserName, privateKey));
        }

        return entries;
    }

    // A literal pattern only matches itself; `*`/`?` glob against the alias the same way
    // OpenSSH's own token match does (case-insensitive, whole-string).
    private static bool MatchesPattern(string alias, string pattern)
    {
        if (!pattern.Contains('*') && !pattern.Contains('?'))
        {
            return string.Equals(alias, pattern, StringComparison.OrdinalIgnoreCase);
        }

        var regex = "^" + string.Concat(pattern.Select(c => c switch
        {
            '*' => ".*",
            '?' => ".",
            _ => Regex.Escape(c.ToString()),
        })) + "$";
        return Regex.IsMatch(alias, regex, RegexOptions.IgnoreCase);
    }

    private static string? ResolveIdentityPath(string? identityFile, string sshDir)
    {
        if (!string.IsNullOrEmpty(identityFile))
        {
            var expanded = identityFile.StartsWith('~')
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), identityFile[1..].TrimStart('/', '\\'))
                : identityFile;
            return File.Exists(expanded) ? expanded : null;
        }

        foreach (var name in DefaultIdentityFileNames)
        {
            var candidate = Path.Combine(sshDir, name);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private sealed record HostBlock(List<string> Patterns, List<(string Keyword, string Value)> Directives);

    private static List<HostBlock> ParseBlocks(string path)
    {
        var blocks = new List<HostBlock>();
        HostBlock? current = null;

        foreach (var rawLine in File.ReadAllLines(path))
        {
            var line = StripComment(rawLine).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var (keyword, value) = SplitDirective(line);
            if (keyword is null)
            {
                continue;
            }

            if (keyword.Equals("Host", StringComparison.OrdinalIgnoreCase))
            {
                current = new HostBlock(value.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList(), []);
                blocks.Add(current);
                continue;
            }

            current?.Directives.Add((keyword, value));
        }

        return blocks;
    }

    private static string StripComment(string line)
    {
        var hashIndex = line.IndexOf('#');
        return hashIndex < 0 ? line : line[..hashIndex];
    }

    // ssh_config directives are "Keyword value" or "Keyword=value", with arbitrary
    // whitespace around either separator.
    private static (string? Keyword, string Value) SplitDirective(string line)
    {
        var separatorIndex = line.IndexOfAny([' ', '\t', '=']);
        if (separatorIndex < 0)
        {
            return (null, "");
        }

        var keyword = line[..separatorIndex];
        var value = line[(separatorIndex + 1)..].TrimStart(' ', '\t', '=').Trim().Trim('"');
        return (keyword, value);
    }
}
