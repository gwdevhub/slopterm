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
- **Vault:** local, per-item records (stable id + `updatedAt`) — not one monolithic blob —
  encrypted with AES-GCM behind a master password (Argon2id KDF). This shape exists so
  records can be merged across devices instead of clobbered.
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
- Do not reach for Native AOT / aggressive trimming by default. SSH.NET and typical
  JSON/DI usage rely on reflection that trimming can silently break, and chasing AOT
  compatibility adds compile-time complexity for a marginal size win. Use a plain
  self-contained (untrimmed) publish until there's a concrete reason to shrink further;
  if trimming is attempted later, explicitly re-test every reflection-touching path (SSH
  auth, SFTP, (de)serialization).
- Keep backend NuGet dependencies minimal — every package is footprint riding along with
  the CLR in a self-contained binary. Justify additions against
  SSH.NET + ASP.NET Core Kestrel + a JSON serializer before adding more.

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

## Workflow

- Base branch: `main`.
- Land all changes via pull request against `main` — no direct pushes once history exists.
