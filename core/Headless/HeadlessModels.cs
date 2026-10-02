using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Slopterm.Server.Headless;

public sealed class HeadlessHostTarget
{
    public required string Address { get; init; }
    public int Port { get; init; } = 22;
    public required string Username { get; init; }
    public required string HostKeySha256 { get; init; }
}

public sealed record HeadlessExecuteRequest(string Command, int TimeoutSeconds = 60);

public sealed record HeadlessExecutionResult(
    DateTimeOffset StartedUtc,
    DateTimeOffset FinishedUtc,
    string Stdout,
    string Stderr,
    int? ExitCode,
    bool TimedOut,
    bool StdoutTruncated,
    bool StderrTruncated,
    string? Error);

public sealed class HeadlessOptions
{
    private static readonly Regex AliasPattern = new(
        @"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));

    public required IPAddress ListenAddress { get; init; }
    public required int Port { get; init; }
    public required string ApiToken { get; init; }
    public required string PrivateKey { get; init; }
    public string? PrivateKeyPassphrase { get; init; }
    public required IReadOnlyDictionary<string, HeadlessHostTarget> Hosts { get; init; }

    public static HeadlessOptions FromEnvironment(
        Func<string, string?>? getEnvironmentVariable = null,
        Func<string, string>? readAllText = null)
    {
        getEnvironmentVariable ??= Environment.GetEnvironmentVariable;
        readAllText ??= File.ReadAllText;

        var listenText = Require(getEnvironmentVariable, "SLOPTERM_HEADLESS_LISTEN");
        if (!IPAddress.TryParse(listenText, out var listenAddress))
        {
            throw new InvalidOperationException("SLOPTERM_HEADLESS_LISTEN must be an IP address.");
        }

        var portText = getEnvironmentVariable("SLOPTERM_HEADLESS_PORT");
        var port = string.IsNullOrWhiteSpace(portText) ? 8080
            : int.TryParse(portText, out var parsedPort) && parsedPort is > 0 and <= 65535
                ? parsedPort
                : throw new InvalidOperationException("SLOPTERM_HEADLESS_PORT must be between 1 and 65535.");

        var apiToken = Require(getEnvironmentVariable, "SLOPTERM_API_TOKEN");
        if (apiToken.Length < 32)
        {
            throw new InvalidOperationException("SLOPTERM_API_TOKEN must contain at least 32 characters.");
        }

        var keyPath = Require(getEnvironmentVariable, "SLOPTERM_HEADLESS_PRIVATE_KEY_FILE");
        var privateKey = readAllText(keyPath);
        if (string.IsNullOrWhiteSpace(privateKey))
        {
            throw new InvalidOperationException("SLOPTERM_HEADLESS_PRIVATE_KEY_FILE is empty.");
        }

        var hostsJson = getEnvironmentVariable("SLOPTERM_HEADLESS_HOSTS_JSON");
        var hostsPath = getEnvironmentVariable("SLOPTERM_HEADLESS_HOSTS_FILE");
        if (!string.IsNullOrWhiteSpace(hostsJson) && !string.IsNullOrWhiteSpace(hostsPath))
        {
            throw new InvalidOperationException(
                "Set only one of SLOPTERM_HEADLESS_HOSTS_JSON or SLOPTERM_HEADLESS_HOSTS_FILE.");
        }
        if (!string.IsNullOrWhiteSpace(hostsPath))
        {
            hostsJson = readAllText(hostsPath.Trim());
        }
        if (string.IsNullOrWhiteSpace(hostsJson))
        {
            throw new InvalidOperationException(
                "SLOPTERM_HEADLESS_HOSTS_JSON or SLOPTERM_HEADLESS_HOSTS_FILE is required.");
        }

        Dictionary<string, HeadlessHostTarget>? parsedHosts;
        try
        {
            parsedHosts = JsonSerializer.Deserialize<Dictionary<string, HeadlessHostTarget>>(
                hostsJson,
                new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException("The Slopterm headless hosts configuration is invalid JSON.", ex);
        }

        if (parsedHosts is null || parsedHosts.Count == 0)
        {
            throw new InvalidOperationException("The Slopterm headless hosts configuration must define at least one host.");
        }

        var hosts = new Dictionary<string, HeadlessHostTarget>(StringComparer.OrdinalIgnoreCase);
        foreach (var (alias, target) in parsedHosts)
        {
            ValidateTarget(alias, target);
            if (!hosts.TryAdd(alias, target))
            {
                throw new InvalidOperationException($"Duplicate headless host alias: {alias}.");
            }
        }

        return new HeadlessOptions
        {
            ListenAddress = listenAddress,
            Port = port,
            ApiToken = apiToken,
            PrivateKey = privateKey,
            PrivateKeyPassphrase = getEnvironmentVariable("SLOPTERM_HEADLESS_PRIVATE_KEY_PASSPHRASE"),
            Hosts = hosts,
        };
    }

    private static string Require(Func<string, string?> getEnvironmentVariable, string name) =>
        string.IsNullOrWhiteSpace(getEnvironmentVariable(name))
            ? throw new InvalidOperationException($"{name} is required.")
            : getEnvironmentVariable(name)!.Trim();

    private static void ValidateTarget(string alias, HeadlessHostTarget target)
    {
        if (!AliasPattern.IsMatch(alias))
        {
            throw new InvalidOperationException($"Invalid headless host alias: {alias}.");
        }
        if (string.IsNullOrWhiteSpace(target.Address))
        {
            throw new InvalidOperationException($"Host {alias} is missing address.");
        }
        if (target.Port is <= 0 or > 65535)
        {
            throw new InvalidOperationException($"Host {alias} has an invalid port.");
        }
        if (string.IsNullOrWhiteSpace(target.Username))
        {
            throw new InvalidOperationException($"Host {alias} is missing username.");
        }
        if (!HeadlessCommandExecutor.TryDecodeFingerprint(target.HostKeySha256, out _))
        {
            throw new InvalidOperationException($"Host {alias} has an invalid hostKeySha256.");
        }
    }
}
