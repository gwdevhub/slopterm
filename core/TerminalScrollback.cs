namespace Slopterm.Server;

/// <summary>
/// One read out of a <see cref="TerminalScrollback"/>. StartOffset greater than the requested
/// offset means the ring already dropped wanted output; NextOffset is what to ask for next.
/// </summary>
public readonly record struct ScrollbackChunk(byte[] Data, long StartOffset, long NextOffset);

/// <summary>
/// A bounded ring buffer of the raw PTY output bytes for one <see cref="TerminalSession"/>. It
/// serves both the in-terminal AI agent and the terminal WebSocket, which stream from here
/// rather than straight off the shell; the fixed size is what bounds memory while detached.
/// All access is under one lock.
/// </summary>
public sealed class TerminalScrollback
{
    // Sized for the WebSocket's replay window, not just the agent's view.
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
    /// ring. Empty if nothing new was written.
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
    /// <paramref name="offset"/>; the cap is the caller's, independent of the ring's size.
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
    /// The streaming form: the bytes from <paramref name="offset"/> onward, and where they
    /// actually sit. A caller that fell more than Capacity behind gets only the trailing bytes,
    /// reported via a StartOffset beyond what it asked for so it knows output was skipped.
    /// NextOffset is the write cursor at snapshot time, never offset + Data.Length.
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

    /// <summary>Oldest offset still replayable; everything before it has been overwritten.</summary>
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
