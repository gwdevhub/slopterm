namespace Slopterm.Server;

/// <summary>
/// The byte pipe a <see cref="TerminalSession"/> pumps; SSH and local PTY differ only in how
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
    /// Whether this channel rides a connection that can fail while the shell stays alive. True
    /// for SSH; false for a local PTY, whose only failure mode IS the shell exiting.
    /// </summary>
    bool CanLoseTransport { get; }

    /// <summary>
    /// Whether that connection is still up. Always true when <see cref="CanLoseTransport"/>
    /// is false.
    /// </summary>
    bool IsTransportUp { get; }

    /// <summary>Whether the EOF was the shell finishing rather than the transport dying.</summary>
    bool ShellClosedCleanly(TimeSpan timeout, CancellationToken cancellationToken);

    /// <summary>
    /// Unparks a reader blocked in <see cref="Read"/> on a transport that failed silently,
    /// without tearing down the rest of the channel.
    /// </summary>
    void AbortRead();
}
