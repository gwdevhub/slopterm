namespace Slopterm.Server;

/// <summary>
/// One read out of a <see cref="TerminalScrollback"/> for a streaming reader.
/// <paramref name="StartOffset"/> is where <paramref name="Data"/> begins in the session's
/// total output - greater than the offset the caller asked for exactly when the ring had
/// already overwritten some of what it wanted. <paramref name="NextOffset"/> is what to ask
/// for next time.
/// </summary>
public readonly record struct ScrollbackChunk(byte[] Data, long StartOffset, long NextOffset);

/// <summary>
/// A bounded ring buffer of the raw PTY output bytes for one <see cref="TerminalSession"/>.
/// It serves two readers: the in-terminal AI agent, which reads "what recently happened"
/// without the frontend having to ship the scrollback back up, and the terminal WebSocket
/// itself, which streams from here rather than straight off the shell (see
/// <see cref="TerminalSession.AttachAsync"/>). The session's own reader thread appends, so
/// capture is independent of any browser being attached at all.
///
/// Being the WebSocket's source is also what bounds memory while a session is detached (the
/// app is backgrounded, the page is reloaded): output keeps flowing into a fixed-size ring
/// and the oldest bytes fall off, instead of queueing without limit for a client that may
/// never come back. A client that falls further behind than the ring is told so (see
/// <see cref="ReadFrom"/>) rather than silently shown torn output.
/// All access is under one lock.
/// </summary>
public sealed class TerminalScrollback
{
    // 1 MB rather than the 256 KB this held when the agent was its only reader: it is now
    // also the replay buffer covering a multi-minute detach, and a chatty command can put
    // 256 KB on screen in well under a minute.
    private const int Capacity = 1024 * 1024;
    private readonly byte[] _ring = new byte[Capacity];
    private readonly object _lock = new();
    private int _writeCursor;
    private long _totalWritten;

    public void Append(ReadOnlySpan<byte> data)
    {
        if (data.Length == 0)
        {
            return;
        }

        lock (_lock)
        {
            _totalWritten += data.Length;

            // A single write bigger than the ring can only leave its trailing Capacity bytes.
            if (data.Length >= Capacity)
            {
                data[^Capacity..].CopyTo(_ring);
                _writeCursor = 0;
                return;
            }

            var first = Math.Min(data.Length, Capacity - _writeCursor);
            data[..first].CopyTo(_ring.AsSpan(_writeCursor));
            var rest = data.Length - first;
            if (rest > 0)
            {
                data[first..].CopyTo(_ring.AsSpan(0));
            }

            _writeCursor = (_writeCursor + data.Length) % Capacity;
        }
    }

    public long TotalWritten
    {
        get
        {
            lock (_lock)
            {
                return _totalWritten;
            }
        }
    }

    /// <summary>The last <c>min(maxBytes, buffered)</c> bytes, oldest-first.</summary>
    public byte[] SnapshotTail(int maxBytes)
    {
        lock (_lock)
        {
            return TailLocked(maxBytes);
        }
    }

    /// <summary>
    /// Bytes written after <paramref name="offset"/>, capped to what is still resident in the
    /// ring (at most Capacity trailing bytes). Empty if nothing new was written.
    /// </summary>
    public byte[] SnapshotSince(long offset)
    {
        lock (_lock)
        {
            var available = _totalWritten - offset;
            if (available <= 0)
            {
                return [];
            }

            return TailLocked((int)Math.Min(available, Capacity));
        }
    }

    /// <summary>
    /// The trailing <paramref name="maxBytes"/> of what was written after
    /// <paramref name="offset"/>. The cap is the caller's, independent of the ring's size, so
    /// growing the ring for the WebSocket's sake can't quietly grow what other readers hand on
    /// (the AI agent turns these into tool results the model has to fit in its context).
    /// </summary>
    public byte[] SnapshotSince(long offset, int maxBytes)
    {
        lock (_lock)
        {
            var available = _totalWritten - offset;
            if (available <= 0)
            {
                return [];
            }

            return TailLocked((int)Math.Min(Math.Min(available, Capacity), maxBytes));
        }
    }

    /// <summary>
    /// The streaming form, for the terminal WebSocket: the bytes from <paramref name="offset"/>
    /// onward, and where they actually sit in the stream.
    ///
    /// A caller that stalls long enough for more than Capacity to be written past it can only
    /// be given the trailing Capacity bytes - the rest is gone. That case is reported rather
    /// than papered over: <see cref="ScrollbackChunk.StartOffset"/> is where the returned bytes
    /// really begin, so a caller comparing it against the offset it asked for knows output was
    /// skipped and can tell its own reader. <see cref="ScrollbackChunk.NextOffset"/> is the
    /// write cursor at snapshot time, never <c>offset + Data.Length</c>, which would hand the
    /// same trailing bytes back forever once the ring had wrapped past the caller.
    /// </summary>
    public ScrollbackChunk ReadFrom(long offset)
    {
        lock (_lock)
        {
            var available = _totalWritten - offset;
            if (available <= 0)
            {
                return new ScrollbackChunk([], offset, _totalWritten);
            }

            var count = (int)Math.Min(available, Capacity);
            return new ScrollbackChunk(TailLocked(count), _totalWritten - count, _totalWritten);
        }
    }

    /// <summary>
    /// The oldest offset still replayable: everything before it has been overwritten. A
    /// reattaching client asking for less than this has missed output and is told so.
    /// </summary>
    public long OldestReplayableOffset
    {
        get
        {
            lock (_lock)
            {
                return Math.Max(0, _totalWritten - Capacity);
            }
        }
    }

    private byte[] TailLocked(int count)
    {
        var buffered = (int)Math.Min(_totalWritten, Capacity);
        count = Math.Min(count, buffered);
        if (count <= 0)
        {
            return [];
        }

        var result = new byte[count];
        var start = (int)(((_writeCursor - count) % Capacity + Capacity) % Capacity);
        var firstRun = Math.Min(count, Capacity - start);
        Array.Copy(_ring, start, result, 0, firstRun);
        if (count - firstRun > 0)
        {
            Array.Copy(_ring, 0, result, firstRun, count - firstRun);
        }

        return result;
    }
}
