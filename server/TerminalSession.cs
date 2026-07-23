using System.Net.WebSockets;
using Renci.SshNet;
using Slopterm.Server.Ai;

namespace Slopterm.Server;

public sealed class TerminalSession : IDisposable
{
    private readonly SshClient _client;
    private readonly ShellStream _shell;
    private readonly object _writeLock = new();

    public string Id { get; }
    public string Host { get; }
    public int Port { get; }
    public string Username { get; }

    /// <summary>Recent raw PTY output, for the in-terminal AI agent to read.</summary>
    public TerminalScrollback Scrollback { get; }

    /// <summary>The AI agent conversation bound to this session; dies with it.</summary>
    public AgentConversation Agent { get; }

    private TerminalSession(string id, SshClient client, ShellStream shell, string host, int port, string username)
    {
        Id = id;
        _client = client;
        _shell = shell;
        Host = host;
        Port = port;
        Username = username;
        Scrollback = new TerminalScrollback();
        Agent = new AgentConversation(this);
    }

    public static TerminalSession Connect(ConnectRequest request)
    {
        var connectionInfo = SshConnectionInfoFactory.Create(request);
        var client = new SshClient(connectionInfo);
        client.Connect();

        // NOTE: SSH.NET's ShellStream has no public API to send a window-change request
        // after creation, so the terminal size below is fixed for the life of the
        // session. Live resize is a known follow-up, not an MVP feature.
        var shell = client.CreateShellStream(
            terminalName: "xterm-256color",
            columns: (uint)request.Columns,
            rows: (uint)request.Rows,
            width: 0,
            height: 0,
            bufferSize: 4096);

        return new TerminalSession(Guid.NewGuid().ToString("N"), client, shell, request.Host, request.Port, request.Username);
    }

    public Task PumpToWebSocketAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        // ShellStream's Read is synchronous/blocking; run it on a dedicated thread-pool
        // thread rather than faking async over it.
        return Task.Run(async () =>
        {
            var buffer = new byte[4096];
            while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                int read;
                try
                {
                    read = _shell.Read(buffer, 0, buffer.Length);
                }
                catch (ObjectDisposedException)
                {
                    break;
                }

                if (read <= 0)
                {
                    // Stream.Read returning zero means EOF. For a shell this is the
                    // normal result of `exit` (or the remote side otherwise closing
                    // the channel), so let the WebSocket endpoint finish and notify
                    // the browser instead of polling the already-closed stream forever.
                    break;
                }

                // Capture into the agent scrollback here (before the socket send) so it's
                // independent of WebSocket backpressure. Capture rides this pump, so output
                // only accumulates while a terminal WS is attached - true for every live tab
                // (TerminalView connects immediately and reconnects), but a session driven
                // purely over the API with no terminal WS sees an empty scrollback.
                Scrollback.Append(buffer.AsSpan(0, read));

                await socket.SendAsync(
                    buffer.AsMemory(0, read), WebSocketMessageType.Binary, endOfMessage: true, cancellationToken);
            }
        }, cancellationToken);
    }

    public async Task PumpFromWebSocketAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[4096];
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.Count > 0)
            {
                lock (_writeLock)
                {
                    _shell.Write(buffer, 0, result.Count);
                    _shell.Flush();
                }
            }
        }
    }

    /// <summary>
    /// Writes agent-generated text straight into the same PTY the user is watching, serialized
    /// against browser keystrokes via <c>_writeLock</c> so the two input sources never interleave
    /// a single write.
    /// </summary>
    public void WriteToShell(string text)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
        lock (_writeLock)
        {
            _shell.Write(bytes, 0, bytes.Length);
            _shell.Flush();
        }
    }

    public void Dispose()
    {
        // Cancel any running agent turn before the shell/client tear down underneath it.
        Agent.Dispose();
        _shell.Dispose();
        if (_client.IsConnected)
        {
            _client.Disconnect();
        }

        _client.Dispose();
    }
}
