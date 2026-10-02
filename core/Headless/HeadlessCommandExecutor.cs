using System.Security.Cryptography;
using Renci.SshNet;

namespace Slopterm.Server.Headless;

public sealed class HeadlessCommandExecutor
{
    public const int MaximumCommandLength = 16 * 1024;
    public const int MaximumTimeoutSeconds = 60;
    public const int StdoutLimit = 256 * 1024;
    public const int StderrLimit = 64 * 1024;

    private readonly HeadlessOptions _options;

    public HeadlessCommandExecutor(HeadlessOptions options) => _options = options;

    public async Task<HeadlessExecutionResult> ExecuteAsync(
        string alias,
        HeadlessExecuteRequest request,
        CancellationToken cancellationToken)
    {
        if (!_options.Hosts.TryGetValue(alias, out var target))
        {
            throw new KeyNotFoundException($"Unknown host alias: {alias}.");
        }
        if (string.IsNullOrWhiteSpace(request.Command))
        {
            throw new ArgumentException("Command is required.", nameof(request));
        }
        if (request.Command.Length > MaximumCommandLength)
        {
            throw new ArgumentException(
                $"Command exceeds the {MaximumCommandLength}-character limit.",
                nameof(request));
        }
        if (request.TimeoutSeconds is < 1 or > MaximumTimeoutSeconds)
        {
            throw new ArgumentException(
                $"TimeoutSeconds must be between 1 and {MaximumTimeoutSeconds}.",
                nameof(request));
        }

        var startedUtc = DateTimeOffset.UtcNow;
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(request.TimeoutSeconds));

        try
        {
            var connect = new ConnectRequest
            {
                Host = target.Address,
                Port = target.Port,
                Username = target.Username,
                AuthMethod = "privateKey",
                PrivateKey = _options.PrivateKey,
                Passphrase = _options.PrivateKeyPassphrase,
            };
            using var client = new SshClient(SshConnectionInfoFactory.Create(connect));
            var expectedFingerprint = DecodeFingerprint(target.HostKeySha256);
            client.HostKeyReceived += (_, eventArgs) =>
            {
                var actualFingerprint = SHA256.HashData(eventArgs.HostKey);
                eventArgs.CanTrust = CryptographicOperations.FixedTimeEquals(
                    actualFingerprint,
                    expectedFingerprint);
            };

            await client.ConnectAsync(timeoutCts.Token);
            using var command = client.CreateCommand(request.Command);
            command.CommandTimeout = TimeSpan.FromSeconds(request.TimeoutSeconds);
            await command.ExecuteAsync(timeoutCts.Token);

            var stdout = Truncate(command.Result, StdoutLimit);
            var stderr = Truncate(command.Error, StderrLimit);
            return new HeadlessExecutionResult(
                startedUtc,
                DateTimeOffset.UtcNow,
                stdout.Value,
                stderr.Value,
                command.ExitStatus,
                false,
                stdout.Truncated,
                stderr.Truncated,
                command.ExitStatus is null && command.ExitSignal is not null
                    ? $"Terminated by signal {command.ExitSignal}."
                    : null);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new HeadlessExecutionResult(
                startedUtc,
                DateTimeOffset.UtcNow,
                string.Empty,
                string.Empty,
                null,
                true,
                false,
                false,
                $"Timed out after {request.TimeoutSeconds}s.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new HeadlessExecutionResult(
                startedUtc,
                DateTimeOffset.UtcNow,
                string.Empty,
                string.Empty,
                null,
                false,
                false,
                false,
                ex.Message);
        }
    }

    internal static bool TryDecodeFingerprint(string value, out byte[] fingerprint)
    {
        fingerprint = [];
        if (string.IsNullOrWhiteSpace(value) ||
            !value.StartsWith("SHA256:", StringComparison.Ordinal))
        {
            return false;
        }

        try
        {
            var encoded = value["SHA256:".Length..];
            var remainder = encoded.Length % 4;
            if (remainder == 1)
            {
                return false;
            }
            if (remainder != 0)
            {
                encoded = encoded.PadRight(encoded.Length + 4 - remainder, '=');
            }
            fingerprint = Convert.FromBase64String(encoded);
            return fingerprint.Length == SHA256.HashSizeInBytes;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    internal static byte[] DecodeFingerprint(string value) =>
        TryDecodeFingerprint(value, out var fingerprint)
            ? fingerprint
            : throw new InvalidOperationException("Invalid SSH host-key fingerprint.");

    internal static (string Value, bool Truncated) Truncate(string? value, int limit)
    {
        value ??= string.Empty;
        return value.Length <= limit
            ? (value, false)
            : (value[..limit], true);
    }
}
