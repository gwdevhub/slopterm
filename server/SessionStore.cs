using System.Collections.Concurrent;

namespace Slopterm.Server;

public sealed class SessionStore
{
    private readonly ConcurrentDictionary<string, TerminalSession> _sessions = new();

    public void Add(TerminalSession session) => _sessions[session.Id] = session;

    public TerminalSession? Get(string id) => _sessions.GetValueOrDefault(id);

    /// <returns>
    /// The removed session, or null if nothing was removed (e.g. a natural WS-close and an
    /// explicit disconnect call both racing to remove the same id) - callers use this to log
    /// a "disconnected" event exactly once, not once per call site.
    /// </returns>
    public TerminalSession? Remove(string id)
    {
        if (_sessions.TryRemove(id, out var session))
        {
            session.Dispose();
            return session;
        }

        return null;
    }
}
