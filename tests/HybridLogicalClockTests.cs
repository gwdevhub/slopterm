using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

public sealed class HybridLogicalClockTests
{
    [Fact]
    public void OrdersByPhysicalThenCounterThenNode()
    {
        var early = new Hlc(DateTimeOffset.Parse("2026-07-30T12:00:00Z"), 0, "aaaaaaaa");
        var later = new Hlc(DateTimeOffset.Parse("2026-07-30T12:00:01Z"), 0, "aaaaaaaa");
        var sameMsHigherCounter = new Hlc(DateTimeOffset.Parse("2026-07-30T12:00:00Z"), 1, "aaaaaaaa");
        var sameMsOtherNode = new Hlc(DateTimeOffset.Parse("2026-07-30T12:00:00Z"), 0, "bbbbbbbb");

        Assert.True(early < later);
        Assert.True(early < sameMsHigherCounter);
        Assert.True(early < sameMsOtherNode);
        Assert.True(sameMsHigherCounter < later);
    }

    [Fact]
    public void RoundTripsThroughItsSerializedForm()
    {
        var clock = new HybridLogicalClock("deadbeef");
        var value = clock.Now();
        var parsed = Hlc.Parse(value.ToString());

        Assert.Equal(value, parsed);
        Assert.Equal(0, value.CompareTo(parsed));
    }

    /// <summary>
    /// A record written by a build that predates sync carries no HLC at all. It has to read
    /// as something that loses every conflict rather than throwing - the record still syncs,
    /// it just never wins against a properly stamped peer.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("garbage")]
    [InlineData("2026-07-30T12:00:00.123Z")]
    public void ParsesAnythingUnusableAsTheEpoch(string? value)
    {
        var parsed = Hlc.Parse(value);
        Assert.Equal(DateTimeOffset.UnixEpoch, parsed.Physical);
        Assert.True(parsed < new Hlc(DateTimeOffset.Parse("2020-01-01T00:00:00Z"), 0, "aaaaaaaa"));
    }

    [Fact]
    public void NeverIssuesTheSameValueTwice()
    {
        var frozen = DateTimeOffset.Parse("2026-07-30T12:00:00Z");
        var clock = new HybridLogicalClock("aaaaaaaa", () => frozen);

        var values = Enumerable.Range(0, 100).Select(_ => clock.Now()).ToList();

        Assert.Equal(100, values.Distinct().Count());
        for (var i = 1; i < values.Count; i++)
        {
            Assert.True(values[i - 1] < values[i]);
        }
    }

    /// <summary>
    /// The failure this whole type exists to prevent: a phone whose clock is minutes behind
    /// the laptop must still stamp its edit AFTER the laptop's record it just read, or the
    /// deleted host comes back.
    /// </summary>
    [Fact]
    public void StampsAfterAPeerEvenWhenThisClockIsBehind()
    {
        var behind = DateTimeOffset.Parse("2026-07-30T12:00:00Z");
        var clock = new HybridLogicalClock("bbbbbbbb", () => behind);
        var fromAheadPeer = new Hlc(DateTimeOffset.Parse("2026-07-30T12:05:00Z"), 3, "aaaaaaaa");

        clock.Observe(fromAheadPeer);
        var mine = clock.Now();

        Assert.True(fromAheadPeer < mine);
    }

    /// <summary>
    /// A peer whose clock is an hour BEHIND must not drag this device's counter up to its
    /// value - the wall clock wins, and the counter only carries the within-millisecond
    /// tie-break (1 here, not 100, because Observe and Now land in the same frozen ms).
    /// </summary>
    [Fact]
    public void DoesntInheritABehindPeersCounter()
    {
        var now = DateTimeOffset.Parse("2026-07-30T13:00:00Z");
        var clock = new HybridLogicalClock("bbbbbbbb", () => now);
        var behindPeer = new Hlc(DateTimeOffset.Parse("2026-07-30T12:00:00Z"), 99, "aaaaaaaa");

        clock.Observe(behindPeer);
        var value = clock.Now();

        Assert.Equal(now, value.Physical);
        Assert.Equal(1, value.Counter);
        Assert.True(behindPeer < value);
    }
}
