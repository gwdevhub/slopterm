using System.Collections.Concurrent;

namespace Slopterm.Server;

// Shared by TerminalSession (interactive shell) and SftpSession (file browsing) - both
// are just "a disposable, id-keyed connection kept alive between requests/WS messages".
public sealed class SessionStore<T> where T : class, IDisposable
{
    private readonly ConcurrentDictionary<string, T> _sessions = new();

    public void Add(string id, T session) => _sessions[id] = session;

    public T? Get(string id) => _sessions.GetValueOrDefault(id);

    /// <summary>
    /// How many connections are live. The Android head reads this on its way to the
    /// background to decide whether keeping the process running is worth a notification
    /// (see SessionKeepAliveService) - no sessions, no service.
    /// </summary>
    public int Count => _sessions.Count;

    /// <summary>
    /// A point-in-time copy, safe to iterate while other threads add and remove - used by
    /// the detached-session reaper and by the "what's still connected" listing the frontend
    /// consults after a reload.
    /// </summary>
    public KeyValuePair<string, T>[] Snapshot() => _sessions.ToArray();

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
