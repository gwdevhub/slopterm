using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Slopterm.Server.Native;

/// <summary>
/// A Windows system tray icon backed directly by Win32 (Shell_NotifyIcon + a hidden
/// message-only window), so this doesn't need WinForms/WPF/Avalonia or a third-party tray
/// package just to show one icon - see AGENTS.md's system tray section for why.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsTrayIcon : IDisposable
{
    private const int WM_DESTROY = 0x0002;
    private const int WM_CLOSE = 0x0010;
    private const int WM_COMMAND = 0x0111;
    private const int WM_APP = 0x8000;
    private const int WM_TRAYCALLBACK = WM_APP + 1;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONUP = 0x0205;

    private const uint NIM_ADD = 0x00000000;
    private const uint NIM_DELETE = 0x00000002;
    private const uint NIF_MESSAGE = 0x00000001;
    private const uint NIF_ICON = 0x00000002;
    private const uint NIF_TIP = 0x00000004;

    private const uint MF_STRING = 0x00000000;
    private const uint TPM_RIGHTALIGN = 0x0008;
    private const uint TPM_BOTTOMALIGN = 0x0020;

    private const uint IMAGE_ICON = 1;
    private const uint LR_LOADFROMFILE = 0x00000010;
    private const uint LR_DEFAULTSIZE = 0x00000040;

    private const int IDM_OPEN = 1;
    private const int IDM_QUIT = 2;

    private readonly string _tooltip;
    private readonly Action _onOpen;
    private readonly Action _onQuit;
    private readonly ManualResetEventSlim _ready = new(false);

    // Kept alive for the lifetime of the window - the GC must never collect this while
    // native code can still call into it.
    private WndProc? _wndProc;
    private Thread? _messageLoopThread;
    private nint _hwnd;

    public WindowsTrayIcon(string tooltip, Action onOpen, Action onQuit)
    {
        _tooltip = tooltip;
        _onOpen = onOpen;
        _onQuit = onQuit;
    }

    public void Start()
    {
        _messageLoopThread = new Thread(RunMessageLoop) { IsBackground = true, Name = "slopterm-tray" };
        _messageLoopThread.SetApartmentState(ApartmentState.STA);
        _messageLoopThread.Start();
        _ready.Wait();
    }

    public void Dispose()
    {
        if (_hwnd != nint.Zero)
        {
            PostMessage(_hwnd, WM_CLOSE, nint.Zero, nint.Zero);
        }

        _messageLoopThread?.Join(TimeSpan.FromSeconds(2));
        _ready.Dispose();
    }

    private void RunMessageLoop()
    {
        var className = "SloptermTrayWindow";
        _wndProc = WindowProc;

        var wndClass = new WNDCLASSEX
        {
            cbSize = Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            hInstance = GetModuleHandle(null),
            lpszClassName = className,
        };
        RegisterClassEx(ref wndClass);

        // HWND_MESSAGE (-3): a message-only window - never visible, exactly what a tray
        // icon's owner window needs to be.
        _hwnd = CreateWindowEx(0, className, "slopterm", 0, 0, 0, 0, 0, new nint(-3), nint.Zero, wndClass.hInstance, nint.Zero);

        var iconData = new NOTIFYICONDATA
        {
            cbSize = Marshal.SizeOf<NOTIFYICONDATA>(),
            hWnd = _hwnd,
            uID = 1,
            uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage = WM_TRAYCALLBACK,
            hIcon = LoadAppIcon(),
            szTip = _tooltip,
        };
        Shell_NotifyIcon(NIM_ADD, ref iconData);

        _ready.Set();

        while (GetMessage(out var msg, nint.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        Shell_NotifyIcon(NIM_DELETE, ref iconData);
    }

    private nint WindowProc(nint hwnd, int msg, nint wParam, nint lParam)
    {
        switch (msg)
        {
            case WM_TRAYCALLBACK:
                if (lParam == WM_LBUTTONUP)
                {
                    _onOpen();
                }
                else if (lParam == WM_RBUTTONUP)
                {
                    ShowContextMenu(hwnd);
                }

                return nint.Zero;

            case WM_COMMAND:
                var id = wParam.ToInt32() & 0xFFFF;
                if (id == IDM_OPEN)
                {
                    _onOpen();
                }
                else if (id == IDM_QUIT)
                {
                    _onQuit();
                    DestroyWindow(hwnd);
                }

                return nint.Zero;

            case WM_CLOSE:
                DestroyWindow(hwnd);
                return nint.Zero;

            case WM_DESTROY:
                PostQuitMessage(0);
                return nint.Zero;

            default:
                return DefWindowProc(hwnd, msg, wParam, lParam);
        }
    }

    /// <summary>
    /// Loads the embedded app.ico (see EmbeddedIcon.cs; same design as favicon.svg/the PWA
    /// icons) via LoadImage(LR_LOADFROMFILE). Falls back to the stock IDI_APPLICATION icon
    /// if the resource is somehow missing, rather than failing to show a tray icon at all.
    /// </summary>
    private static nint LoadAppIcon()
    {
        var tempPath = EmbeddedIcon.ExtractToTempFile();
        if (tempPath is null)
        {
            return LoadIcon(nint.Zero, new nint(32512)); // IDI_APPLICATION
        }

        var hIcon = LoadImage(nint.Zero, tempPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
        return hIcon != nint.Zero ? hIcon : LoadIcon(nint.Zero, new nint(32512));
    }

    private static void ShowContextMenu(nint hwnd)
    {
        var menu = CreatePopupMenu();
        AppendMenu(menu, MF_STRING, IDM_OPEN, "Open slopterm");
        AppendMenu(menu, MF_STRING, IDM_QUIT, "Quit");

        GetCursorPos(out var pt);
        // Required by TrackPopupMenuEx so the menu reliably closes on outside click.
        SetForegroundWindow(hwnd);
        TrackPopupMenuEx(menu, TPM_RIGHTALIGN | TPM_BOTTOMALIGN, pt.X, pt.Y, hwnd, nint.Zero);
        PostMessage(hwnd, WM_APP, nint.Zero, nint.Zero);
        DestroyMenu(menu);
    }

    private delegate nint WndProc(nint hwnd, int msg, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct WNDCLASSEX
    {
        public int cbSize;
        public int style;
        public nint lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public nint hInstance;
        public nint hIcon;
        public nint hCursor;
        public nint hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATA
    {
        public int cbSize;
        public nint hWnd;
        public int uID;
        public uint uFlags;
        public int uCallbackMessage;
        public nint hIcon;
        // 64 WCHARs matches the original (Windows 95/NT4) NOTIFYICONDATA revision exactly,
        // so cbSize comes out to a size Shell_NotifyIcon actually recognizes. The newer
        // revisions extend szTip to 128 and add several more fields (szInfo, guidItem,
        // etc.) - using their bigger szTip without also adding those fields produces a
        // struct size that matches no known revision at all.
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szTip;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public nint hwnd;
        public int message;
        public nint wParam;
        public nint lParam;
        public int time;
        public POINT pt;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowEx(
        int dwExStyle, string lpClassName, string lpWindowName, int dwStyle,
        int x, int y, int nWidth, int nHeight,
        nint hWndParent, nint hMenu, nint hInstance, nint lpParam);

    [DllImport("user32.dll")]
    private static extern nint DefWindowProc(nint hWnd, int msg, nint wParam, nint lParam);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(nint hWnd);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int nExitCode);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(nint hWnd, int msg, nint wParam, nint lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, nint hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern nint DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern nint LoadIcon(nint hInstance, nint lpIconName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint LoadImage(nint hinst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("user32.dll")]
    private static extern nint CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenu(nint hMenu, uint uFlags, int uIDNewItem, string lpNewItem);

    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(nint hMenu);

    [DllImport("user32.dll")]
    private static extern bool TrackPopupMenuEx(nint hMenu, uint uFlags, int x, int y, nint hWnd, nint lptpm);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint hWnd);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern nint GetModuleHandle(string? lpModuleName);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);
}
