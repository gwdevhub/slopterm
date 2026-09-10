using System.Collections.Concurrent;

namespace Slopterm.Server;

// Shared by TerminalSession (interactive shell) and SftpSession (file browsing) - both
// are just "a disposable, id-keyed connection kept alive between requests/WS messages".
public sealed class SessionStore<T> where T : class, IDisposable
{
    private readonly ConcurrentDictionary<string, T> _sessions = new();

    public void Add(string id, T session) => _sessions[id] = session;

    public T? Get(string id) => _sessions.GetValueOrDefault(id);

    /// <summary>How many connections are live; the Android head reads this to decide whether keeping the process running is worth a notification (see SessionKeepAliveService).</summary>
    public int Count => _sessions.Count;

    /// <summary>A point-in-time copy, safe to iterate while other threads add and remove - used by the reaper and the post-reload listing.</summary>
    public KeyValuePair<string, T>[] Snapshot() => _sessions.ToArray();

    /// <returns>The removed session, or null if nothing was removed - callers use this to log a "disconnected" event exactly once.</returns>
    public T? Remove(string id)
    {
        if (_sessions.TryRemove(id, out var session))
        {
            session.Dispose();
            return session;
        }

        return null;
    }

    /// <summary>The quit path: disposing every session unblocks the shell-read pumps holding the terminal WS handlers open. Best-effort per session.</summary>
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
            }
        }
    }
}
