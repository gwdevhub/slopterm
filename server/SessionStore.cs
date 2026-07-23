using System.Collections.Concurrent;

namespace Slopterm.Server;

// Shared by TerminalSession (interactive shell) and SftpSession (file browsing) - both
// are just "a disposable, id-keyed connection kept alive between requests/WS messages".
public sealed class SessionStore<T> where T : class, IDisposable
{
    private readonly ConcurrentDictionary<string, T> _sessions = new();

    public void Add(string id, T session) => _sessions[id] = session;

    public T? Get(string id) => _sessions.GetValueOrDefault(id);

    /// <returns>
    /// The removed session, or null if nothing was removed (e.g. a natural WS-close and an
    /// explicit disconnect call both racing to remove the same id) - callers use this to log
    /// a "disconnected" event exactly once, not once per call site.
    /// </returns>
    public T? Remove(string id)
    {
        if (_sessions.TryRemove(id, out var session))
        {
            session.Dispose();
            return session;
        }

        return null;
    }

    /// <summary>
    /// The quit path: disposing every session unblocks the blocking shell-read pumps holding
    /// the terminal WebSocket handlers open, so shutdown never waits on a live connection.
    /// Best-effort per session - one connection failing to tear down cleanly must not keep
    /// the rest (or the process) alive.
    /// </summary>
    public void DisposeAll()
    {
        foreach (var id in _sessions.Keys)
        {
            try
            {
                Remove(id);
            }
            catch
            {
                // best-effort teardown on the way out
            }
        }
    }
}
