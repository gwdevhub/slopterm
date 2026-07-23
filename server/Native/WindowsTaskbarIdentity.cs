using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Slopterm.Server.Native;

/// <summary>
/// Makes the Photino/WebView-hosted window belong to slopterm in the Windows shell.
/// Photino assigns its own window-level AppUserModelID, which takes precedence over the
/// valid WM_SETICON/class icons and makes the taskbar render a generic hosted-app tile.
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

    public static void ConfigureWindow(nint windowHandle)
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

            // Tell the shell exactly where the taskbar/relaunch icon lives. The
            // published single-file executable contains Native/app.ico as its Win32
            // application icon, while a normal development build's apphost does too.
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

    private static readonly Guid AppUserModelFormatId = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey(Guid formatId, uint propertyId)
    {
        public Guid FormatId = formatId;
        public uint PropertyId = propertyId;
    }

    [StructLayout(LayoutKind.Explicit)]
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
