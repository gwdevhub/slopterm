# Agent instructions — slopterm

slopterm (repo: `gwdevhub/terminal`) is a cross-platform SSH/FTP terminal client in the
spirit of Termius, targeting Linux, macOS and Windows.

## Architecture

- **Front-end:** React + TypeScript + Tailwind CSS + xterm.js, built with Vite, served as
  a static bundle. Decided over a native (Avalonia) UI specifically so the terminal is
  reachable from any device's browser, not just a desktop window.
- **Mobile layout is a first-class concern, not an afterthought.** The backend serves a
  plain HTTP(S) URL, so a phone/tablet on the same network (or over a tunnel) is a
  realistic client, not an edge case. Build every screen mobile-first with Tailwind's
  responsive utilities from the start (host list, vault, SFTP browser, tab bar) — don't
  bolt on responsiveness after the desktop layout is done. The terminal view itself
  (xterm.js) is the one exception where small-screen usability is inherently limited, but
  its surrounding chrome (tabs, keyboard toolbar, connect/disconnect controls) must still
  work at phone width.
- **Backend:** .NET 8 + SSH.NET (`Renci.SshNet`) — owns all SSH/SFTP/port-forwarding I/O,
  serves the built React bundle plus a WebSocket PTY stream over a local ASP.NET Core
  (Kestrel) HTTP server.
- **No bundled browser/webview.** The backend binds `127.0.0.1` on a (by default random)
  port and prints the URL; the user opens it in whatever browser they already have
  installed — the code-server/Jupyter model. Never bind `0.0.0.0` without an explicit,
  user-supplied opt-in flag for remote access.
- **Vault (implemented, `server/Vault/`):** local, per-item records (stable id +
  `updatedAt`) — not one monolithic blob — encrypted with AES-GCM behind a master
  password (Argon2id KDF via `Konscious.Security.Cryptography.Argon2`, a justified
  addition to the "keep dependencies minimal" rule since .NET has no built-in Argon2).
  This shape exists so records can be merged across devices instead of clobbered:
  `hosts/{id}.json` keeps `id`/`updatedAt` **outside** the ciphertext (needed for a future
  sync/merge process to compare records without decrypting them first) and encrypts
  everything else (name, address, credentials). `vault.json` holds the KDF salt/params
  plus a canary value so a wrong master password fails clearly instead of a confusing
  per-record decrypt error. The derived key lives in memory only for the process's
  lifetime (`VaultService`) - never written to disk, never logged. Storage location is
  per-OS convention (`AppPaths.cs`: Windows `%APPDATA%`, Linux `~/.local/share`, macOS
  `~/Library/Application Support` - handled explicitly since .NET's `SpecialFolder` API
  gets macOS wrong by default), overridable via `SLOPTERM_VAULT_DIR` for tests/advanced
  use. `HostRecord.Credentials` is a *list* from day one (password/privateKey/envVar),
  matching issue #12's multi-credential design even though its UI doesn't exist yet, to
  avoid a breaking schema change later.
  - **Verified Argon2id/AES-GCM produce byte-identical output on Windows (via Wine) and
    Linux** using a fixed password/salt/nonce in an isolated test harness - unlike
    Curve25519, AES-GCM is a far more standardized primitive across CNG and OpenSSL, so
    this was a real risk worth checking (not an assumption), but it turned out fine.
  - The current front-end vault UI (`VaultPanel.tsx`) is deliberately minimal/unstyled -
    it exists to prove the encrypted backend works end-to-end through the real UI, not
    just curl. The actual Termius-style layout (nav rail, host card grid, host details
    panel) is issues #8/#10, built on top of this.
- **Sync is a hard requirement**, not a stretch goal. Design is zero-knowledge: only the
  AES-GCM ciphertext ever leaves the device, the master key/password never does. Start
  with a git-backed sync backend (push/pull the encrypted blob to a private repo or gist)
  before considering a hosted sync service.

## Distribution constraints

- End users must **not** need the .NET runtime pre-installed. Publish **self-contained,
  single-file** binaries per RID (`win-x64`, `linux-x64`, `osx-x64`, `osx-arm64`).
- The React build isn't just self-contained at the runtime level - it's embedded into the
  published assembly itself (`EmbeddedResource` in `Slopterm.Server.csproj`, served via
  `ManifestEmbeddedFileProvider` in `Program.cs`), not copied to a `wwwroot` folder next
  to the exe. `dotnet publish` produces one file with genuinely everything in it.
  `.github/workflows/release.yml` builds this for every OS on every push to `main` and
  publishes them as assets on a rolling `latest` GitHub Release (also runnable on demand
  via `workflow_dispatch`) - that release is the place to grab a build, not a manual
  local publish.
- `EnableCompressionInSingleFile` is on - a free, safe ~51% size cut (verified: ~98MB to
  ~48MB on win-x64) with no functional risk, just a self-extraction step into a temp dir
  on first run each launch.
- **Do not enable `PublishTrimmed`.** This was actually tried (2026-07-21) and it broke
  every single endpoint, not just an edge case: `System.Text.Json` couldn't resolve
  `ConnectRequest`'s type metadata once reflection-based JSON was trimmed
  (`System.NotSupportedException: JsonTypeInfo metadata ... was not provided`), which
  threw while building the route table and took down static file serving too. Beyond our
  own JSON layer, SSH.NET isn't trim-annotated, so the trimmer can silently strip its
  internals with **no warning at all** - the trim publish produced zero trimmer warnings
  despite being thoroughly broken, which is the exact danger, not proof of safety. Do not
  reach for Native AOT either, same underlying reflection risk. If trimming is
  reconsidered later (e.g. after adding a `JsonSerializerContext` source generator for our
  own models), it would still need SSH.NET's entire surface re-verified end-to-end
  (auth, SFTP, algorithm negotiation) since the library gives no compile-time signal of
  what it's unsafe to strip.
- Keep backend NuGet dependencies minimal — every package is footprint riding along with
  the CLR in a self-contained binary. Justify additions against
  SSH.NET + ASP.NET Core Kestrel + a JSON serializer before adding more.

## System tray (Windows)

- The published Windows build has no console window (`OutputType=WinExe`, gated to
  `RuntimeIdentifier == win-x64` only - plain `dotnet run`/`dotnet build` without `-r`
  stays a normal console app on every OS for local dev). The only UI is a tray icon
  (`Native/WindowsTrayIcon.cs`); left-click/"Open" opens the printed URL in the default
  browser, right-click shows an Open/Quit menu, "Quit" stops the app cleanly.
- Implemented via raw Win32 P/Invoke (`RegisterClassEx`/`CreateWindowEx` for a hidden
  `HWND_MESSAGE`-parented window + `Shell_NotifyIcon`), not WinForms/WPF/Avalonia or a
  third-party tray package - see issue #17's reasoning (zero added dependencies/weight,
  matches every other packaging decision in this repo).
- **`NOTIFYICONDATA.szTip` must stay `SizeConst = 64`, not the newer 128.** The modern
  Windows header extends `szTip` to 128 chars but also adds several more fields
  (`szInfo`, `guidItem`, etc.) alongside it; using the bigger `szTip` without those fields
  produces a struct size matching no officially recognized `NOTIFYICONDATA` revision.
  Caught via Wine testing (see below): `Shell_NotifyIcon` fell back to a degraded
  compatibility path (`Invalid cbSize ... using only Win95 fields`) instead of failing
  loudly, which is exactly the kind of silent-degradation risk to watch for with any
  future NOTIFYICONDATA changes - always let `Marshal.SizeOf` land on a real revision
  size, don't grow a struct incrementally without checking.
- **Verifying this under Wine needs a real display**, unlike the rest of the app - a
  tray icon is a GUI feature, so `wine Slopterm.Server.exe` needs `DISPLAY` pointing at
  a running X server (`Xvfb :99 -screen 0 1024x768x24 &`, then `DISPLAY=:99 wine ...`).
  Add `WINEDEBUG=+systray` to confirm the icon actually registered and painted
  (`add_icon`, `systray_add_icon added N icons`, `painting rect ...` in the trace) -
  don't rely on "it didn't crash" alone, since the hidden owner window itself is never
  visible even on real Windows (that's the point of `HWND_MESSAGE`).
- Not yet done: no tray/menu-bar equivalent on Linux/macOS (console output there is
  unchanged - see issue #17 for why Linux tray support is real, fragmented, best-effort
  work, not a quick follow-up), and simulating an actual mouse click on the icon wasn't
  verified in CI/this sandbox (no desktop panel/taskbar available to click) - the
  message-handling code follows the standard, well-documented Win32 tray pattern
  (`WM_LBUTTONUP`/`WM_RBUTTONUP` forwarded through the callback message), but hasn't been
  click-tested end-to-end on real hardware.

## Mobile packaging (Android APK) — future consideration

- **Do not pursue a pure browser-sandboxed WASM build for Android.** Compiling the C#
  backend to WebAssembly and running it inside a WebView/browser JS engine sounds
  appealing ("wasm runs everywhere"), but browser-sandboxed WASM has no raw TCP socket
  access — it can only speak HTTP/WebSocket. SSH.NET fundamentally needs a real TCP
  socket to the target host, so this route would require a separate always-on relay/proxy
  doing the actual SSH connection, which breaks the local-only, zero-knowledge design and
  reintroduces a hosted-service dependency we've deliberately avoided everywhere else.
- Two real (non-WASM) options exist once raw sockets are required; the choice is a
  genuine engineering trade-off, not a default, and should be made deliberately when
  Android work actually starts:

  **Option A — .NET for Android (MAUI) hosting the same Kestrel+SSH.NET backend
  natively**, with an in-app `WebView` pointed at it instead of the desktop model of
  opening the user's own external browser.
  - *Pro:* reuses the existing backend and the React/Tailwind/xterm.js front-end
    completely unchanged — one business-logic codebase (SSH, SFTP, vault, sync) shared
    across desktop and Android.
  - *Con:* bundles the Mono/.NET Android runtime into the APK (noticeably bigger app),
    and Android-native concerns (foreground-service lifecycle, Doze/battery-optimization
    exemptions, hardware-backed Keystore, biometric unlock) go through MAUI's bindings
    rather than the platform APIs directly.

  **Option B — a native Android app (Kotlin) that re-implements just the backend**:
  an SSH/SFTP client (e.g. `sshj`, since JSch is unmaintained) plus a small embedded
  HTTP/WebSocket server (Ktor or NanoHTTPD) driving a `WebView` — still reusing the
  React/Tailwind/xterm.js front-end unchanged, since that talks a plain HTTP/WS
  protocol either backend can implement.
  - *Pro:* smaller APK, idiomatic Android platform integration (foreground services,
    Doze exemptions, hardware-backed Keystore, `BiometricPrompt`) without a
    cross-platform framework in the way.
  - *Con, and this is the deciding risk:* the SSH/vault/sync **business logic gets
    forked into a second, independently-maintained implementation**. Every bugfix and
    protocol nuance has to land twice. Worse, the encrypted vault format (AES-GCM +
    Argon2id) must produce byte-compatible ciphertext between the C# and Kotlin
    implementations, or a phone and a laptop literally cannot sync the same vault —
    that cross-implementation compatibility would need explicit shared test vectors
    from day one, not an afterthought.

  Default to **Option A** unless Android-native polish (battery life, app size,
  Keystore-backed key storage) proves to matter enough to justify maintaining two
  backend implementations in lockstep.

- **Decision (2026-07-21): go with Option A, conditional on APK size.** Estimate (not yet
  measured — no Android build exists) for a trimmed, R8-enabled release build shipped as
  a per-ABI **Android App Bundle** (never a fat universal APK bundling all four ABIs):
  roughly **15–35 MB installed for the `arm64-v8a` slice**. A fat untrimmed universal APK
  would instead run **60–90 MB+** — do not ship that shape.
  - **Size budget / go-no-go checkpoint:** once the first Android prototype exists, measure
    the actual installed size of the `arm64-v8a` AAB slice. If it stays under roughly
    **40 MB**, Option A stands. If it lands meaningfully above that (say 60MB+) even after
    trimming/R8/single-ABI splitting, treat that as the trigger to revisit Option B
    (native Kotlin backend) rather than accepting the bloat — don't just wave it through
    because the code is already written.
  - Concretely: publish Android as an AAB (not a universal APK), enable R8/resource
    shrinking and .NET trimming (re-testing reflection-dependent paths per the Native AOT
    note above), and target `arm64-v8a` as the primary/first-supported ABI.
- Treat Android as a later milestone (after desktop M0–M5), not something to design the
  desktop backend around now — but keep this constraint in mind either way: don't take a
  dependency on anything (reflection-heavy patterns are fine, WASI/browser-API-only
  assumptions are not) that would foreclose either Android route later.

## Security

- Backend HTTP/WebSocket port: loopback-only by default, a per-launch auth token embedded
  in the printed URL, and `Origin`/`Host` header validation on every request/upgrade to
  block DNS-rebinding and CSRF from other local browser tabs/pages.
- Never log or persist decrypted vault contents (PATs, private keys, passwords) anywhere
  outside the encrypted vault file.

## Testing

- **Whenever backend (`server/`) code changes, build the win-x64 self-contained exe and
  run it under Wine** (`apt-get install wine`, then `dotnet publish -c Release -r win-x64`
  and `wine Slopterm.Server.exe`) — don't assume a Linux-only build/run is sufficient.
  This isn't a formality: it's how we caught a real bug (SSH.NET's default key exchange
  algorithms include Curve25519/X25519-based methods that virtually every modern OpenSSH
  server prefers, but .NET's Windows CNG support for that curve is inconsistent across
  Windows versions and throws instead of falling back — see `TerminalSession.cs`). That
  failure mode is invisible on Linux, where .NET's OpenSSL-backed crypto handles it fine,
  so a Linux-only test pass would have shipped a build that fails to connect to almost
  any real-world SSH server from Windows. Connect it to a real target (the disposable
  `openssh-server` Docker container used in `e2e/` works well for this) rather than just
  checking that the process boots.
- **Known Wine-only gap - don't over-fix based on it:** Wine's own `bcrypt`/CNG emulation
  fails to generate ECDH keys at all (`CngKey.Create` throws `0x80090029`), for the
  standard NIST curves (`ecdh-sha2-nistp256/384/521`) just as much as Curve25519 - unlike
  real Windows, which has always had solid native ECDH nistp256/384/521 support (it's used
  everywhere: TLS, RDP, etc.). If a connection fails under Wine specifically on ECDH,
  that's Wine's test environment, not a reason to also strip the NIST curves from
  `TerminalSession.cs` - doing so would degrade real Windows users to work around a
  limitation only the test harness has. To fully exercise the connect+shell+WebSocket
  pipeline under Wine despite this gap, point it at a target offering only classical
  Diffie-Hellman (`KexAlgorithms diffie-hellman-group14-sha256` in a throwaway `sshd`
  config) - if a modern target server doesn't offer that, verifying the ECDH path itself
  currently requires real Windows.

## Workflow

- Base branch: `main`.
- Land all changes via pull request against `main` — no direct pushes once history exists.
