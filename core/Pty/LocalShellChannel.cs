namespace Slopterm.Server;

/// <summary>
/// A shell running on this machine, presented to <see cref="TerminalSession"/> as the same kind
/// of thing an SSH channel is, dispatching to ConPTY or /dev/ptmx.
/// </summary>
public sealed class LocalShellChannel : IShellChannel
{
    private readonly UnixPty? _unix;
    private readonly WindowsPty? _windows;

    /// <summary>The shell that was actually launched, e.g. "bash" - the tab's label comes from this.</summary>
    public string ShellName { get; }

    private LocalShellChannel(string shellName, UnixPty? unix, WindowsPty? windows)
    {
        ShellName = shellName;
        _unix = unix;
        _windows = windows;
    }

    public static LocalShellChannel Start(LocalShellRequest request)
    {
        if (!LocalShell.IsSupported)
        {
            throw new PlatformNotSupportedException(LocalShell.UnsupportedReason);
        }

        var startInfo = LocalShell.Resolve(request.Shell);
        var columns = (uint)Math.Max(request.Columns, 1);
        var rows = (uint)Math.Max(request.Rows, 1);
        var name = LocalShell.DescribeShell(startInfo.Executable);

        return OperatingSystem.IsWindows()
            ? new LocalShellChannel(name, null, WindowsPty.Open(startInfo, columns, rows))
            : new LocalShellChannel(name, UnixPty.Open(startInfo, columns, rows), null);
    }

    // Dispatched on the platform rather than on which field is null, so the analyzer sees the
    // Windows-only calls as reachable on Windows alone.
    public int Read(byte[] buffer, int offset, int count) =>
        OperatingSystem.IsWindows() ? _windows!.Read(buffer, offset, count) : _unix!.Read(buffer, offset, count);

    public void Write(byte[] buffer, int offset, int count)
    {
        if (OperatingSystem.IsWindows())
        {
            _windows!.Write(buffer, offset, count);
        }
        else
        {
            _unix!.Write(buffer, offset, count);
        }
    }

    public void Resize(uint columns, uint rows)
    {
        if (OperatingSystem.IsWindows())
        {
            _windows!.Resize(columns, rows);
        }
        else
        {
            _unix!.Resize(columns, rows);
        }
    }

    // No connection to lose, so every EOF is unambiguously the shell exiting and a local tab
    // never enters the SSH reconnect loop.
    public bool CanLoseTransport => false;

    public bool IsTransportUp => true;

    public bool ShellClosedCleanly(TimeSpan timeout, CancellationToken cancellationToken) => true;

    // Only ever called by the watchdog, which never runs here; implemented rather than thrown.
    public void AbortRead() => Dispose();

    public void Dispose()
    {
        if (OperatingSystem.IsWindows())
        {
            _windows?.Dispose();
        }
        else
        {
            _unix?.Dispose();
        }
    }
}
