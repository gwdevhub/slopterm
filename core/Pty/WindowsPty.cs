using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Slopterm.Server;

/// <summary>
/// A pseudo-terminal on Windows, via ConPTY (<c>CreatePseudoConsole</c>, Windows 10 1809 and
/// later). Two anonymous pipes are handed to the console host, which sits between them and the
/// child process translating the child's console API calls into the VT sequences xterm.js
/// already speaks - so from this side a Windows shell reads and writes exactly like the
/// Unix one.
///
/// Handle ownership is the fiddly part and the source of the classic ConPTY hang: the console
/// host DUPLICATES the two ends it is given, so this process has to close its own copies of
/// them, or the read end never sees EOF when the shell exits and the terminal tab hangs open
/// on a dead shell forever.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class WindowsPty : IDisposable
{
    private readonly IntPtr _pseudoConsole;
    private readonly IntPtr _process;
    private readonly FileStream _output;
    private readonly FileStream _input;
    private int _disposed;

    private WindowsPty(IntPtr pseudoConsole, IntPtr process, FileStream output, FileStream input)
    {
        _pseudoConsole = pseudoConsole;
        _process = process;
        _output = output;
        _input = input;
    }

    /// <summary>
    /// Whether ConPTY is actually here. Resolved by lookup rather than by a Windows version
    /// check because the version isn't the whole answer: Windows 10 before 1809 doesn't have
    /// it, and neither does Wine, where the app otherwise runs (see AGENTS.md's Wine testing
    /// requirement). Without this the missing export surfaces as an EntryPointNotFound thrown
    /// from inside a connect, instead of a button that was never offered.
    /// </summary>
    public static bool IsSupported => HasConPty.Value;

    private static readonly Lazy<bool> HasConPty = new(() =>
        OperatingSystem.IsWindows() &&
        NativeLibrary.TryLoad("kernel32.dll", typeof(WindowsPty).Assembly, null, out var kernel32) &&
        NativeLibrary.TryGetExport(kernel32, "CreatePseudoConsole", out _));

    public static WindowsPty Open(LocalShellStartInfo startInfo, uint columns, uint rows)
    {
        // "In" and "out" here are named from the CHILD's point of view, which is how the Win32
        // API names them: the child reads from inPipe and writes to outPipe.
        if (!Native.CreatePipe(out var inRead, out var inWrite, IntPtr.Zero, 0))
        {
            throw Fail("create the terminal's input pipe");
        }

        if (!Native.CreatePipe(out var outRead, out var outWrite, IntPtr.Zero, 0))
        {
            Native.CloseHandle(inRead);
            Native.CloseHandle(inWrite);
            throw Fail("create the terminal's output pipe");
        }

        var size = new Native.Coord
        {
            X = (short)Math.Clamp(columns, 1, short.MaxValue),
            Y = (short)Math.Clamp(rows, 1, short.MaxValue),
        };

        var created = Native.CreatePseudoConsole(size, inRead, outWrite, 0, out var pseudoConsole);

        // The console host has its own duplicates now; these two are the child's ends and
        // this process must not keep them. Done before the failure check so the pipes are
        // cleaned up either way.
        Native.CloseHandle(inRead);
        Native.CloseHandle(outWrite);

        if (created != 0)
        {
            Native.CloseHandle(inWrite);
            Native.CloseHandle(outRead);
            throw new IOException($"Could not create a pseudo-console: 0x{created:x8}");
        }

        try
        {
            var process = StartChild(startInfo, pseudoConsole);
            return new WindowsPty(
                pseudoConsole,
                process,
                new FileStream(new SafeFileHandle(outRead, ownsHandle: true), FileAccess.Read),
                new FileStream(new SafeFileHandle(inWrite, ownsHandle: true), FileAccess.Write));
        }
        catch (Exception)
        {
            Native.ClosePseudoConsole(pseudoConsole);
            Native.CloseHandle(inWrite);
            Native.CloseHandle(outRead);
            throw;
        }
    }

    private static IntPtr StartChild(LocalShellStartInfo startInfo, IntPtr pseudoConsole)
    {
        var attributeSize = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
        var attributes = Marshal.AllocHGlobal(attributeSize);

        try
        {
            if (!Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize))
            {
                throw Fail("prepare the process attributes");
            }

            if (!Native.UpdateProcThreadAttribute(
                    attributes, 0, Native.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudoConsole,
                    IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                throw Fail("attach the shell to the pseudo-console");
            }

            var startupInfo = new Native.StartupInfoEx();
            startupInfo.StartupInfo.cb = Marshal.SizeOf<Native.StartupInfoEx>();
            startupInfo.AttributeList = attributes;

            // CreateProcessW writes into the command line it is given, so it cannot be a
            // literal or an interned managed string - hence the mutable buffer.
            var commandLine = new StringBuilder(BuildCommandLine(startInfo));
            var environment = BuildEnvironmentBlock(startInfo.Environment);

            try
            {
                var started = Native.CreateProcessW(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    // Inheritance off: the child's stdio comes from the pseudo-console, and
                    // inheriting this process's handles into a user's shell would hand it
                    // every socket and file the app has open.
                    false,
                    Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_UNICODE_ENVIRONMENT,
                    environment,
                    startInfo.WorkingDirectory,
                    ref startupInfo,
                    out var processInformation);

                if (!started)
                {
                    throw Fail($"start {startInfo.Executable}");
                }

                // Only the process handle is kept, to wait on and to kill with; the thread
                // handle would just be a leak.
                Native.CloseHandle(processInformation.hThread);
                return processInformation.hProcess;
            }
            finally
            {
                Marshal.FreeHGlobal(environment);
            }
        }
        finally
        {
            Native.DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
        }
    }

    /// <summary>Blocking read of the shell's output. Returns 0 once the shell has exited.</summary>
    public int Read(byte[] buffer, int offset, int count)
    {
        try
        {
            return _output.Read(buffer, offset, count);
        }
        catch (Exception)
        {
            // The pipe broke, which on this side means the console host tore down with the
            // shell. Same news as a clean EOF.
            return 0;
        }
    }

    public void Write(byte[] buffer, int offset, int count)
    {
        try
        {
            _input.Write(buffer, offset, count);
            _input.Flush();
        }
        catch (Exception)
        {
            // Nothing left to type into; the reader is about to report the session over.
        }
    }

    public void Resize(uint columns, uint rows)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        var size = new Native.Coord
        {
            X = (short)Math.Clamp(columns, 1, short.MaxValue),
            Y = (short)Math.Clamp(rows, 1, short.MaxValue),
        };
        Native.ResizePseudoConsole(_pseudoConsole, size);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        // Closing the pseudo-console is the polite ask: it signals the child that its console
        // went away, and it is also what releases the reader blocked on the output pipe.
        try
        {
            Native.ClosePseudoConsole(_pseudoConsole);
        }
        catch (Exception) { }

        try
        {
            _output.Dispose();
        }
        catch (Exception) { }

        try
        {
            _input.Dispose();
        }
        catch (Exception) { }

        // ...and this is the backstop, off-thread so a shell that won't leave can't hold up a
        // quit. A cmd.exe sitting on a "Terminate batch job (Y/N)?" prompt is the everyday
        // case: closing the console alone does not end it.
        _ = Task.Run(() =>
        {
            try
            {
                if (Native.WaitForSingleObject(_process, 2000) != 0)
                {
                    Native.TerminateProcess(_process, 1);
                }
            }
            catch (Exception) { }
            finally
            {
                Native.CloseHandle(_process);
            }
        });
    }

    // Standard CommandLineToArgvW quoting, which is what a Windows child uses to split this
    // back apart. Paths with spaces (C:\Program Files\PowerShell\7\pwsh.exe) make this
    // mandatory even though the arguments themselves are ours.
    private static string BuildCommandLine(LocalShellStartInfo startInfo)
    {
        var parts = new List<string> { startInfo.Executable };
        parts.AddRange(startInfo.Arguments);
        return string.Join(' ', parts.Select(Quote));
    }

    private static string Quote(string argument)
    {
        if (argument.Length > 0 && !argument.Any(c => c is ' ' or '\t' or '"'))
        {
            return argument;
        }

        var quoted = new StringBuilder("\"");
        for (var i = 0; i < argument.Length; i++)
        {
            var backslashes = 0;
            while (i < argument.Length && argument[i] == '\\')
            {
                backslashes++;
                i++;
            }

            if (i == argument.Length)
            {
                quoted.Append('\\', backslashes * 2);
                break;
            }

            if (argument[i] == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
            }
            else
            {
                quoted.Append('\\', backslashes);
            }

            quoted.Append(argument[i]);
        }

        return quoted.Append('"').ToString();
    }

    // A CREATE_UNICODE_ENVIRONMENT block: "K=V\0K=V\0\0", sorted because the Win32 docs
    // require it and some programs (notably cmd.exe's own variable lookup) rely on it.
    private static IntPtr BuildEnvironmentBlock(IReadOnlyDictionary<string, string> environment)
    {
        var block = new StringBuilder();
        foreach (var pair in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        }

        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static IOException Fail(string what) =>
        new($"Could not {what}: {new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message}");

    private static class Native
    {
        internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;

        [StructLayout(LayoutKind.Sequential)]
        internal struct Coord
        {
            public short X;
            public short Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfo
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr pseudoConsole);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern int ResizePseudoConsole(IntPtr pseudoConsole, Coord size);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern void ClosePseudoConsole(IntPtr pseudoConsole);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool TerminateProcess(IntPtr handle, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern bool CreateProcessW(
            string? applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string? currentDirectory,
            ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation);
    }
}
