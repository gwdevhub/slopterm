using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Slopterm.Server.Native;

/// <summary>
/// Makes the Photino/WebView window belong to slopterm in the Windows shell, setting an
/// explicit AppUserModelID plus a RelaunchIconResource for the taskbar icon. WebView2 clears
/// the window's shell property store during async init, so ApplyWindowIdentityWithRetry
/// re-applies on a background thread until the value sticks.
/// </summary>
internal static class WindowsTaskbarIdentity
{
    private const string AppId = "gwdevhub.slopterm";
    private static bool _processConfigured;

    public static void ConfigureProcess()
    {
        if (!OperatingSystem.IsWindows() || _processConfigured)
        {
            return;
        }

        try
        {
            _processConfigured = SetCurrentProcessExplicitAppUserModelID(AppId) >= 0;
        }
        catch
        {
            // Best-effort: taskbar identity must never prevent the window from opening.
        }
    }

    /// <summary>
    /// Applies the taskbar window's shell identity/icon, re-applying until it holds. MUST run
    /// off the window's message-loop thread (it sleeps between attempts). Bounded so a window
    /// that never appears or settles can't spin forever.
    /// </summary>
    public static void ApplyWindowIdentityWithRetry()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(15);
        var stableChecks = 0;
        while (DateTime.UtcNow < deadline)
        {
            var windowHandle = FindMainTaskbarWindow();
            if (windowHandle != nint.Zero)
            {
                // Photino's chromeless window drops WS_THICKFRAME, so it can't be edge-resized.
                // Add it back; the style survives WebView2 init unlike the shell property store.
                EnsureResizableStyle(windowHandle);

                if (IsAppIdApplied(windowHandle))
                {
                    // Survived since the previous pass without WebView2 clearing it.
                    if (++stableChecks >= 3)
                    {
                        return;
                    }
                }
                else
                {
                    ConfigureWindow(windowHandle);
                    stableChecks = 0;
                }
            }

            Thread.Sleep(300);
        }
    }

    /// <summary>
    /// The process's visible, titled top-level window - the Photino frame that owns the
    /// taskbar button. Returns Zero if the window isn't up yet (the caller retries). The
    /// visibility filter means a caller that hides a window must remember the handle itself.
    /// </summary>
    internal static nint FindMainTaskbarWindow()
    {
        if (!OperatingSystem.IsWindows())
        {
            return nint.Zero;
        }

        var processId = (uint)Environment.ProcessId;
        var found = nint.Zero;
        EnumWindows((hwnd, _) =>
        {
            // Redundant with the guard above (EnumWindows only runs on Windows), but the
            // platform analyzer can't see through the lambda to the caller's check.
            if (!OperatingSystem.IsWindows())
            {
                return false;
            }

            GetWindowThreadProcessId(hwnd, out var windowProcessId);
            if (windowProcessId != processId || !IsWindowVisible(hwnd))
            {
                return true; // not ours / not visible - keep enumerating
            }

            var exStyle = GetWindowLong(hwnd, GwlExStyle);
            if ((exStyle & WsExToolWindow) != 0 || GetWindowTextLength(hwnd) == 0)
            {
                return true; // tool/untitled window - not the taskbar frame
            }

            found = hwnd;
            return false; // stop enumerating
        }, nint.Zero);

        return found;
    }

    /// <summary>
    /// Re-adds the sizing frame a chromeless Photino window lacks so it can still be resized
    /// from its edges. Idempotent.
    /// </summary>
    private static void EnsureResizableStyle(nint windowHandle)
    {
        if (!OperatingSystem.IsWindows() || windowHandle == nint.Zero)
        {
            return;
        }

        try
        {
            var style = GetWindowLong(windowHandle, GwlStyle);
            var wanted = style | WsThickFrame | WsMinimizeBox | WsMaximizeBox;
            if (wanted == style)
            {
                return;
            }

            SetWindowLong(windowHandle, GwlStyle, wanted);
            // SWP_FRAMECHANGED makes the new non-client frame take effect without moving,
            // resizing, or restacking the window.
            SetWindowPos(windowHandle, nint.Zero, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoZOrder | SwpFrameChanged);
        }
        catch
        {
            // Best-effort: a window that won't take the style is still usable (just not
            // edge-resizable), never a reason to crash.
        }
    }

    private static void ConfigureWindow(nint windowHandle)
    {
        if (!OperatingSystem.IsWindows() || windowHandle == nint.Zero)
        {
            return;
        }

        IPropertyStore? propertyStore = null;
        try
        {
            var interfaceId = typeof(IPropertyStore).GUID;
            if (SHGetPropertyStoreForWindow(windowHandle, ref interfaceId, out propertyStore) < 0)
            {
                return;
            }

            SetString(propertyStore, new PropertyKey(AppUserModelFormatId, 5), AppId);

            // The published single-file exe and the dev apphost both carry Native/app.ico
            // as their Win32 icon; point the shell at that.
            var processPath = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(processPath))
            {
                SetString(propertyStore, new PropertyKey(AppUserModelFormatId, 3), $"{processPath},0");
            }

            propertyStore.Commit();
        }
        catch
        {
            // Best-effort: the already-open window remains fully usable if the shell
            // rejects a property on an older/unusual Windows environment.
        }
        finally
        {
            if (propertyStore is not null)
            {
                try
                {
                    Marshal.FinalReleaseComObject(propertyStore);
                }
                catch
                {
                    // The shell owns the underlying store; a release race during
                    // shutdown is no reason to fail the application.
                }
            }
        }
    }

    private static void SetString(IPropertyStore propertyStore, PropertyKey key, string value)
    {
        var propertyValue = PropVariant.FromString(value);
        try
        {
            propertyStore.SetValue(ref key, ref propertyValue);
        }
        finally
        {
            PropVariantClear(ref propertyValue);
        }
    }

    /// <summary>
    /// True only if the window currently carries slopterm's AppUserModelID - i.e. WebView2
    /// hasn't cleared our last write. Used to decide when the retry loop can stop.
    /// </summary>
    private static bool IsAppIdApplied(nint windowHandle)
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        IPropertyStore? propertyStore = null;
        try
        {
            var interfaceId = typeof(IPropertyStore).GUID;
            if (SHGetPropertyStoreForWindow(windowHandle, ref interfaceId, out propertyStore) < 0)
            {
                return false;
            }

            var key = new PropertyKey(AppUserModelFormatId, 5);
            if (propertyStore.GetValue(ref key, out var value) < 0)
            {
                return false;
            }

            try
            {
                return value.VariantType == 31 // VT_LPWSTR
                    && value.PointerValue != nint.Zero
                    && string.Equals(Marshal.PtrToStringUni(value.PointerValue), AppId, StringComparison.Ordinal);
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }
        catch
        {
            return false;
        }
        finally
        {
            if (propertyStore is not null)
            {
                try
                {
                    Marshal.FinalReleaseComObject(propertyStore);
                }
                catch
                {
                    // Same best-effort release as ConfigureWindow.
                }
            }
        }
    }

    private static readonly Guid AppUserModelFormatId = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey(Guid formatId, uint propertyId)
    {
        public Guid FormatId = formatId;
        public uint PropertyId = propertyId;
    }

    // Size MUST match the native PROPVARIANT exactly - 24 bytes on x64. Without explicit Size
    // GetValue writes past the struct and corrupts memory (AccessViolation); PointerValue
    // overlays the union's first pointer, where a VT_LPWSTR value lives.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)]
        public ushort VariantType;

        [FieldOffset(8)]
        public nint PointerValue;

        public static PropVariant FromString(string value) => new()
        {
            VariantType = 31, // VT_LPWSTR
            PointerValue = Marshal.StringToCoTaskMemUni(value),
        };
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig]
        int GetCount(out uint propertyCount);

        [PreserveSig]
        int GetAt(uint propertyIndex, out PropertyKey key);

        [PreserveSig]
        int GetValue(ref PropertyKey key, out PropVariant value);

        [PreserveSig]
        int SetValue(ref PropertyKey key, ref PropVariant value);

        [PreserveSig]
        int Commit();
    }

    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const int WsExToolWindow = 0x00000080;
    private const int WsThickFrame = 0x00040000;
    private const int WsMinimizeBox = 0x00020000;
    private const int WsMaximizeBox = 0x00010000;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpFrameChanged = 0x0020;

    private delegate bool EnumWindowsProc(nint hwnd, nint lParam);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, nint lParam);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint hwnd);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(nint hwnd, int index);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    private static extern int SetWindowLong(nint hwnd, int index, int newLong);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(nint hwnd, nint hwndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [SupportedOSPlatform("windows")]
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(nint hwnd);

    [SupportedOSPlatform("windows")]
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [SupportedOSPlatform("windows")]
    [DllImport("shell32.dll")]
    private static extern int SHGetPropertyStoreForWindow(
        nint windowHandle,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore propertyStore);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant propertyValue);
}
