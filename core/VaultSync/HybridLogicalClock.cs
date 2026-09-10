using System.Globalization;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// One hybrid logical clock reading: wall-clock milliseconds, a same-millisecond counter, and a
/// node fingerprint for the final tiebreak. Keeps edits ordered across devices whose clocks
/// disagree. Serialized as "2026-07-30T12:00:00.123Z-0007-a1b2c3d4".
/// </summary>
public readonly record struct Hlc(DateTimeOffset Physical, int Counter, string Node) : IComparable<Hlc>
{
    private const string PhysicalFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";

    public override string ToString() =>
        $"{Physical.UtcDateTime.ToString(PhysicalFormat, CultureInfo.InvariantCulture)}-{Counter:D4}-{Node}";

    /// <summary>
    /// Lenient on purpose: an unparseable value reads as the epoch rather than taking a whole
    /// sync down, so the record still syncs but never wins a conflict.
    /// </summary>
    public static Hlc Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return new Hlc(DateTimeOffset.UnixEpoch, 0, string.Empty);
        }

        // Split from the right: the physical part contains '-' of its own, the last two
        // fields never do.
        var lastDash = value.LastIndexOf('-');
        var middleDash = lastDash <= 0 ? -1 : value.LastIndexOf('-', lastDash - 1);
        if (middleDash <= 0)
        {
            return new Hlc(DateTimeOffset.UnixEpoch, 0, string.Empty);
        }

        var physicalText = value[..middleDash];
        var counterText = value[(middleDash + 1)..lastDash];
        var node = value[(lastDash + 1)..];

        if (!DateTimeOffset.TryParse(
                physicalText, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var physical) ||
            !int.TryParse(counterText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var counter))
        {
            return new Hlc(DateTimeOffset.UnixEpoch, 0, string.Empty);
        }

        return new Hlc(physical, counter, node);
    }

    public int CompareTo(Hlc other)
    {
        var byPhysical = Physical.CompareTo(other.Physical);
        if (byPhysical != 0)
        {
            return byPhysical;
        }

        var byCounter = Counter.CompareTo(other.Counter);
        return byCounter != 0 ? byCounter : string.CompareOrdinal(Node, other.Node);
    }

    public static bool operator <(Hlc left, Hlc right) => left.CompareTo(right) < 0;
    public static bool operator >(Hlc left, Hlc right) => left.CompareTo(right) > 0;
    public static bool operator <=(Hlc left, Hlc right) => left.CompareTo(right) <= 0;
    public static bool operator >=(Hlc left, Hlc right) => left.CompareTo(right) >= 0;
}

/// <summary>
/// The process-wide clock that issues <see cref="Hlc"/> values (see <see cref="Shared"/>).
/// Thread-safe: records are stamped from several places concurrently.
/// </summary>
public sealed class HybridLogicalClock(string node, Func<DateTimeOffset>? wallClock = null)
{
    private readonly Func<DateTimeOffset> _wallClock = wallClock ?? (() => DateTimeOffset.UtcNow);
    private readonly object _gate = new();
    private DateTimeOffset _physical = DateTimeOffset.UnixEpoch;
    private int _counter;

    /// <summary>
    /// The app-wide clock, keyed to the first 8 hex of this install's device id - stable across
    /// restarts so this device's own records never tie.
    /// </summary>
    public static HybridLogicalClock Shared { get; } = new(ShortNode(DeviceIdentity.Current));

    public static string ShortNode(string deviceId) =>
        deviceId.Length <= 8 ? deviceId.PadRight(8, '0') : deviceId[..8];

    public string Node { get; } = node;

    public Hlc Now()
    {
        lock (_gate)
        {
            var wall = Truncate(_wallClock());
            if (wall > _physical)
            {
                _physical = wall;
                _counter = 0;
            }
            else
            {
                _counter++;
            }

            return new Hlc(_physical, _counter, Node);
        }
    }

    /// <summary>
    /// Folds a value seen from another device into this clock, so later stamps order after it even
    /// when this machine's wall clock is behind.
    /// </summary>
    public void Observe(Hlc remote)
    {
        lock (_gate)
        {
            var wall = Truncate(_wallClock());
            if (wall > _physical && wall > remote.Physical)
            {
                _physical = wall;
                _counter = 0;
                return;
            }

            if (remote.Physical > _physical)
            {
                _physical = remote.Physical;
                _counter = remote.Counter + 1;
            }
            else if (remote.Physical == _physical)
            {
                _counter = Math.Max(_counter, remote.Counter) + 1;
            }
            else
            {
                _counter++;
            }
        }
    }

    // Truncate to milliseconds to match the serialized form, or a value compares differently
    // before and after a disk round-trip.
    private static DateTimeOffset Truncate(DateTimeOffset value) =>
        new(value.UtcDateTime.Ticks - (value.UtcDateTime.Ticks % TimeSpan.TicksPerMillisecond), TimeSpan.Zero);
}
