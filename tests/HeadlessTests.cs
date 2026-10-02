using System.Net;
using Slopterm.Server.Headless;
using Xunit;

namespace Slopterm.Tests;

public sealed class HeadlessTests
{
    private const string ValidFingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    [Fact]
    public void OptionsRequireExplicitListenAddressAndValidateHosts()
    {
        var values = new Dictionary<string, string?>
        {
            ["SLOPTERM_HEADLESS_LISTEN"] = "0.0.0.0",
            ["SLOPTERM_API_TOKEN"] = new string('a', 32),
            ["SLOPTERM_HEADLESS_PRIVATE_KEY_FILE"] = "/key",
            ["SLOPTERM_HEADLESS_HOSTS_JSON"] =
                $"{{\"prod\":{{\"address\":\"192.0.2.10\",\"port\":22,\"username\":\"root\",\"hostKeySha256\":\"{ValidFingerprint}\"}}}}",
        };

        var options = HeadlessOptions.FromEnvironment(
            name => values.GetValueOrDefault(name),
            path => path == "/key" ? "PRIVATE KEY" : throw new FileNotFoundException());

        Assert.Equal(IPAddress.Any, options.ListenAddress);
        Assert.Equal(8080, options.Port);
        Assert.Equal("192.0.2.10", options.Hosts["PROD"].Address);
    }

    [Fact]
    public void OptionsRejectArbitraryOrUnpinnedHosts()
    {
        var values = new Dictionary<string, string?>
        {
            ["SLOPTERM_HEADLESS_LISTEN"] = "127.0.0.1",
            ["SLOPTERM_API_TOKEN"] = new string('a', 32),
            ["SLOPTERM_HEADLESS_PRIVATE_KEY_FILE"] = "/key",
            ["SLOPTERM_HEADLESS_HOSTS_JSON"] =
                """{"bad alias":{"address":"192.0.2.10","username":"root","hostKeySha256":"nope"}}""",
        };

        Assert.Throws<InvalidOperationException>(() => HeadlessOptions.FromEnvironment(
            name => values.GetValueOrDefault(name),
            _ => "PRIVATE KEY"));
    }

    [Theory]
    [InlineData("secret", "secret", true)]
    [InlineData("secret", "different", false)]
    [InlineData("secret", "secre", false)]
    public void BearerComparisonRequiresExactToken(string presented, string expected, bool matches) =>
        Assert.Equal(matches, HeadlessHost.TokenEquals(presented, expected));

    [Fact]
    public void OutputTruncationIsExplicit()
    {
        var exact = HeadlessCommandExecutor.Truncate("abcd", 4);
        var longValue = HeadlessCommandExecutor.Truncate("abcde", 4);

        Assert.Equal(("abcd", false), exact);
        Assert.Equal(("abcd", true), longValue);
    }

    [Theory]
    [InlineData(ValidFingerprint, true)]
    [InlineData("SHA256:bOY/uU/Pqk7+ZEQYw/Io/5771p3KxVQXgwgrb65Sl4Q", true)]
    [InlineData("SHA256:not-base64", false)]
    [InlineData("MD5:00", false)]
    public void FingerprintsMustBeSha256(string value, bool valid) =>
        Assert.Equal(valid, HeadlessCommandExecutor.TryDecodeFingerprint(value, out _));

    [Fact]
    public void OptionsCanLoadHostsFromFile()
    {
        var values = new Dictionary<string, string?>
        {
            ["SLOPTERM_HEADLESS_LISTEN"] = "127.0.0.1",
            ["SLOPTERM_API_TOKEN"] = new string('a', 32),
            ["SLOPTERM_HEADLESS_PRIVATE_KEY_FILE"] = "/key",
            ["SLOPTERM_HEADLESS_HOSTS_FILE"] = "/hosts.json",
        };

        var options = HeadlessOptions.FromEnvironment(
            name => values.GetValueOrDefault(name),
            path => path switch
            {
                "/key" => "PRIVATE KEY",
                "/hosts.json" =>
                    $"{{\"prod\":{{\"address\":\"192.0.2.10\",\"username\":\"root\",\"hostKeySha256\":\"{ValidFingerprint}\"}}}}",
                _ => throw new FileNotFoundException(),
            });

        Assert.Single(options.Hosts);
    }
}
