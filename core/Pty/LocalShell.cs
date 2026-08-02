using System.Runtime.InteropServices;

namespace Slopterm.Server;

/// <summary>What to actually launch on this machine, and in what world.</summary>
/// <param name="Executable">Absolute path (or a PATH-resolvable name on Windows) of the shell.</param>
/// <param name="Argv0">
/// What the shell sees as its own name. A leading dash is the historical signal for "you are a
/// login shell", which is what makes it read the user's profile and so end up with the PATH,
/// aliases and prompt they'd get from a real terminal. Windows shells ignore this.
/// </param>
/// <param name="Arguments">Arguments after argv[0].</param>
/// <param name="WorkingDirectory">Where the shell starts. Null means "inherit ours".</param>
/// <param name="Environment">The child's complete environment - not a delta over ours.</param>
public sealed record LocalShellStartInfo(
    string Executable,
    string Argv0,
    IReadOnlyList<string> Arguments,
    string? WorkingDirectory,
    IReadOnlyDictionary<string, string> Environment);

/// <summary>
/// Picks the shell a "local terminal" tab runs, and builds the environment it runs in. Kept
/// apart from the PTY plumbing because every part of it is a product decision (which shell,
/// login or not, which directory) rather than an OS mechanism.
/// </summary>
public static class LocalShell
{
    /// <summary>
    /// Escape hatch for a user whose preferred shell isn't the OS default and who doesn't
    /// want to change $SHELL - and the hook the e2e tests use to run something predictable.
    /// </summary>
    private const string ShellOverrideVariable = "SLOPTERM_LOCAL_SHELL";

    /// <summary>
    /// True where a local terminal can actually be opened. Both halves of this are a symbol
    /// lookup rather than a version check - see WindowsPty.IsSupported (ConPTY) and
    /// UnixPty.IsSupported (posix_spawn).
    /// </summary>
    public static bool IsSupported => OperatingSystem.IsWindows() ? WindowsPty.IsSupported : UnixPty.IsSupported;

    /// <summary>Why not, for the endpoint to hand back verbatim. Null when it is supported.</summary>
    public static string? UnsupportedReason
    {
        get
        {
            if (IsSupported) return null;
            if (OperatingSystem.IsWindows())
            {
                return "This machine can't open a local terminal - it has no ConPTY, which needs Windows 10 version 1809 or newer.";
            }

            return OperatingSystem.IsAndroid()
                ? "This device can't open a local terminal - it needs Android 9 (API 28) or newer."
                : "This machine can't open a local terminal - its C library has no posix_spawn.";
        }
    }

    public static LocalShellStartInfo Resolve(string? requestedShell = null)
    {
        var shell = FirstUsable(
            requestedShell,
            Environment.GetEnvironmentVariable(ShellOverrideVariable),
            OperatingSystem.IsWindows() ? null : Environment.GetEnvironmentVariable("SHELL"))
            ?? DefaultShell();

        var home = HomeDirectory();
        var environment = BuildEnvironment(home, shell);

        if (OperatingSystem.IsWindows())
        {
            // PowerShell only speaks VT sequences if it's told to - without -NoLogo the banner
            // also lands in the scrollback on every single tab.
            var arguments = IsPowerShell(shell) ? new[] { "-NoLogo" } : Array.Empty<string>();
            return new LocalShellStartInfo(shell, Path.GetFileName(shell), arguments, home, environment);
        }

        return new LocalShellStartInfo(shell, "-" + Path.GetFileName(shell), Array.Empty<string>(), home, environment);
    }

    private static bool IsPowerShell(string shell) =>
        Path.GetFileNameWithoutExtension(shell).Equals("pwsh", StringComparison.OrdinalIgnoreCase) ||
        Path.GetFileNameWithoutExtension(shell).Equals("powershell", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The first candidate that actually exists. Every candidate is checked, including bare
    /// names, which are resolved against PATH here rather than left for the OS: the fallback
    /// chains below only mean anything if an uninstalled shell FALLS THROUGH to the next one.
    /// Accepting "pwsh.exe" unchecked is what made a Windows machine without PowerShell 7
    /// fail outright instead of quietly using powershell.exe - found running the win-x64
    /// build under Wine, which has neither.
    /// </summary>
    private static string? FirstUsable(params string?[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate))
            {
                continue;
            }

            if (candidate.Contains(Path.DirectorySeparatorChar) || candidate.Contains('/'))
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                continue;
            }

            if (ResolveOnPath(candidate) is { } resolved)
            {
                return resolved;
            }
        }

        return null;
    }

    // PATHEXT is why this isn't just "join and test": on Windows the candidates are named
    // with their extension already ("pwsh.exe"), but a user-supplied override may not be.
    private static string? ResolveOnPath(string name)
    {
        var extensions = OperatingSystem.IsWindows() && !Path.HasExtension(name)
            ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").Split(';', StringSplitOptions.RemoveEmptyEntries)
            : [string.Empty];

        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var extension in extensions)
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim(), name + extension);
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch (ArgumentException)
                {
                    // A malformed PATH entry (illegal characters) - skip it rather than let
                    // one bad entry stop the search.
                }
            }
        }

        return null;
    }

    private static string DefaultShell()
    {
        if (OperatingSystem.IsWindows())
        {
            // PowerShell over cmd because ConPTY plus cmd.exe still can't do line editing
            // anything like as well, and pwsh over Windows PowerShell where both exist.
            var system32 = Environment.GetFolderPath(Environment.SpecialFolder.System);
            return FirstUsable(
                "pwsh.exe",
                Path.Combine(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
                Environment.GetEnvironmentVariable("COMSPEC"))
                ?? Path.Combine(system32, "cmd.exe");
        }

        // /system/bin/sh is the only shell an Android device is guaranteed to have, and it is
        // outside the app sandbox, which is the point: nothing under the app's own data
        // directory is executable there.
        return FirstUsable("/bin/bash", "/bin/zsh", "/bin/sh", "/system/bin/sh") ?? "/bin/sh";
    }

    /// <summary>
    /// Where the shell starts, and what it will call $HOME. On Android there is no user home
    /// at all, so the app makes one inside its own data directory - without it the shell
    /// starts in "/", every history file write fails, and `cd ~` goes nowhere useful.
    /// </summary>
    private static string HomeDirectory()
    {
        if (OperatingSystem.IsAndroid())
        {
            var home = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "slopterm", "home");
            try
            {
                Directory.CreateDirectory(home);
                return home;
            }
            catch (Exception)
            {
                // Read-only or missing for reasons we can't fix from here; the shell can
                // still run, it just won't have a writable home.
                return "/";
            }
        }

        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Directory.Exists(profile) ? profile : Directory.GetCurrentDirectory();
    }

    private static Dictionary<string, string> BuildEnvironment(string home, string shell)
    {
        var environment = new Dictionary<string, string>(
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);

        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key && entry.Value is string value)
            {
                environment[key] = value;
            }
        }

        // Inherited from whatever launched the app, and stale the moment the terminal is
        // resized. Programs prefer them over the PTY's real size, so leaving them in produces
        // output wrapped to the wrong width in a terminal that knows perfectly well how wide
        // it is.
        environment.Remove("COLUMNS");
        environment.Remove("LINES");

        // Never inherited into a user's shell: they exist to point *this process* at test
        // fixtures, and a shell that quietly picks them up would be operating on a different
        // vault than the app it was launched from.
        environment.Remove("SLOPTERM_VAULT_DIR");
        environment.Remove(ShellOverrideVariable);

        environment["TERM"] = "xterm-256color";
        environment["COLORTERM"] = "truecolor";
        environment["HOME"] = home;
        environment["SHELL"] = shell;

        if (OperatingSystem.IsAndroid())
        {
            // A .NET-for-Android process inherits almost nothing useful, so the shell gets
            // told where the system binaries are and where it may write.
            environment["PATH"] = "/system/bin:/system/xbin:/vendor/bin";
            environment["TMPDIR"] = Path.Combine(home, "tmp");
            try
            {
                Directory.CreateDirectory(environment["TMPDIR"]);
            }
            catch (Exception)
            {
                environment.Remove("TMPDIR");
            }
        }

        return environment;
    }

    /// <summary>A short label for the tab and the connection log, e.g. "bash on this-host".</summary>
    public static string DescribeShell(string executable) => Path.GetFileNameWithoutExtension(executable);

    /// <summary>
    /// The platform name shown next to a local tab. Deliberately coarse - the frontend uses it
    /// as a label, never as a capability check.
    /// </summary>
    public static string PlatformName()
    {
        if (OperatingSystem.IsAndroid()) return "Android";
        if (OperatingSystem.IsWindows()) return "Windows";
        if (OperatingSystem.IsMacOS()) return "macOS";
        if (OperatingSystem.IsLinux()) return "Linux";
        return RuntimeInformation.OSDescription;
    }
}
