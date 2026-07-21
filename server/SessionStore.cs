using System.Collections.Concurrent;

namespace Slopterm.Server;

public sealed class SessionStore
{
    private readonly ConcurrentDictionary<string, TerminalSession> _sessions = new();

    public void Add(TerminalSession session) => _sessions[session.Id] = session;

    public TerminalSession? Get(string id) => _sessions.GetValueOrDefault(id);

    public void Remove(string id)
    {
        if (_sessions.TryRemove(id, out var session))
        {
            session.Dispose();
        }
    }
}
