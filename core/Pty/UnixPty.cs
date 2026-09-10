using System.Runtime.InteropServices;

namespace Slopterm.Server;

/// <summary>
/// A pseudo-terminal on Linux, macOS and Android: the master side of a <c>/dev/ptmx</c> pair
/// with a shell on the slave, as session leader and controlling terminal.
///
/// Uses <c>posix_spawnp</c> rather than <c>forkpty</c>: forking a managed process can deadlock
/// the child (a runtime lock held by another thread stays locked) before it reaches <c>exec</c>.
/// The recipe mirrors <c>login_tty</c>: <c>POSIX_SPAWN_SETSID</c> plus a file action opening the
/// slave without <c>O_NOCTTY</c> makes that slave the controlling terminal.
/// </summary>
public sealed class UnixPty : IDisposable
{
    private readonly int _master;
    private readonly int _pid;
    private volatile bool _closed;
    private int _fdClosed;
    private int _disposed;

    private UnixPty(int master, int pid)
    {
        _master = master;
        _pid = pid;
    }

    /// <summary>
    /// False on Android below API 28, which has no <c>posix_spawnp</c> symbol at all - a lookup,
    /// not a version check.
    /// </summary>
    public static bool IsSupported => Native.HasPosixSpawn.Value;

    public static UnixPty Open(LocalShellStartInfo startInfo, uint columns, uint rows)
    {
        if (!IsSupported)
        {
            throw new PlatformNotSupportedException(LocalShell.UnsupportedReason);
        }

        var master = Native.posix_openpt(Native.O_RDWR | Native.O_NOCTTY);
        if (master < 0)
        {
            throw Fail("open a pseudo-terminal");
        }

        try
        {
            if (Native.grantpt(master) != 0 || Native.unlockpt(master) != 0)
            {
                throw Fail("unlock the pseudo-terminal");
            }

            var slavePath = Marshal.PtrToStringUTF8(Native.ptsname(master));
            if (string.IsNullOrEmpty(slavePath))
            {
                throw Fail("name the pseudo-terminal");
            }

            // Set before the shell starts so its first prompt is drawn at the real width.
            SetWindowSize(master, columns, rows);

            var pid = Spawn(startInfo, slavePath);
            return new UnixPty(master, pid);
        }
        catch (Exception)
        {
            Native.close(master);
            throw;
        }
    }

    private static int Spawn(LocalShellStartInfo startInfo, string slavePath)
    {
        // The opaque spawn structs differ in size per libc; over-allocating a zeroed block is
        // the portable way to hold one without hard-coding it.
        var fileActions = Marshal.AllocHGlobal(Native.OpaqueSize);
        var attributes = Marshal.AllocHGlobal(Native.OpaqueSize);
        var argv = IntPtr.Zero;
        var envp = IntPtr.Zero;
        var fileActionsReady = false;
        var attributesReady = false;

        try
        {
            Zero(fileActions, Native.OpaqueSize);
            Zero(attributes, Native.OpaqueSize);

            Check(Native.posix_spawn_file_actions_init(fileActions), "prepare the spawn file actions");
            fileActionsReady = true;
            Check(Native.posix_spawnattr_init(attributes), "prepare the spawn attributes");
            attributesReady = true;

            Check(Native.posix_spawnattr_setflags(attributes, Native.POSIX_SPAWN_SETSID), "ask for a new session");

            // No O_NOCTTY: acquiring this as the controlling terminal is the entire point.
            Check(
                Native.posix_spawn_file_actions_addopen(fileActions, 0, slavePath, Native.O_RDWR, 0),
                "attach the shell's stdin");
            Check(Native.posix_spawn_file_actions_adddup2(fileActions, 0, 1), "attach the shell's stdout");
            Check(Native.posix_spawn_file_actions_adddup2(fileActions, 0, 2), "attach the shell's stderr");

            // addchdir_np is late-arriving and only a nicety; without it the shell starts in the
            // app's launch directory instead of the user's home. Not worth failing over.
            if (startInfo.WorkingDirectory is { Length: > 0 } workingDirectory && Native.AddChdir is { } addChdir)
            {
                addChdir(fileActions, workingDirectory);
            }

            argv = AllocStringArray([startInfo.Argv0, .. startInfo.Arguments]);
            envp = AllocStringArray([.. startInfo.Environment.Select(pair => $"{pair.Key}={pair.Value}")]);

            var status = Native.posix_spawnp(out var pid, startInfo.Executable, fileActions, attributes, argv, envp);
            if (status != 0)
            {
                // posix_spawnp reports through its return value, not errno, including the
                // child's own exec failure (a $SHELL that no longer exists).
                throw new IOException($"Could not start {startInfo.Executable}: {Native.DescribeError(status)}");
            }

            return pid;
        }
        finally
        {
            if (fileActionsReady) Native.posix_spawn_file_actions_destroy(fileActions);
            if (attributesReady) Native.posix_spawnattr_destroy(attributes);
            Marshal.FreeHGlobal(fileActions);
            Marshal.FreeHGlobal(attributes);
            FreeStringArray(argv);
            FreeStringArray(envp);
        }
    }

    /// <summary>
    /// Blocking read. Returns 0 once the shell will never produce more. poll-then-read rather
    /// than a plain blocking read so teardown doesn't rely on closing the fd to interrupt it,
    /// which is not guaranteed to wake a blocked thread on Linux.
    /// </summary>
    public int Read(byte[] buffer, int offset, int count)
    {
        while (!_closed)
        {
            var fds = new[] { new Native.PollFd { Fd = _master, Events = Native.POLLIN } };
            var ready = Native.poll(fds, 1, PollTimeoutMs);
            if (ready < 0)
            {
                if (Marshal.GetLastWin32Error() == Native.EINTR)
                {
                    continue;
                }

                return 0;
            }

            if (ready == 0)
            {
                continue;
            }

            var read = (int)Native.read(_master, ref buffer[offset], count);
            if (read > 0)
            {
                return read;
            }

            if (read < 0 && Marshal.GetLastWin32Error() == Native.EINTR)
            {
                continue;
            }

            // 0 is EOF on macOS; on Linux the master returns EIO once the last slave fd is
            // gone. Either way the shell is finished and buffered output was already drained.
            return 0;
        }

        return 0;
    }

    public void Write(byte[] buffer, int offset, int count)
    {
        var written = 0;
        while (written < count && !_closed)
        {
            var chunk = (int)Native.write(_master, ref buffer[offset + written], count - written);
            if (chunk > 0)
            {
                written += chunk;
                continue;
            }

            if (chunk < 0 && Marshal.GetLastWin32Error() == Native.EINTR)
            {
                continue;
            }

            // The shell is gone. Dropping the keystrokes is right: there is nothing to type
            // into, and the reader is about to report the session over.
            return;
        }
    }

    public void Resize(uint columns, uint rows)
    {
        if (_closed)
        {
            return;
        }

        SetWindowSize(_master, columns, rows);
    }

    private static void SetWindowSize(int master, uint columns, uint rows)
    {
        var size = new Native.WinSize
        {
            Rows = (ushort)Math.Clamp(rows, 1, ushort.MaxValue),
            Columns = (ushort)Math.Clamp(columns, 1, ushort.MaxValue),
        };
        // A failed resize costs a badly-wrapped line, not a session; the likely cause (shell
        // just exited) is already handled by the reader.
        Native.ioctl(master, Native.TIOCSWINSZ, ref size);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _closed = true;

        // SIGHUP to the whole process group, as a terminal emulator does when its window
        // closes. The negative pid is the group (the child is its own session leader).
        Native.kill(-_pid, Native.SIGHUP);

        // Reaped off-thread so a shell ignoring SIGHUP can't hold up a quit; without a waitpid
        // the child stays a zombie for the life of the app.
        _ = Task.Run(async () =>
        {
            for (var attempt = 0; attempt < 20; attempt++)
            {
                if (Native.waitpid(_pid, out _, Native.WNOHANG) != 0)
                {
                    break;
                }

                await Task.Delay(100);
            }

            // Still there after two seconds: it is refusing to go, and it is holding a
            // terminal nobody is watching.
            Native.kill(-_pid, Native.SIGKILL);
            Native.waitpid(_pid, out _, 0);
            CloseMaster();
        });

        // Also closed here - after PollTimeoutMs the reader has left the loop, and a session
        // whose shell already exited has no reaper task left to do it.
        _ = Task.Run(async () =>
        {
            await Task.Delay(PollTimeoutMs * 2);
            CloseMaster();
        });
    }

    private void CloseMaster()
    {
        if (Interlocked.Exchange(ref _fdClosed, 1) == 0)
        {
            Native.close(_master);
        }
    }

    // Long enough that an idle terminal isn't waking a thread constantly, short enough that
    // teardown is never perceptible.
    private const int PollTimeoutMs = 200;

    private static void Check(int status, string what)
    {
        if (status != 0)
        {
            throw new IOException($"Could not {what}: {Native.DescribeError(status)}");
        }
    }

    private static IOException Fail(string what) =>
        new($"Could not {what}: {Native.DescribeError(Marshal.GetLastWin32Error())}");

    private static void Zero(IntPtr block, int size)
    {
        for (var i = 0; i < size; i++)
        {
            Marshal.WriteByte(block, i, 0);
        }
    }

    // A NULL-terminated char*[] in unmanaged memory, which is what execve wants and what
    // posix_spawn passes straight through.
    private static IntPtr AllocStringArray(IReadOnlyList<string> items)
    {
        var array = Marshal.AllocHGlobal(IntPtr.Size * (items.Count + 1));
        for (var i = 0; i < items.Count; i++)
        {
            Marshal.WriteIntPtr(array, IntPtr.Size * i, Marshal.StringToHGlobalAnsi(items[i]));
        }

        Marshal.WriteIntPtr(array, IntPtr.Size * items.Count, IntPtr.Zero);
        return array;
    }

    private static void FreeStringArray(IntPtr array)
    {
        if (array == IntPtr.Zero)
        {
            return;
        }

        for (var offset = 0; ; offset += IntPtr.Size)
        {
            var item = Marshal.ReadIntPtr(array, offset);
            if (item == IntPtr.Zero)
            {
                break;
            }

            Marshal.FreeHGlobal(item);
        }

        Marshal.FreeHGlobal(array);
    }

    private static class Native
    {
        // Bigger than any libc's posix_spawnattr_t/posix_spawn_file_actions_t (glibc's are
        // 336 and 80 bytes; macOS and bionic use a single pointer).
        internal const int OpaqueSize = 1024;

        internal const int O_RDWR = 0x0002;
        internal const int EINTR = 4;
        internal const int SIGHUP = 1;
        internal const int SIGKILL = 9;
        internal const int WNOHANG = 1;
        internal const short POLLIN = 0x0001;

        // The two constants that genuinely differ between the BSD and Linux lineages; getting
        // either wrong is silent (a wrong TIOCSWINSZ resizes nothing, a wrong SETSID flag leaves
        // the shell with no controlling terminal).
        internal static readonly int O_NOCTTY = OperatingSystem.IsMacOS() ? 0x20000 : 0x0100;
        internal static readonly nuint TIOCSWINSZ = OperatingSystem.IsMacOS() ? 0x80087467 : 0x5414;
        internal static readonly short POSIX_SPAWN_SETSID = OperatingSystem.IsMacOS() ? (short)0x0400 : (short)0x0080;

        [StructLayout(LayoutKind.Sequential)]
        internal struct PollFd
        {
            public int Fd;
            public short Events;
            public short Revents;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct WinSize
        {
            public ushort Rows;
            public ushort Columns;
            public ushort PixelWidth;
            public ushort PixelHeight;
        }

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_openpt(int flags);

        [DllImport("libc", SetLastError = true)]
        internal static extern int grantpt(int fd);

        [DllImport("libc", SetLastError = true)]
        internal static extern int unlockpt(int fd);

        [DllImport("libc", SetLastError = true)]
        internal static extern IntPtr ptsname(int fd);

        [DllImport("libc", SetLastError = true)]
        internal static extern int close(int fd);

        [DllImport("libc", SetLastError = true)]
        internal static extern nint read(int fd, ref byte buffer, nint count);

        [DllImport("libc", SetLastError = true)]
        internal static extern nint write(int fd, ref byte buffer, nint count);

        [DllImport("libc", SetLastError = true)]
        internal static extern int poll([In, Out] PollFd[] fds, uint count, int timeoutMs);

        [DllImport("libc", SetLastError = true)]
        internal static extern int ioctl(int fd, nuint request, ref WinSize size);

        [DllImport("libc", SetLastError = true)]
        internal static extern int waitpid(int pid, out int status, int options);

        [DllImport("libc", SetLastError = true)]
        internal static extern int kill(int pid, int signal);

        [DllImport("libc", SetLastError = true)]
        internal static extern IntPtr strerror(int error);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawnp(
            out int pid, string file, IntPtr fileActions, IntPtr attributes, IntPtr argv, IntPtr envp);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawn_file_actions_init(IntPtr fileActions);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawn_file_actions_destroy(IntPtr fileActions);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawn_file_actions_addopen(
            IntPtr fileActions, int fd, string path, int flags, uint mode);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawn_file_actions_adddup2(IntPtr fileActions, int fd, int newFd);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawnattr_init(IntPtr attributes);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawnattr_destroy(IntPtr attributes);

        [DllImport("libc", SetLastError = true)]
        internal static extern int posix_spawnattr_setflags(IntPtr attributes, short flags);

        internal delegate int AddChdirDelegate(IntPtr fileActions, string path);

        // Resolved by hand rather than as a DllImport, because a missing symbol must be an
        // answer we can act on, not an EntryPointNotFoundException at the worst moment
        // (posix_spawnp below API 28; addchdir_np below glibc 2.29 / macOS 10.15 / bionic API 34).
        private static readonly Lazy<IntPtr> LibC = new(() =>
            NativeLibrary.TryLoad("libc", typeof(UnixPty).Assembly, null, out var handle) ? handle : IntPtr.Zero);

        internal static readonly Lazy<bool> HasPosixSpawn = new(() =>
            !OperatingSystem.IsWindows() &&
            LibC.Value != IntPtr.Zero &&
            NativeLibrary.TryGetExport(LibC.Value, "posix_spawnp", out _));

        internal static AddChdirDelegate? AddChdir { get; } = ResolveAddChdir();

        private static AddChdirDelegate? ResolveAddChdir()
        {
            if (LibC.Value == IntPtr.Zero ||
                !NativeLibrary.TryGetExport(LibC.Value, "posix_spawn_file_actions_addchdir_np", out var export))
            {
                return null;
            }

            return Marshal.GetDelegateForFunctionPointer<AddChdirDelegate>(export);
        }

        internal static string DescribeError(int error)
        {
            var message = Marshal.PtrToStringUTF8(strerror(error));
            return string.IsNullOrEmpty(message) ? $"error {error}" : message;
        }
    }
}
