using System.Net.WebSockets;
using Renci.SshNet;

namespace Slopterm.Server;

public sealed class TerminalSession : IDisposable
{
    private readonly SshClient _client;
    private readonly ShellStream _shell;

    public string Id { get; }
    public string Host { get; }
    public int Port { get; }
    public string Username { get; }

    private TerminalSession(string id, SshClient client, ShellStream shell, string host, int port, string username)
    {
        Id = id;
        _client = client;
        _shell = shell;
        Host = host;
        Port = port;
        Username = username;
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
                    await Task.Delay(25, cancellationToken);
                    continue;
                }

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
                _shell.Write(buffer, 0, result.Count);
                _shell.Flush();
            }
        }
    }

    public void Dispose()
    {
        _shell.Dispose();
        if (_client.IsConnected)
        {
            _client.Disconnect();
        }

        _client.Dispose();
    }
}
