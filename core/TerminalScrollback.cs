namespace Slopterm.Server;

/// <summary>
/// A bounded ring buffer of the raw PTY output bytes for one <see cref="TerminalSession"/>,
/// so the in-terminal AI agent can read "what recently happened" without the frontend having
/// to ship the scrollback back up. Capture is independent of WebSocket backpressure (it
/// happens right after the shell read, before the socket send), so the agent sees output even
/// when no browser is attached. All access is under one lock; the buffer is intentionally
/// small (last 256 KB) since the model only ever needs recent tail output.
/// </summary>
public sealed class TerminalScrollback
{
    private const int Capacity = 256 * 1024;
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
