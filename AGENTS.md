# Agent instructions — slopterm

**slopterm** is a cross-platform SSH/FTP terminal client (Termius-inspired). Frontend: React + TypeScript + Tailwind + xterm.js. Backend: .NET 10 + SSH.NET + ASP.NET Core Kestrel, loopback-only HTTP server.

## Architecture constraints

- **Frontend**: Mobile-first responsive design. Sidebar always visible (Hosts, Keychain, Port Forwarding, Folder Sync, Scheduled Jobs, Snippets, Logs, Appearance, Settings). Host cards with SSH/SFTP/Edit buttons. Multi-session tabs with reconnect on restart.
- **Backend**: Serve built React bundle + WebSocket PTY via Kestrel. Never bind `0.0.0.0` without opt-in.
- **Vault**: Per-item AES-GCM + Argon2id encryption. Optional master password (auto-unlock with fixed seed when disabled).
- **No bundled browser**: Photino for native window (WebView2/WebKitGTK/WKWebView), fallback to external browser.

## Distribution

- Self-contained single-file per RID: `win-x64`, `linux-x64`, `osx-x64`, `osx-arm64`, Android APK (AAB).
- Embedded React bundle in assembly (`EmbeddedResource`).
- `.github/workflows/release.yml` builds all on push to `main`; `versioned-release.yml` for numbered releases.
- **Never enable `PublishTrimmed` or NativeAOT** — breaks SSH.NET reflection.

## Testing

- **Mandatory**: Build `win-x64` and run under Wine against a real SSH server. Wine's CNG has no working ECDH (X25519 *or* NIST curves), so `SshConnectionInfoFactory` detects Wine (the `wine_get_version` ntdll export) and negotiates classical Diffie-Hellman instead, which SSH.NET does in managed code. This means the Wine build connects to any default-config OpenSSH server, but *not* to one hardened to ECC-only key exchange - that's a limit of Wine's crypto, not the client.
- Test all OS targets before committing.

## Security

- Loopback-only by default. Per-launch auth token + Origin/Host header validation.
- **Never log or persist decrypted vault contents** (PATs, private keys, passwords).

## Android

- Option A: .NET for Android head + same backend + WebView. APK size checkpoint: <40MB installed for `arm64-v8a`.
- No WASM build — requires raw TCP sockets.

## Workflow

- Base branch: `main`. Land all changes via PR — no direct pushes.
- **NEVER push to any remote unless explicitly asked.**
- **NEVER use a `Co-Authored-By` trailer in git commits.**
- **Always test EVERYTHING before committing: full build for all OS targets (`win-x64`, `linux-x64`, `osx-x64`, `osx-arm64`, Android APK).**
