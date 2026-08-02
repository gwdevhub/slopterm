namespace Slopterm.Server;

/// <summary>
/// The byte pipe a <see cref="TerminalSession"/> pumps. Everything the session layer does -
/// scrollback, detach/reattach, the reaper, the AI agent - is identical whether the shell is
/// on the far end of an SSH channel or a PTY on this machine, so those two only differ in how
/// bytes get in and out and in what an EOF is allowed to mean.
/// </summary>
public interface IShellChannel : IDisposable
{
    /// <summary>Blocking read. Returns zero or less once no more output will ever arrive.</summary>
    int Read(byte[] buffer, int offset, int count);

    /// <summary>Writes keystrokes to the shell. Serialized by the session's write lock.</summary>
    void Write(byte[] buffer, int offset, int count);

    /// <summary>Tells the shell's PTY the terminal is now this many character cells.</summary>
    void Resize(uint columns, uint rows);

    /// <summary>
    /// Whether this channel rides a connection that can fail underneath it while the shell is
    /// still perfectly alive on the other side. True for SSH; false for a local PTY, whose
    /// only failure mode IS the shell exiting. False switches off the transport watchdog and
    /// makes every EOF a clean exit - a local tab must never sit there "reconnecting" to a
    /// shell that ended, because there is nothing to reconnect to.
    /// </summary>
    bool CanLoseTransport { get; }

    /// <summary>
    /// Whether that connection is still up. Always true when <see cref="CanLoseTransport"/>
    /// is false, since there is no transport to lose.
    /// </summary>
    bool IsTransportUp { get; }

    /// <summary>
    /// Whether the EOF the reader just saw was the shell finishing rather than the transport
    /// under it dying. Called once, from the reader thread, and may block briefly to settle
    /// the answer.
    /// </summary>
    bool ShellClosedCleanly(TimeSpan timeout, CancellationToken cancellationToken);

    /// <summary>
    /// Unparks a reader blocked in <see cref="Read"/> on a transport that has already failed
    /// silently, without tearing down the rest of the channel - see TerminalSession's
    /// transport watchdog, the only caller. Never called when <see cref="CanLoseTransport"/>
    /// is false.
    /// </summary>
    void AbortRead();
}
