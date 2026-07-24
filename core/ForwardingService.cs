using Renci.SshNet;
using Slopterm.Server.Vault;

namespace Slopterm.Server;

/// <summary>Per-rule forwarding state reported to the UI.</summary>
public sealed record ForwardStatus(string RuleId, string HostId, string State, string? Error);

/// <summary>
/// Owns the app's SSH port forwards. Each saved host that has active forwards gets ONE
/// dedicated background SshClient (separate from any terminal/SFTP tab, so a forward outlives
/// the tab and can run with no tab at all), and every rule on that host is a ForwardedPort on
/// it. Forwards are brought up automatically when a terminal/SFTP session to the host opens
/// (StartRulesForHost, called from the connect endpoint) and, for AutoStart rules, in the
/// background at app launch (StartAutoForwards). A per-host monitor keeps the connection alive
/// and re-establishes it (with backoff) if it drops, so a background forward stays up
/// unattended. Everything here is best-effort: failures surface in GetStatus, never as throws
/// that could take the app down.
/// </summary>
public sealed class ForwardingService : IDisposable
{
    private readonly VaultService _vault;
    private readonly object _lock = new();
    private readonly Dictionary<string, HostForwarding> _hosts = new(); // key: hostId
    private bool _disposed;

    public ForwardingService(VaultService vault) => _vault = vault;

    /// <summary>Starts every AutoStart rule - called once at launch. No-op if the vault is locked.</summary>
    public void StartAutoForwards()
    {
        foreach (var id in SafeListRules(r => r.AutoStart))
        {
            TryStart(id);
        }
    }

    /// <summary>Brings up all of a host's forwards - called when a terminal/SFTP session to it opens.</summary>
    public void StartRulesForHost(string hostId)
    {
        foreach (var id in SafeListRules(r => r.HostId == hostId))
        {
            TryStart(id);
        }
    }

    public void StartRule(string ruleId)
    {
        var (rule, request) = ResolveRule(ruleId);
        HostForwarding host;
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            if (!_hosts.TryGetValue(rule.HostId, out host!))
            {
                host = new HostForwarding(request);
                _hosts[rule.HostId] = host;
            }
        }

        host.StartRule(ruleId, rule);
    }

    public void StopRule(string ruleId)
    {
        HostForwarding? owner = null;
        string? hostId = null;
        lock (_lock)
        {
            foreach (var (id, host) in _hosts)
            {
                if (host.HasRule(ruleId))
                {
                    owner = host;
                    hostId = id;
                    break;
                }
            }
        }

        if (owner is null)
        {
            return;
        }

        if (owner.StopRule(ruleId))
        {
            lock (_lock)
            {
                _hosts.Remove(hostId!);
            }

            owner.Dispose();
        }
    }

    public IReadOnlyList<ForwardStatus> GetStatus()
    {
        List<HostForwarding> hosts;
        lock (_lock)
        {
            hosts = _hosts.Values.ToList();
        }

        return hosts.SelectMany(h => h.GetStatus()).ToList();
    }

    private void TryStart(string ruleId)
    {
        try
        {
            StartRule(ruleId);
        }
        catch
        {
            // Best-effort per rule - a missing host/credential for one rule must never stop
            // the others (or crash launch). The failure is visible in GetStatus once started,
            // and simply absent if it never got far enough to register.
        }
    }

    private IReadOnlyList<string> SafeListRules(Func<PortForwardRecord, bool> predicate)
    {
        if (!_vault.IsUnlocked)
        {
            return [];
        }

        try
        {
            return _vault.ListPortForwards().Where(r => predicate(r.Record)).Select(r => r.Id).ToList();
        }
        catch
        {
            return [];
        }
    }

    private (PortForwardRecord Rule, ConnectRequest Request) ResolveRule(string ruleId)
    {
        var match = _vault.ListPortForwards().FirstOrDefault(r => r.Id == ruleId);
        if (match.Record is null)
        {
            throw new InvalidOperationException("Port forward rule not found.");
        }

        var host = _vault.ListHosts().FirstOrDefault(h => h.Id == match.Record.HostId);
        if (host.Record is null)
        {
            throw new InvalidOperationException("The host this forward tunnels through no longer exists.");
        }

        var request = HostConnect.Resolve(host.Record)
            ?? throw new InvalidOperationException("That host has no usable SSH credential.");
        return (match.Record, request);
    }

    public void Dispose()
    {
        List<HostForwarding> hosts;
        lock (_lock)
        {
            _disposed = true;
            hosts = _hosts.Values.ToList();
            _hosts.Clear();
        }

        foreach (var host in hosts)
        {
            host.Dispose();
        }
    }

    /// <summary>One host's dedicated forwarding connection plus every rule riding on it.</summary>
    private sealed class HostForwarding : IDisposable
    {
        private readonly ConnectRequest _request;
        private readonly object _lock = new();
        private readonly Dictionary<string, ActiveForward> _forwards = new();
        private readonly ManualResetEventSlim _wake = new(false);
        private SshClient? _client;
        private CancellationTokenSource? _cts;
        private Task? _monitor;
        private volatile string _connectionState = "connecting"; // connecting | connected | error
        private volatile string? _connectionError;

        public HostForwarding(ConnectRequest request) => _request = request;

        public bool HasRule(string ruleId)
        {
            lock (_lock)
            {
                return _forwards.ContainsKey(ruleId);
            }
        }

        public void StartRule(string ruleId, PortForwardRecord rule)
        {
            lock (_lock)
            {
                _forwards[ruleId] = new ActiveForward(rule);
                if (_monitor is null || _monitor.IsCompleted)
                {
                    // The previous monitor task may have died (e.g. an unexpected exception) -
                    // restart it rather than leaving this host's forwards unattended forever.
                    _cts?.Cancel();
                    _cts = new CancellationTokenSource();
                    var token = _cts.Token;
                    _monitor = Task.Run(() => MonitorLoop(token));
                }
            }

            _wake.Set(); // reconcile now rather than waiting for the next poll
        }

        /// <returns>True if this host has no forwards left and can be torn down.</returns>
        public bool StopRule(string ruleId)
        {
            lock (_lock)
            {
                if (_forwards.Remove(ruleId, out var forward))
                {
                    StopPort(forward);
                }

                if (_forwards.Count == 0)
                {
                    TearDownLocked();
                    return true;
                }
            }

            return false;
        }

        public IReadOnlyList<ForwardStatus> GetStatus()
        {
            lock (_lock)
            {
                var connected = _client is { IsConnected: true };
                return _forwards.Select(kvp =>
                {
                    var forward = kvp.Value;
                    string state;
                    string? error;
                    if (forward.Error is not null)
                    {
                        state = "error";
                        error = forward.Error;
                    }
                    else if (!connected)
                    {
                        state = _connectionState == "error" ? "error" : "connecting";
                        error = _connectionState == "error" ? _connectionError : null;
                    }
                    else
                    {
                        state = forward.Port is { IsStarted: true } ? "active" : "connecting";
                        error = null;
                    }

                    return new ForwardStatus(kvp.Key, forward.Rule.HostId, state, error);
                }).ToList();
            }
        }

        private void MonitorLoop(CancellationToken token)
        {
            var backoff = TimeSpan.FromSeconds(2);
            while (!token.IsCancellationRequested)
            {
                try
                {
                    RunMonitorIteration(token, ref backoff);
                }
                catch (Exception ex) when (!token.IsCancellationRequested)
                {
                    // Anything unexpected here (e.g. SSH.NET's IsConnected throwing once a
                    // session has died from a timeout) must never end this loop - a dead host
                    // forward that nothing retries is worse than a noisy retry.
                    lock (_lock)
                    {
                        DisposeClientLocked();
                        _connectionState = "error";
                        _connectionError = ex.Message;
                    }

                    Wait(token, backoff);
                    backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 1.5, 30));
                }
            }
        }

        private void RunMonitorIteration(CancellationToken token, ref TimeSpan backoff)
        {
            bool needsConnect;
            lock (_lock)
            {
                needsConnect = _forwards.Count > 0 && _client is not { IsConnected: true };
            }

            if (needsConnect)
            {
                SshClient? fresh = null;
                try
                {
                    fresh = new SshClient(SshConnectionInfoFactory.Create(_request))
                    {
                        KeepAliveInterval = TimeSpan.FromSeconds(30),
                    };
                    fresh.Connect();
                    lock (_lock)
                    {
                        DisposeClientLocked();
                        _client = fresh;
                        _connectionState = "connected";
                        _connectionError = null;
                        // The old client's ports died with it - drop them so they get
                        // freshly added below.
                        foreach (var forward in _forwards.Values)
                        {
                            forward.Port = null;
                            forward.Error = null;
                        }
                    }

                    fresh = null; // ownership handed to _client
                    backoff = TimeSpan.FromSeconds(2);
                }
                catch (Exception ex)
                {
                    fresh?.Dispose();
                    lock (_lock)
                    {
                        _connectionState = "error";
                        _connectionError = ex.Message;
                    }

                    Wait(token, backoff);
                    backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 1.5, 30));
                    return;
                }
            }

            lock (_lock)
            {
                if (_client is { IsConnected: true })
                {
                    foreach (var (id, _) in _forwards)
                    {
                        ApplyForwardLocked(id);
                    }
                }
            }

            _wake.Wait(TimeSpan.FromSeconds(5), token);
            _wake.Reset();
        }

        private void ApplyForwardLocked(string ruleId)
        {
            var forward = _forwards[ruleId];
            if (forward.Port is { IsStarted: true })
            {
                return; // already live
            }

            try
            {
                var rule = forward.Rule;
                ForwardedPort port = string.Equals(rule.Type, "remote", StringComparison.OrdinalIgnoreCase)
                    ? new ForwardedPortRemote(rule.BindAddress, (uint)rule.BindPort, rule.DestinationAddress, (uint)rule.DestinationPort)
                    : new ForwardedPortLocal(rule.BindAddress, (uint)rule.BindPort, rule.DestinationAddress, (uint)rule.DestinationPort);
                port.Exception += (_, args) => forward.Error = args.Exception.Message;
                _client!.AddForwardedPort(port);
                port.Start();
                forward.Port = port;
                forward.Error = null;
            }
            catch (Exception ex)
            {
                // A bind conflict (port already in use) etc. - surface it; the monitor retries
                // on its next pass, so it recovers on its own once the port frees up.
                forward.Error = ex.Message;
            }
        }

        private void StopPort(ActiveForward forward)
        {
            try
            {
                if (forward.Port is not null)
                {
                    if (forward.Port.IsStarted)
                    {
                        forward.Port.Stop();
                    }

                    if (_client is not null)
                    {
                        _client.RemoveForwardedPort(forward.Port);
                    }

                    forward.Port.Dispose();
                    forward.Port = null;
                }
            }
            catch
            {
                // Best-effort teardown.
            }
        }

        private void TearDownLocked()
        {
            _cts?.Cancel();
            _wake.Set();
            DisposeClientLocked();
        }

        private void DisposeClientLocked()
        {
            if (_client is null)
            {
                return;
            }

            try
            {
                if (_client.IsConnected)
                {
                    _client.Disconnect();
                }

                _client.Dispose();
            }
            catch
            {
                // Best-effort.
            }

            _client = null;
        }

        private static void Wait(CancellationToken token, TimeSpan delay)
        {
            try
            {
                Task.Delay(delay, token).Wait(token);
            }
            catch
            {
                // Cancelled - the loop's own token check ends it.
            }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                foreach (var forward in _forwards.Values)
                {
                    StopPort(forward);
                }

                _forwards.Clear();
                TearDownLocked();
            }
        }

        private sealed class ActiveForward(PortForwardRecord rule)
        {
            public PortForwardRecord Rule { get; } = rule;
            public ForwardedPort? Port { get; set; }
            public string? Error { get; set; }
        }
    }
}

/// <summary>
/// Maps a saved <see cref="HostRecord"/> onto the <see cref="ConnectRequest"/> the SSH layer
/// expects - the server-side mirror of the frontend's resolveConnectRequest, needed because
/// forwarding builds connections itself (at launch / from a host id) rather than being handed
/// a ConnectRequest the way the terminal connect endpoint is.
/// </summary>
public static class HostConnect
{
    public static ConnectRequest? Resolve(HostRecord host)
    {
        var credential = host.Credentials.FirstOrDefault(c => c.Kind is "password" or "privateKey");
        if (credential is null)
        {
            return null;
        }

        var isKey = credential.Kind == "privateKey";
        return new ConnectRequest
        {
            Host = host.Address,
            Port = host.Port,
            Username = credential.Username ?? string.Empty,
            AuthMethod = isKey ? "privateKey" : "password",
            Password = isKey ? null : credential.Secret,
            PrivateKey = isKey ? credential.Secret : null,
            Passphrase = isKey ? credential.Passphrase : null,
        };
    }
}
