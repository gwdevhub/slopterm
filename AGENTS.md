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
- **App shell (implemented, `web/src/App.tsx` + `Sidebar`/`HostGrid`/`HostModal`/
  `HostsSection`/`SectionContent`):** the Termius-reference layout (issues #8/#10), now
  restructured so the sidebar is always visible instead of living inside a "new
  connection" view. `Sidebar.tsx` renders Hosts/Keychain/Snippets/Port Forwarding/Logs/
  Settings, all functional - there is no "Quick Connect" nav item (ad hoc connecting is a
  modal triggered from the Hosts screen instead, see below). Port Forwarding was re-added
  as a real feature (nav entry + icon + `SectionContent` case + a working
  `ForwardingService` backend - see the Port Forwarding section below), the way the "add
  it back properly, not a placeholder" rule required. Known Hosts is still removed outright
  (not hidden) rather than kept as a "coming soon" placeholder - it has no implementation
  and no near-term plan; add it back the same properly-built way if that changes. On
  desktop/tablet it's a
  persistent left column with a collapse toggle at its
  top (fixed-height header row, deliberately the same height as `TabBar`'s row so the two
  align as one continuous toolbar) that shrinks it to icons-only - collapsed state is
  plain component state, not persisted, so it always starts expanded (this also keeps
  every e2e test's exact-match nav-label lookups working unchanged). Below `sm` width the
  desktop column is replaced outright (not just reflowed) by a slim top bar with only a
  menu button; tapping it opens a full-screen overlay listing every section with its full
  label, and selecting one both navigates and closes the overlay. Both variants are always
  in the DOM (Tailwind's `hidden`/`sm:hidden` toggle which is visible via CSS media
  queries) but that's safe for Playwright's `getByRole` lookups because a `display:none`
  subtree is excluded from the accessibility tree entirely - the two copies never appear
  as an ambiguous double-match at any one viewport width.

  `App.tsx` owns the sidebar's active section, the collapsed flag, and the open tabs -
  clicking any sidebar item sets `activeTabId` to `null` so the section shows even while
  tabs stay open in the background (see multi-session tabs below); it does not close any
  tab. `HostsSection` shows a searchable host card grid, full width - there is no more
  right-hand Host Details side panel. It was wasted space for the common case (most
  visits are "dive into a host via SSH/SFTP", not "browse its details"), and is gone in
  favor of: a "Quick connect" button next to "New host" that opens `QuickConnectModal`
  (a `ConnectionForm` for an ad hoc connection that isn't saved to the vault), a "Recent"
  card grid snapped to the *bottom* of the screen (`RecentConnections.tsx`, below the
  saved-host grid), and a small pencil icon in each card's bottom-right corner (alongside
  its SSH/SFTP buttons) opening `HostModal.tsx` - the same `ConnectionForm` used for
  "New host", pre-filled, plus Duplicate/Cancel/Delete buttons for an existing host
  (Delete goes through the shared `ConfirmDialog`, same as tab-close). A host's own
  right-click context menu (`ContextMenu.tsx`) offers the same Edit action as a second
  entry point. "Duplicate" (issue #54, replacing the abandoned #12/#13 multi-credential/
  shared-Identity approaches - see their closing comments) calls `createHost` with a copy
  of the source host's fields (`" (copy)"` appended to the name so it's obviously the
  duplicate in the grid) and re-opens the same modal for the new copy so its
  address/username are right there to adjust, rather than leaving the user to find the
  copy themselves. Both the saved-host grid and Recent share one presentational
  `HostCard` component so a Recent entry looks and behaves exactly like a saved host's
  card, not a lesser/different-looking feature - `selected`/`onSelect` on it are now only
  meaningful to callers that still want a local visual highlight (`RecentConnections`
  tracks its own selected id; the main Hosts grid has nothing to select *into* anymore,
  so it doesn't pass either). Each card has two connect buttons on its right edge - "SSH"
  (`onSsh`, opens a terminal tab) and "SFTP" (`onSftp`, opens a dual-pane file browser
  tab, see below) - both resolve to a `ConnectRequest` via `lib/hosts.ts`
  (`resolveConnectRequest` for a saved host, `resolveRecentConnectRequest` for a Recent
  entry). The card's own at-a-glance summary (`user@host`, plus `:port` when it's
  non-default so ":22" isn't repeated on every single card, plus "Password"/"Private
  key", plus a small snippets-icon badge if the host has startup snippets attached) is
  derived from that same resolved credential, so what's shown always matches what the
  SSH/SFTP buttons would actually use rather than being computed separately and risking
  drifting out of sync. Double-clicking the card itself (not the SSH/SFTP/edit buttons)
  is a shortcut for the SSH button. Mobile collapse for the grid itself (issue #11's
  baseline, not a full separate spec pass): it drops to one column; there's no details
  panel to worry about stacking anymore.

  Multi-session tabs (issue #9, implemented) let more than one connection stay open at
  once - see `TabBar.tsx`/`App.tsx`. Every open tab's view (`TerminalView` for `kind:
  'ssh'`, `SftpView` for `kind: 'sftp'`) stays mounted (just CSS `hidden`) even while
  inactive, so switching tabs doesn't tear down its WebSocket/SFTP connection - proved via
  an e2e test that types into two separate live sessions and confirms neither leaks into
  the other. Catch from that testing: switching tabs alone doesn't move keyboard focus
  into the newly-visible terminal (it stays mounted-but-hidden, so nothing else does it) -
  `TerminalView` takes an `isActive` prop and re-`focus()`s itself when it becomes the
  active tab (`SftpView` has no such focus concern, so it doesn't take that prop). Ctrl+C
  is overloaded like every other terminal: with a selection active it copies to the
  clipboard and clears the selection instead of sending an interrupt; with nothing
  selected it sends the real interrupt signal as usual; Ctrl+Shift+C always copies without
  touching the selection. Implemented via `Terminal.attachCustomKeyEventHandler` in
  `TerminalView.tsx`, which runs before xterm's own key handling - returning `false`
  suppresses xterm's default handling entirely (used for both copy cases), returning
  `true` lets the keydown fall through to xterm as normal (which is what actually emits
  the `\x03` interrupt byte). Each tab shows a small icon differentiating SSH from SFTP
  (`TerminalTabIcon`/`SftpTabIcon` in `icons.tsx`) since both kinds can be open side by
  side now. There is no "new tab"/"+" button in `TabBar` anymore - new sessions only
  start from a host card's SSH/SFTP buttons, never from the tab bar itself. Clicking a
  *connected* tab's close button doesn't close it immediately - it opens `ConfirmDialog.tsx`
  (a small shared modal, not the browser's own `window.confirm()`) with Enter confirming
  and Escape cancelling regardless of which element has focus; `App.tsx` only actually
  disconnects and removes the tab once that's confirmed. The same component backs
  Settings' vault reset/import confirmations (see the Vault section) - one place for
  every "are you sure?" moment in the app instead of each caller rolling its own. A tab
  that's still reconnecting (see below) skips this confirmation entirely and closes at
  once - there's no live session yet to accidentally lose.
- **Restoring tabs across restarts (`App.tsx`, `ReconnectingPane.tsx`, backend
  `OpenTabsRecord`):** every open tab now carries its own `ConnectRequest` (`SessionTab.request`
  in `TabBar.tsx`), and `App.tsx` snapshots the whole tab list - kind, label, host/port/
  username, and the credential actually used, plus which tab was active - to a single
  vault-encrypted `secrets/open-tabs.json` record on every add/remove/reconnect (rewritten
  wholesale, not upserted piecemeal, since there's no stable per-tab identity across a
  restart). On startup `App.tsx` fetches that snapshot once and recreates each tab
  immediately in a `'connecting'` state (rendering `ReconnectingPane` instead of
  `TerminalView`/`SftpView` until it resolves), then calls the same `connect`/`sftpConnect`
  each tab would use normally. A tab's `id` had to stop being the backend session id at
  this point - a reconnecting tab has no session yet - so it's now a client-generated
  `crypto.randomUUID()` that's stable for the tab's whole lifetime, with `sessionId`
  tracked as its own nullable field instead. Retries are indefinite with capped
  exponential backoff (2s up to 30s) rather than giving up after N attempts - the whole
  point is unattended recovery (e.g. the target host still booting after a reboot) - and
  a "Retry now" button in `ReconnectingPane` lets the user skip the wait. If a tab is
  closed/cancelled while a connect attempt is still in flight and that attempt then
  succeeds anyway, `App.tsx` disconnects the now-orphaned session immediately rather than
  leaving it dangling server-side with no tab pointing at it. Same best-effort posture as
  Recent connections: `VaultService.GetOpenTabs`/`SaveOpenTabs` silently return
  empty/no-op if the vault is locked, so a locked vault just means nothing restores, not
  an error at startup.
- **Debounced terminal resize (`TerminalView.tsx`):** the `ResizeObserver` driving
  `fitAddon.fit()` used to call it straight from the observer callback, on every single
  notification. A real drag-resize fires roughly one notification per animation frame -
  confirmed by instrumenting it directly (~30 notifications over half a second of
  dragging) - and `fit()` calling `term.resize()` does a full renderer clear-and-redraw
  every time the computed cols/rows actually change, which xterm does via rewriting
  `.xterm-screen`'s inline `style` attribute. Measuring that directly (a
  `MutationObserver` on `.xterm-screen`'s `style` attribute) showed 17 real redraws for
  one such burst - that pileup, not any single miscalculation, is what read as "flickers
  as it constantly resizes up and down." Fixed by debouncing: the observer now just
  restarts a 75ms timer on every notification and only calls `fit()` once activity
  settles, cutting that same burst down to exactly one redraw (verified the same way,
  see `e2e/tests/terminal-resize.spec.ts`). The initial `fitAddon.fit()` call right after
  `term.open()` stays synchronous/undebounced - only resize-triggered fits are delayed.
  The container div also got `overflow-hidden` added defensively, so its own box can
  never be nudged by xterm's rendered content (e.g. sub-pixel cell-size rounding) - it
  must stay purely parent-driven, since `fit()` computes rows/cols *from* this element's
  size in the first place.
- **SFTP dual-pane browser (`SftpView.tsx`/`FilePane.tsx`, backend `SftpSession.cs`/
  `LocalFileSystem.cs`):** opened by a host card's "SFTP" button - local filesystem (the
  machine running slopterm) on the left, the connected host's remote filesystem on the
  right, sharing one `FilePane` component since the backend normalizes both sides to the
  same `FsListing { path, parent, entries }` shape (`SftpSession.ListDirectory`'s POSIX
  parent computation and `LocalFileSystem.ListDirectory`'s `DirectoryInfo.Parent` both
  produce it) - the frontend never needs to know or care which OS a path came from.
  `SftpSession` reuses `SshConnectionInfoFactory` (factored out of `TerminalSession` for
  exactly this) so the Windows X25519 key-exchange workaround and the 10s connect timeout
  apply identically to both interactive shells and file transfers, instead of drifting if
  copy-pasted. The local-listing endpoint (`GET /api/local/list`) is gated the same way
  every other API path is (loopback + launch-token/cookie, see Program.cs's middleware) -
  it's full local filesystem access over HTTP, but that's consistent with the app's
  existing trust model (it already lets you open an SSH session out from this same
  machine).
  - **Drag-and-drop transfer:** dragging a file from one pane onto the other
    uploads/downloads it into whichever directory that pane currently shows -
    `FilePane` makes files (not directories - recursive transfer isn't supported yet, so
    directory entries are simply never made `draggable`) draggable via the HTML5 DnD API,
    encoding `{ side, path }` as JSON under a custom `application/x-slopterm-file`
    MIME type; `SftpView` is the drop handler (the one place that legitimately needs to
    know about both panes at once) and calls `SftpSession.UploadFileAsync`/
    `DownloadFileAsync` (`SftpClient.UploadFileAsync`/`DownloadFileAsync` under the hood),
    then bumps a `reloadToken` prop on the destination pane to force it to re-fetch its
    *current* directory (its `path` state doesn't change, so that alone can't be a
    `useEffect` dependency). Verified directly against a real SSH/SFTP server: dragged a
    real file each direction, confirmed the transferred file's content matched byte-for-
    byte on both sides, not just that a same-named entry appeared in the listing.
- **Backend:** .NET 10 with C# 14 + SSH.NET (`Renci.SshNet`) — owns all SSH/SFTP/port-forwarding I/O,
  serves the built React bundle plus a WebSocket PTY stream over a local ASP.NET Core
  (Kestrel) HTTP server.
- **No bundled *browser*.** The backend binds `127.0.0.1` and is always reachable from
  any browser on the same machine (or network, for mobile access) - the code-server/
  Jupyter model. Never bind `0.0.0.0` without an explicit, user-supplied opt-in flag for
  remote access. The desktop tray icon now owns a real native window via Photino (see
  "Native app window" below) instead of launching an external browser process, but that
  window is a thin wrapper around the *OS's own* webview (WebView2/WebKitGTK/WKWebView),
  not a bundled browser engine - no Chromium/Blink/Gecko ships inside the exe.
- **Fixed port with random fallback (`Program.cs`, `PreferredPort = 51823`).** Used to be
  an OS-assigned random port every launch, but that broke installed-PWA shortcuts: a PWA
  is installed against a specific origin (port included), so a random port made any
  installed icon go stale the moment the app restarted. Probes the fixed port with a
  throwaway `TcpListener` before Kestrel binds (small TOCTOU window, acceptable for a
  single-user local app) and falls back to port 0 if it's occupied. Not a security
  regression - the actual auth boundary is the per-launch token below, not port secrecy.
- **PWA-installable (`web/public/manifest.webmanifest`, `sw.js`, `icon-*.png`).** The
  service worker deliberately does zero caching (pure network passthrough) - this is a
  live SSH/vault client, nothing here should ever serve stale content from a cache.
  `manifest.webmanifest`/`sw.js`/`icon-*.png`/`favicon.svg` are exempted from the
  token/cookie auth gate in `Program.cs` (`publicPaths`) since none of them are sensitive
  and a browser's install-evaluation fetches aren't guaranteed to carry credentials the
  same way an authenticated page's own fetches do. Verified installability isn't just
  inferred from "manifest + service worker exist" - confirmed via Chromium's own
  `Page.getInstallabilityErrors` CDP call in `e2e/tests/pwa.spec.ts` (returns `[]`).
- **Consistent iconography (`web/src/components/icons.tsx`):** every in-app icon (nav
  rail, host cards, tab/panel close buttons, add buttons) used to be a raw emoji glyph
  embedded directly in JSX - inconsistent rendering across OSes/browsers, and never
  actually matched the surrounding text color. Replaced with one hand-authored outline
  icon family (24x24 viewBox, `stroke="currentColor"`, no fill) so every icon inherits
  whatever color/size its container already uses (`className="h-5 w-5"` etc.) instead of
  relying on emoji-font rendering. The app's own brand mark - the purple/blue
  lightning-bolt (`web/public/favicon.svg`, the PWA icon PNGs, `server/Native/app.ico`,
  and `server/Native/app.png`) - is rendered consistently everywhere it appears: browser
  tab/PWA icon, the Windows tray icon, the Photino window icon (Linux/macOS), and the
  win-x64 published .exe's own Win32 icon (`<ApplicationIcon>` in
  `Slopterm.Server.csproj`, same `app.ico` file, distinct from its use as an embedded
  runtime resource). An earlier pass briefly replaced the bolt with a flat
  dark-navy-background + indigo terminal-prompt (`>_`) mark across all of these, but that
  was reverted back to the original bolt design. `server/Native/app.ico` (16/32/48/256px
  PNG-compressed frames, rendered from `favicon.svg` via a headless Chromium screenshot
  since no local SVG rasterizer/ImageMagick is available) is embedded the same way
  `wwwroot/**` is, and `WindowsTrayIcon.cs`'s `LoadAppIcon()` copies it to a temp file
  once and loads it via `LoadImage(..., LR_LOADFROMFILE)` - deliberately not
  `System.Drawing.Common` (a real, non-trivial dependency) or hand-parsing the .ico's
  resource-directory format via `LookupIconIdFromDirectoryEx` (fragile, and that API
  actually expects RT_GROUP_ICON layout, not a plain .ico file's own directory structure)
  - falls back to the stock `IDI_APPLICATION` icon if the embedded resource is somehow
  missing, so a broken icon asset can never prevent the tray icon itself from showing.
  Verified under Wine: the temp `.ico` file is written with the exact byte-for-byte size
  of the embedded resource, and `Shell_NotifyIcon`/`systray_add_icon` trace shows it
  registering and painting with no fallback triggered.
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
  - `VaultService`'s host CRUD was generalized into a generic `ListRecords<T>`/
    `SaveRecord<T>`/`DeleteRecord<T>`(subfolder) pair once Snippets and Logs needed the
    identical per-record-file pattern - not before, per the "three similar lines beats a
    premature abstraction" rule; three *full* CRUD implementations was worth collapsing.
  - **Snippets** (`SnippetsSection.tsx`, `snippets/{id}.json`): saved reusable commands,
    copy-to-clipboard rather than sent directly into a terminal - a sidebar section and an
    active session tab are still mutually exclusive in the main content area (`App.tsx`
    only renders `SectionContent` when `activeTabId` is null), so there's no terminal
    visible to inject into while this section is showing. Direct injection is a natural
    follow-up if the section content and an open session ever coexist on screen. Editable,
    not just create/delete - clicking a list item's "Edit" pre-fills the same Name/Command
    form the "Add a snippet" flow already uses (an `editingId` flips its submit between
    `createSnippet`/`updateSnippet` and its label between "Save snippet"/"Save changes",
    plus a Cancel button to discard); `PUT /api/vault/snippets/{id}` already existed on the
    backend (the same generic per-record-file CRUD every vault list uses) but had no
    frontend caller at all until this, so there was genuinely no way to fix a typo without
    deleting and re-creating the whole entry.
  - **Startup snippets per host** (`HostRecord.StartupSnippetIds`, `ConnectionForm.tsx`'s
    checklist, used by both `HostModal`'s new-host and edit-host modes): a saved host can
    have one or more Snippets attached, sent to the shell in order right after that host's
    SSH tab connects (`TerminalView.tsx`, on the WebSocket's `open` event) - the intended
    use is env vars/setup commands you'd otherwise type by hand every time. Only ids, not
    a snapshot of the command text, are stored on the host - `lib/hosts.ts`'s
    `resolveStartupCommands` looks the current command text up fresh from the live
    Snippets list at connect time (an id whose snippet was deleted is silently skipped),
    so editing a snippet later is reflected on the *next* connect without needing to
    re-attach it. The resolved command *text* (not ids) is what actually travels with the
    tab from there on - `SessionTab.startupCommands`, and `OpenTabRecord.StartupCommands`
    for a restored/reconnected tab - matching how `RecentConnectionRecord`/`OpenTabRecord`
    already snapshot a credential rather than re-resolving a live reference on every
    reconnect. A 300ms guard delay before the first command (and between each one) lets
    the shell's own banner/prompt print first, rather than racing it. Editing an
    already-saved host's attachments (or its Group, credential, anything) all goes
    through the one `HostModal` edit flow now (`ConnectionForm`'s checklist, toggled then
    explicitly saved via "Save changes" - not an auto-save-on-toggle side effect the way
    an earlier pass briefly had it) - `hostToFormValues`/`formValuesToHost` round-trip
    `startupSnippetIds` so re-saving a host preserves its snippet attachments rather than
    clearing them.
  - **Logs** (`LogsSection.tsx`, `logs/{id}.json`): an append-only record of connection
    attempts (`connected`/`connect_failed`/`disconnected`), written by `Program.cs`
    whenever `/api/ssh/connect` succeeds/fails and whenever a session is actually removed
    (guarded by `SessionStore.Remove`'s return value so a natural WS-close racing an
    explicit disconnect call logs exactly once, not twice). **Best-effort by design**:
    `VaultService.AppendLog` silently no-ops if the vault is locked - there's currently no
    UI path that locks it mid-session (see the re-key section below), so this mostly
    guards a future manual "Lock" action rather than anything reachable today.
  - **Recent connections (`RecentConnections.tsx`, bottom of the Hosts screen, below the
    saved-host grid):** backed by its own vault-encrypted record type,
    `RecentConnectionRecord` (`recent-connections/` subfolder, same envelope shape as
    hosts/snippets/keychain/logs), not derived from the plaintext connection log the way
    it originally was. Unlike `LogEntryRecord` (host/port/username only, deliberately never
    a credential), this one *does* retain the credential that was used, so reconnecting
    from Recent is one click/double-click away instead of retyping a password/key every
    time - that gap in the original log-derived design was the whole reason this became a
    separate store. Only ad hoc connects populate it: submitting `QuickConnectModal`, or
    reconnecting via an existing Recent card - connecting through an already-saved Host's
    SSH/SFTP buttons does not, since that credential already lives permanently in
    `HostRecord` and doesn't need a second copy here. `HostsSection.rememberRecent` only
    calls `upsertRecentConnection` once `onConnect`/`onConnectSftp` actually resolves
    `true` (see `App.tsx`'s `handleConnect`/`handleConnectSftp` return values) - a mistyped
    password must never get remembered as if it were good. `VaultService.UpsertRecentConnection`
    dedupes by host:port:username (case-insensitive), refreshing the existing entry's
    id/timestamp instead of creating a duplicate, and trims down to 5 entries, oldest
    first. Same best-effort posture as the Keychain lookup below: a failed fetch just
    means the Recent list renders nothing, it never blocks the rest of the Hosts screen.
  - **Settings (`SettingsPage.tsx`, gear icon pinned to the bottom of `Sidebar`) - master
    password is optional, and off by default.** A brand-new install never shows an
    unlock/setup prompt at all - `AppSettings.RequireMasterPassword` defaults to `false`,
    so `EnsureUnlockedIfPasswordNotRequired` auto-creates and auto-unlocks the vault on
    first launch. What "optional" actually means cryptographically: when disabled, the
    vault auto-unlocks using a **fixed,
    non-secret** key-derivation input (`VaultCrypto.NoPasswordSeed`, a public constant in
    this open-source code) instead of a real password. The vault is still AES-GCM
    encrypted at rest, so this still protects against casually opening the files in a
    text editor - **it does not protect against anyone who has both the vault files and
    this app**, since they could derive the identical key. The Settings UI states this
    trade-off directly, not just in this doc.
  - Toggling the setting **re-keys the entire vault** (`VaultService.ChangeMasterKey`):
    decrypts every existing record (hosts/snippets/logs/...) with the old key and
    re-encrypts with the new one, records rewritten *before* `vault.json` is updated so a
    crash partway through never leaves records unreadable by either key. Turning
    protection ON requires a new password; turning it OFF requires re-entering the
    *current* password first (checked via a `TryDeriveAndVerify` helper shared with
    `Unlock`), so someone can't disable protection without already knowing the secret
    they're removing.
  - Auto-unlock runs at process startup, and again after `ImportBackup`/`ResetToDefault`
    (both can change whether a password is required out from under the running process,
    unlike a plain toggle which already re-keys in place) - there's still no UI path that
    ever calls the existing `/api/vault/lock` endpoint mid-session otherwise (verified by
    grepping the frontend), so those three call sites are sufficient for every real flow
    today. If a manual "Lock" action is ever added, it would need to also re-trigger
    auto-unlock when appropriate.
  - **Backup export/import (`VaultService.ExportBackup`/`ImportBackup`, Settings'
    "Backup" section):** zips up `vault.json` + `settings.json` + every record file
    exactly as they sit on disk - already-encrypted bytes, so export never needs the
    vault unlocked (zero-knowledge: the backend doesn't need the key either).
    `settings.json` travels with the backup on purpose, so an imported vault's "requires
    a password" state always matches how its records were actually encrypted, instead of
    being silently overridden by whatever the importing machine's own local settings
    said. Import extracts into a temp staging directory and validates every entry
    resolves inside it before touching the real vault directory at all (guards against
    zip-slip path traversal from a corrupt/malicious upload), then atomically swaps it in
    via `Directory.Move`. Forces a lock first (the in-memory key almost certainly doesn't
    match the newly imported vault.json), then immediately re-runs
    `EnsureUnlockedIfPasswordNotRequired` so an imported no-password vault auto-unlocks
    right away rather than sitting locked until the next restart.
  - **Reset to default (`VaultService.ResetToDefault`, Settings' "Danger zone"):** wipes
    the vault directory entirely (every host/snippet/keychain entry/log, plus
    `settings.json`) and re-runs `EnsureUnlockedIfPasswordNotRequired`, landing back in
    the exact state a brand-new install starts in. Deliberately does **not** require the
    vault to already be unlocked - this is the recovery path for someone who's locked
    themselves out of their own master password, so requiring it first would defeat the
    entire point. The frontend's confirmation is `ConfirmDialog.tsx` (see below), not a
    password re-check - matches what was actually asked for (an "are you sure" gate), not
    an additional server-side authorization boundary.
  - Verified the full re-key lifecycle (toggle off, restart, toggle back on with a new
    password, confirm the old one is rejected and data survives throughout) on both Linux
    and win-x64 under Wine per the Testing section's rule - this exercises the same
    already-cross-platform-verified Argon2id/AES-GCM primitives in a new sequence, not a
    new crypto boundary, but re-verified anyway since it's a real change to a core
    security flow.
- **Shared connect/host form (`web/src/components/ConnectionForm.tsx`):** the "new host"/
  "edit host" form (`HostModal.tsx`) and the ad hoc connect form (`QuickConnectModal`,
  triggered by the "Quick connect" button on the Hosts screen) used to be separately
  maintained and drifted - the host form had no private-key option at all. Both now
  render the same `ConnectionForm`, parameterized by
  `includeName`/`submitLabel`/`onSubmit` rather than by a `mode` enum, so the field markup
  (and its ids: `#host`/`#port`/`#username`/`#password`/`#privateKey`/`#passphrase`) is
  identical in both places. `CredentialRecord` gained an optional `Passphrase` field
  (previously only `Secret`) so a saved host's private-key credential can carry a
  passphrase too - a nullable additive field, not a breaking schema change.
  `ConnectionForm` also takes an optional `initialValues` to pre-fill the fields - that's
  what **editing** an existing host uses (`HostModal`, `host` prop set, PUTs to the
  existing `/api/vault/hosts/{id}` endpoint - reachable from a host card's own pencil icon
  or its right-click menu's Edit item). Like the "new host" flow it edits a single
  credential, so a (currently UI-unbuildable) multi-credential host would collapse to one
  on save - consistent with there being no multi-credential editor yet (issue #12,
  closed - see #54's "duplicate a host" instead).
- **Host sharing (`server/Vault/HostShareCodec.cs`, the host card's right-click "Copy"):**
  encodes one host - address, port, credentials and all - into a compact, clipboard-
  friendly token (`slopterm:host:v1:<base64url>`) another slopterm instance imports as a
  new saved host (the "Import" button on the Hosts toolbar → `ImportHostModal` →
  `POST /api/vault/hosts/import-share`). The record is AES-GCM encrypted under a fixed,
  **non-secret** app-wide key (`VaultCrypto.ShareSeed`/`DeriveShareKey`, deliberately public
  exactly like `NoPasswordSeed`): the token is never human-readable plaintext (a password
  won't sit on the clipboard in the clear) but *is* decodable by any slopterm build - that's
  the whole point, so it provides obfuscation/portability, not confidentiality against
  someone who already has this app. The Settings note on `NoPasswordSeed` covers the same
  trade-off. "Copy" writes straight to the clipboard (127.0.0.1 is a secure context, so
  `navigator.clipboard` works) and shows a transient toast; a `ShareTokenModal` is the
  manual-copy fallback only if the clipboard API is blocked. A malformed/foreign token is a
  plain 400 from the import endpoint, not a 500 - it's user-pasted input.
- **Host groups/folders (issue #14, `HostRecord.ParentGroupId`, `GroupCard.tsx`):** a saved
  host can carry a free-text group name (`ConnectionForm`'s "Group" field, shown for
  both the "new host" and "edit host" flows) - a `<datalist>` sourced from other hosts'
  existing group names offers autocomplete so a typo doesn't silently create a
  near-duplicate group. There's no separate `Group` record/CRUD - a group is purely
  "hosts that share the same string in this field," computed client-side (`HostGrid.tsx`)
  rather than a first-class entity with its own lifecycle; deleting/editing every member
  out of a group just makes it stop existing, nothing to clean up. On the top-level grid,
  hosts sharing a group name collapse into a single `GroupCard` (folder icon + name +
  member count) *only once a second host actually joins it* - a lone host with a group
  assigned still renders as its own normal card, since a "folder" of one isn't a useful
  collapse. Clicking a `GroupCard` drills into just that group's members (`HostGrid`'s own
  `expandedGroup` state, with an "All hosts" back link); typing into the search box
  flattens every group back into individual results regardless of expansion state, since
  once the user is actively searching for something specific, requiring them to first
  open the right folder defeats the point.
- **Native-feel chrome (no browser tells):** two deliberate touches so the WebView2 window
  doesn't read as a web page. (1) `web/src/index.css` styles thin, indigo-tinted scrollbars
  app-wide (`::-webkit-scrollbar` + `scrollbar-width/color`) instead of the chunky default
  OS scrollbar - most visible on the tall Settings page; xterm styles its own terminal
  viewport, so this is chrome-only in practice. (2) `App.tsx`'s `useSuppressBrowserContextMenu`
  cancels the browser's default right-click menu everywhere *except* text-entry fields
  (so right-click paste still works for tokens/keys/passwords); our own menus open via
  React `onContextMenu` handlers that run first during bubbling and are unaffected. The
  shared `ContextMenu` component (`web/src/components/ContextMenu.tsx`) is portal-rendered,
  clamped into the viewport, and dismissed by Escape / an outside press / scroll / resize -
  wired to host cards today (Connect/Edit/Copy - Edit opens `HostModal`, same as the
  card's own pencil icon; there's no separate "Show Details" item since that modal
  already shows everything, editable, in one place), reusable elsewhere later.
- **Keychain (implemented, `KeychainSection.tsx`, `keychain/{id}.json`):** saved,
  reusable SSH private keys (`KeychainEntryRecord { Name, PrivateKey, Passphrase? }`),
  following the same generic `VaultService` CRUD pattern as Snippets/Logs. `ConnectionForm`
  offers a private key three ways: paste, browse a local file (via the File API - `<input
  type=file>`, read with `File.text()`), or pick a saved Keychain entry from a dropdown
  (only shown when the vault is unlocked and has entries). Saving a *new* key to the
  Keychain from either form is an explicit opt-in checkbox + name field, never automatic -
  avoids silently proliferating copies of key material without consent. The Keychain
  lookup itself stays best-effort (`.catch(() => [])`) even though every `ConnectionForm`
  instance now lives inside the vault-gated Hosts screen - a locked/momentarily-erroring
  fetch just means the "use a saved key" dropdown doesn't render, it never blocks
  connecting with a pasted/browsed key. No new trust boundary is crossed by reusing a key
  this way - `GET /api/vault/hosts` already returns fully decrypted secrets to the
  authenticated frontend today. Editable, not just create/delete, same as Snippets above -
  the list only ever shows an entry's *name*, but clicking "Edit" safely pre-fills the
  actual private key/passphrase into the form too (not just the name), since
  `listKeychainEntries()` already returns them in full to this same authenticated frontend
  (`ConnectionForm`'s own "use a saved key" dropdown already relied on that); Cancel
  discards without calling `updateKeychainEntry`.
- **Port forwarding (`server/ForwardingService.cs`, `PortForwardingSection.tsx`,
  `port-forwards/{id}.json`):** SSH local/remote forwards tunnelled through a saved host,
  in the shape Termius offers. A `PortForwardRecord` (vault-stored, references a `HostId`)
  is uniform for both directions to match SSH.NET's `ForwardedPortLocal`/`ForwardedPortRemote`
  (bind addr/port → destination addr/port): `local` binds on this machine and the server
  connects out to the destination; `remote` has the server bind and tunnels back to a
  destination on this machine (the xdebug case - server binds 127.0.0.1:9003, forwarded
  back to the local IDE on 127.0.0.1:9003).
  - **`ForwardingService` owns one dedicated background `SshClient` per host** (separate
    from any terminal/SFTP tab, so a forward outlives its tab and can run with no tab at
    all), with every rule on that host a `ForwardedPort` on it. A per-host monitor thread
    reconnects (capped backoff) if the connection drops, so a background forward stays up
    unattended - that's the "keep a background connection" requirement. Everything is
    best-effort: a failed bind/connect surfaces in `GetStatus` (per-rule
    active/connecting/error), never as a throw that could take the app down.
  - **Two automatic triggers, as required:** rules with `AutoStart` come up in the
    background at launch (`StartAutoForwards`, no-op if the vault is still locked - a
    master-password vault starts them on first connect/unlock instead); and connecting a
    terminal/SFTP session to a host brings up all of that host's forwards
    (`StartRulesForHost`, called from the connect endpoints via the new
    `ConnectRequest.HostId`, set by `resolveConnectRequest` for saved hosts only).
    `HostConnect.Resolve` is the server-side mirror of the frontend's `resolveConnectRequest`,
    needed because forwarding builds its own connections (from a host id / at launch) rather
    than being handed a `ConnectRequest`.
  - Endpoints: `/api/vault/port-forwards` CRUD for the rules, plus
    `/api/forwarding/status` and `/api/forwarding/rules/{id}/start|stop` for live control.
    `forwarding.Dispose()` on shutdown tears every background connection down cleanly.
  - **Verified end-to-end against a real sshd** (throwaway `openssh-server` container, with
    `AllowTcpForwarding yes` - the linuxserver image ships it *off*, which is a property of
    the server being tunnelled through, not of this code): a LOCAL forward carried a TCP
    connection through to the container's own sshd (got its SSH banner), and a REMOTE
    forward tunnelled data from inside the container back to a local listener - then again
    through the whole real UI over CDP (create host → add forward in the section → Start →
    goes Active → the tunnel carries traffic).
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
  via `workflow_dispatch`) - that release is the place to grab a bleeding-edge build, not
  a manual local publish.
- **Numbered releases** come from a separate workflow,
  `.github/workflows/versioned-release.yml`, keyed off the `VERSION` file at the repo
  root (currently `linux-x64`/`win-x64` only - add RIDs to its matrix the same way
  `release.yml` covers all four when macOS numbered releases are needed). Bump `VERSION`
  and merge to main to cut the next release (tag `v<version>`, title/notes from the same
  string); a version containing `beta`/`alpha`/`rc` is marked a GitHub pre-release
  automatically. Also runnable via `workflow_dispatch` (e.g. to cut a release from a
  branch before merging, or to re-upload assets for a version whose build needed a fix -
  re-running for an existing tag replaces its assets instead of failing).
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
- **`IncludeAllContentForSelfExtract` is on, and is load-bearing, not cosmetic.** Without
  it, `Process.Start` (used by `UpdateService.ApplyAsync`'s self-update relaunch, see
  below) throws `FileNotFoundException: Could not load file or assembly 'System.IO.Pipes'`
  the very first time it's called from a real published single-file exe - `Process.Start`
  needs that assembly internally on Unix (an internal pipe-based child-exit watcher) even
  when redirecting no streams, but single-file bundling normally only embeds what static
  reachability analysis decides is needed, and nothing in our own code or dependencies
  otherwise references `System.IO.Pipes` - so it's silently dropped even with
  `PublishTrimmed` off. This only shows up at that one call site in a real publish, never
  in `dotnet run`/`dotnet build`, and two more targeted fixes were tried and both failed
  before this one worked: an explicit `_ = typeof(System.IO.Pipes.AnonymousPipeServerStream)`
  reference in code, and `<TrimmerRootAssembly Include="System.IO.Pipes" />` (a
  trimming-specific directive that apparently doesn't influence single-file bundle content
  selection when trimming itself is off). Verified directly against a real published
  build and the real GitHub API/release (see below) before landing on this fix.

## Self-update (`UpdateService.cs`, `LaunchTokenStore.cs`, Settings' "Updates" section)

- Compares the SHA256 of the currently-running single-file executable against the
  matching-OS asset in this repo's rolling `latest` GitHub Release (see `release.yml`
  above), and can download+verify+swap+relaunch in place. The GitHub token is entirely
  optional in the request (only sent as a `Bearer` header when one is configured) so this
  keeps working unauthenticated (subject to GitHub's normal rate limit) whenever the repo
  is public, and Settings still has a field to save one for whenever it isn't (or to raise
  the rate limit) - `gwdevhub/terminal`'s visibility isn't something this code should
  assume is fixed either way. Confirmed directly against the real repo *while it was
  private*: unauthenticated calls to `/releases/tags/latest` 404 (indistinguishable from
  "doesn't exist", which is deliberate GitHub behavior for private repos) - an
  authenticated call works regardless of visibility. The token itself is stored via
  `VaultService.GetGithubToken`/`SetGithubToken`, encrypted like any other secret, under
  `secrets/github-token.json` - unlike `AppSettings`, it doesn't need to be readable
  pre-unlock, so it doesn't need the plaintext `settings.json` treatment.
- GitHub computes and exposes each release asset's `digest` (`sha256:<hex>`) automatically
  on upload, regardless of how it was uploaded (`gh release create`, the web UI, the API
  directly) - confirmed directly against the real repo's actual release assets - so
  checking for an update never needs to download anything just to hash it.
- Downloading a release asset programmatically - and a *private* repo's asset
  specifically - must go through
  `GET /repos/{owner}/{repo}/releases/assets/{id}` with `Accept: application/octet-stream`
  (plus a `Bearer` token when one's configured) - **not** the asset's own
  `browser_download_url`, which redirects to a signed, host-specific URL meant for a
  browser's cookie-authenticated session and
  doesn't accept a bearer token. Confirmed directly (downloaded a real private asset this
  way, verified its SHA256 matched the API's reported digest exactly) before relying on it.
- **Verified the entire real flow end-to-end against the actual repo/API** (not mocked):
  published a real single-file build, ran it standalone, saved a real GitHub token,
  called check (got a real `updateAvailable: true` against the real `latest` release,
  since the running build was newer than what's released), called apply, and confirmed
  the exe was correctly swapped (SHA256 matched the release's digest exactly) and the
  process came back up and served requests again. This surfaced two real bugs beyond the
  single-file/`System.IO.Pipes` one above, both fixed before shipping:
  - **A race between spawning the replacement process and this process's own exit.**
    `Process.Start`ing the new process, then relying on `app.StopAsync()` unblocking
    Program.cs's own `await app.WaitForShutdownAsync()` and letting `Main` fall through
    naturally to exit - loses the race almost every time: the whole process (and the
    background task calling `Process.Start`) can be torn down *before* `Process.Start`
    ever actually runs, silently dropping the respawn with no error anywhere. Fixed by
    calling `Environment.Exit(0)` immediately and explicitly right after `Process.Start`
    returns (which is synchronous - the replacement OS process already exists
    independently by the time it returns), instead of leaving shutdown ordering to chance.
  - **A poller can never observe the "restarting" progress phase.** The install+shutdown
    sequence (swap the exe, stop Kestrel, spawn the replacement, exit) is fast enough that
    a client polling `/api/update/progress` every 500ms can go straight from `"verifying"`
    to the connection being refused, never seeing `"installing"`/`"restarting"` at all -
    confirmed directly, not theoretical. `UpdateProgressDialog` (`UpdateSection.tsx`)
    treats reaching `"verifying"` (not `"restarting"` specifically) as the threshold past
    which a dropped connection means "the app is restarting," not a failure; the backend
    also adds a short `Task.Delay(500)` before actually stopping, as cheap defense in depth
    on top of that, not a substitute for it.
  - **The relaunch re-read `Environment.ProcessPath` after the swap instead of before it,
    silently relaunching the backed-up old binary.** `ApplyAsync` renames the running exe
    out from under itself (old -> `.old`, new binary into the vacated path) before
    returning; `Environment.ProcessPath` is backed by `/proc/self/exe` on Linux, which
    follows that rename for the rest of the process's life rather than picking up whatever
    new file later occupies the original path - confirmed directly (renamed a running
    process's own exe file, then placed a new file at the original path; `/proc/<pid>/exe`
    kept reporting the renamed-away path). Fixed by capturing `Environment.ProcessPath`
    into a local *before* calling `ApplyAsync`, and relaunching with that captured value
    instead of a fresh property read. Re-verified end-to-end against the real repo/API
    with this fix in place: the swap still checks out (SHA256 matches the release digest),
    and the replacement process is launched with the correct, post-swap path.
- **The per-launch auth token is now persisted** (`LaunchTokenStore.cs`, `launch-token.txt`
  next to `window.json` - same plaintext, per-install, not-part-of-a-vault-backup
  treatment), reused across restarts instead of regenerated every launch. Needed
  specifically so a browser tab left open across a self-update-triggered restart keeps
  working with its existing cookie instead of getting a 401 from the new process (which
  would otherwise mint a brand new random token) - verified directly (two independent
  launches of the same build, same vault dir, confirmed identical token both times).
- The Sidebar's Settings icon shows a small dot (not a number/toast - deliberately minimal
  per the original ask) when a startup check finds an update available
  (`App.tsx`'s `useUpdateAvailable`, checked once, not polled) - the actual check/apply UI
  only lives in Settings itself.
- **One button, not two.** The Updates section always shows a status line (checking/
  error/unsupported/up to date/update available) *and* a single primary button whose
  label and action both track that state: `"Checking…"` (disabled) while a check is in
  flight, `"Update now"` when one's available, `"Check now"` otherwise (including right
  after an error, or in a dev build where re-checking is harmless even if unlikely to
  help) - never two separate buttons for "check" vs. "update," and never just text with
  no way to act on it.
- Browsing/navigating aside, there's deliberately no in-app UI for the numbered/`VERSION`
  release channel - self-update always targets the rolling `latest` release, matching
  what "the latest version of the exe" means throughout this feature.

## System tray (Windows)

- The published Windows build has no console window (`OutputType=WinExe`, gated to
  `RuntimeIdentifier == win-x64` only - plain `dotnet run`/`dotnet build` without `-r`
  stays a normal console app on every OS for local dev). The only UI is a tray icon
  (`Native/WindowsTrayIcon.cs`); left-click/"Open" calls `AppWindowManager.EnsureWindowOpen`
  (see "Native app window" below), right-click shows an Open/Quit menu, "Quit" stops the
  app cleanly.
- **`server/BrowserLauncher.cs` is now the fallback path, not the primary one** (superseded
  by `AppWindowManager` below): if the platform's native webview runtime isn't installed,
  the tray's "Open" action falls back to this - tries Chrome/Edge/Brave's `--app=<url>`
  flag first (a chromeless window using whichever browser is already installed, still no
  bundled browser engine), then the OS default browser (a plain tab) if no such browser is
  found. Detects an installed browser via the `App Paths` registry key
  (`HKLM`/`HKCU\...\CurrentVersion\App Paths\{chrome,msedge,brave}.exe`) - more reliable
  than guessing Program Files locations, which vary by architecture and per-user vs.
  per-machine installs. Verified under Wine (from when this was still the primary path):
  with no Chrome/Edge/Brave installed there, the registry lookup correctly finds nothing
  and falls through to the OS default-browser attempt without crashing the server (Wine's
  own "no suitable app to open this URL" message there is expected, not a regression).
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
- **"Quit" closes everything the app opened, not just itself.** The main Photino window
  needs no special handling for this (it lives on a background thread that dies with the
  process once `app.Lifetime.StopApplication()` unblocks `WaitForShutdownAsync` and
  `Program.cs` falls through) - but a `BrowserLauncher` fallback window (no webview
  runtime installed) is a completely separate OS process that stopping the server alone
  never touches, previously left running and pointed at a now-dead server after Quit.
  `AppWindowManager.CloseAllFallbackBrowserWindows()` (called from the tray's `Quit`
  wrapper in `Program.cs`, alongside `StopApplication`) tracks every such process
  `BrowserLauncher.Launch` returns and tries `CloseMainWindow()` then `Kill()` on each.
  Deliberately does **not** apply to the OS-default-browser fallback (a plain tab in
  whatever general browser session the user already had open) - `Launch` only returns a
  trackable `Process` for the dedicated chromeless `--app=` window case, since force-
  closing a real browser window could take other unrelated tabs down with it. Verified
  under Wine that the app still starts/registers its tray icon/shuts down cleanly with
  this change; the specific "close a tracked fallback window" path itself wasn't
  exercisable there since this sandbox's Wine has no Chrome/Edge/Brave installed to
  trigger that fallback in the first place (falls straight to the untracked
  default-browser case instead, same as documented above).

## Native app window (Photino)

- **`server/Native/AppWindowManager.cs`** enforces "only ever one slopterm window":
  `EnsureWindowOpen(url)` focuses the window that's already open if one exists, or
  creates a fresh one otherwise - never a second one. Backed by
  [Photino.NET](https://www.tryphotino.io/) (`PhotinoWindow`), a thin wrapper around the
  OS's own webview (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS) pointed
  at the same local Kestrel server everything else already talks to - not a bundled
  browser engine. This replaced launching an external browser process
  (`BrowserLauncher.cs`, now the fallback - see the System tray section above) as the
  primary path specifically because that approach never gave the app a real window
  handle: it couldn't reliably tell whether a window was still open (to single-instance
  it) or read back its position (to remember it) - Photino gives both directly.
  - **Custom (chromeless) title bar (`SetChromeless(true)` + `web/src/components/TitleBar.tsx`).**
    The window has no OS caption; the React app draws one integrated top bar instead -
    a hamburger menu on the left (holding the sidebar collapse toggle and Settings, which
    the sidebar drops in desktop mode - `Sidebar`'s `hideChromeControls`) and the
    minimize/maximize/close controls on the right, at the same height. Termius-style, per
    the reference. Three things this needs, each learned the hard way / from Photino's
    constraints:
    - **A chromeless window MUST be given an explicit size and location on Windows** -
      Photino throws `Startup Parameters Are Not Valid ... Size and location must be
      specified` if `UseOsDefaultLocation/Size` is left on (which happens on a first cold
      start with no saved `window.json`). `RunWindow` always sets both now: the saved
      position or a default centered on the primary screen (`GetSystemMetrics`).
    - **Chromeless also drops `WS_THICKFRAME`, so the window can't be edge-resized.**
      `WindowsTaskbarIdentity.EnsureResizableStyle` re-adds `WS_THICKFRAME` +
      `WS_MINIMIZEBOX`/`WS_MAXIMIZEBOX` via `SetWindowLong`/`SetWindowPos(SWP_FRAMECHANGED)`
      on the real top-level frame (found by the same enumeration the taskbar-identity code
      already uses - `PhotinoWindow.WindowHandle` isn't that frame). Verified: the window
      ends up caption-less but resizable, with working maximize/aero-snap.
    - **Dragging the bar to move the window needs a WebView2 feature flag, not just the
      CSS.** `-webkit-app-region: drag` (in `index.css`, with buttons opting out via
      `no-drag`) is *ignored* by WebView2 unless non-client region support is on - and
      Photino exposes no setting for it, so `AppWindowManager` switches it on by appending
      `--enable-features=msWebView2EnableDraggableRegions` to the
      `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var before the webview is created (append,
      not overwrite, so it composes with anything already there). Without this the title bar
      renders and the controls work but the window won't move when dragged - the exact
      symptom that surfaced this. Confirmed the flag reaches WebView2 by inspecting the
      `msedgewebview2` child process command line.
    - **Window controls go over Photino's `window.external` message bridge**
      (`lib/photino.ts`): the title bar posts `wc:min`/`wc:max`/`wc:close`/`wc:ready`, the
      backend's `RegisterWebMessageReceivedHandler` acts on them, and it pushes
      `wc:maximized`/`wc:restored` back so the maximize/restore glyph tracks the real state
      (including changes from Win+Up, snap, etc. via `RegisterMaximizedHandler`/`Restored`).
      `wc:close` runs the exact same `CloseToTray` logic as the native close (Alt+F4 still
      routes through `RegisterWindowClosingHandler`), so the title-bar X quits by default.
      `SavePosition` skips a maximized window so the next cold start doesn't open giant.
    - `TitleBar` only renders inside Photino (`isDesktopApp` = `window.external.sendMessage`
      exists); a plain browser (dev, phone, direct URL) has no title bar and the sidebar
      keeps its own collapse toggle and Settings. Verified end-to-end by driving the real
      chromeless WebView2 window over CDP: hamburger opens collapse/Settings, the sidebar
      no longer carries either, maximize grows the window and restore returns it exactly,
      and the title-bar Close quits the process.
  - **Pin `Photino.NET` to `4.0.16` or later, not `3.2.3`.** `3.2.3`'s Linux native build
    links `libwebkit2gtk-4.0`/`libjavascriptcoregtk-4.0` specifically, which modern
    distros (this repo's own dev sandbox included) no longer ship at all, only the `4.1`
    generation - confirmed directly: `3.2.3` failed to load at all here
    (`DllNotFoundException`), `4.0.16` worked immediately once `libwebkit2gtk-4.1-0` and
    `libnotify4` were installed.
  - **`app.ico` vs `app.png` (`EmbeddedIcon.cs`):** Photino's `SetIconFile` goes through
    GTK's own icon loader on Linux, which rejects `app.ico`'s PNG-compressed frames
    outright (`Compressed icons are not supported`) even though Win32's `LoadImage`
    handles that exact file fine on Windows. `EmbeddedIcon.ExtractToTempFile()` picks the
    right one per OS - `app.ico` on Windows (shared with `WindowsTrayIcon`'s `LoadImage`
    call), a plain `app.png` (same artwork, rendered fresh from `favicon.svg`) everywhere
    else.
  - **The single `PhotinoWindow` instance is created once and never destroyed for the
    rest of the process's lifetime.** This isn't a nicety, it's a hard requirement:
    creating a *second* `PhotinoWindow` after a first one is actually closed/destroyed
    reliably crashes the whole process natively - a silent, unrecoverable death with no
    catchable .NET exception, confirmed by reproducing it directly (the process was
    consistently gone within ~1s of the second window's `Load()` completing, on both
    Linux/WebKitGTK and under Wine). Every close is intercepted via
    `RegisterWindowClosingHandler` returning `true` (cancel the native close) so Photino
    never destroys the window directly - what happens *instead* depends on the
    `CloseToTray` setting (`AppSettings.CloseToTray`, a Settings toggle, off by default). **Default (off): closing quits slopterm outright** - the handler runs the
    same clean `Quit` the tray menu does (`AppWindowManager.Configure` is handed that
    action plus a live predicate reading the setting, so a Settings toggle applies without
    a restart). It still returns `true` rather than letting the window be destroyed here:
    `Quit` stops the process and letting process exit tear the window down is the one
    destruction path proven safe, so the window just lingers for the instant shutdown
    takes (exactly as the tray's own "Quit" already did). **When `CloseToTray` is on:** the
    handler calls `SetMinimized(true)` instead, leaving the app running behind its tray
    icon - reopening later un-minimizes and focuses that same instance rather than ever
    creating a new one. Either way the only time the native window is actually destroyed is
    as a side effect of the whole process exiting, which needs no special handling.
  - **Runs on its own dedicated background thread** (STA on Windows, required for the
    native message loop; a documented no-op elsewhere), the same pattern
    `WindowsTrayIcon` already uses - `PhotinoWindow.WaitForClose()` blocks that thread
    only (and, per the point above, never actually returns in normal operation since
    every close is cancelled), so Kestrel and the tray icon keep running regardless of
    whether the window is currently visible or minimized. A `ManualResetEventSlim` makes
    `EnsureWindowOpen` wait for the new window to actually finish being created (or fail)
    before returning.
  - **A `_creating` flag makes "does a window already exist" and "start creating one"
    atomic under one lock.** Without it, two `EnsureWindowOpen` calls close enough
    together (confirmed this actually happens - the tray icon's left-click can fire
    twice for what looks like one click) could both see no window yet and each try to
    create one, hitting the native crash above. The flag is set before releasing the
    lock and building the `PhotinoWindow`, and cleared once that window is tracked (or
    creation fails), so a second call in that window either focuses the real window
    once it exists or safely no-ops rather than racing a duplicate into existence.
  - **Remembers window position/size, captured once at close-intent time** (inside the
    `WindowClosingHandler`, before minimizing) rather than continuously via
    `LocationChanged`/`SizeChanged` events - persisted to `window.json`
    (`WindowPositionStore.cs`) and applied via `SetLocation`/`SetSize` the next time a
    window is created (from a cold start, since the running-process case now just
    un-minimizes the same window). Continuous tracking was tried first and reverted: many
    windowing APIs (this one included, in practice) fire spurious move/resize events as
    part of minimizing or tearing a window down (classic Win32 reports a minimized window
    "moving" to something like `(-32000,-32000)`), which silently overwrote a perfectly
    good saved position with garbage the instant the window closed - reported directly:
    "the window flashes up with the new size, but incorrect position." `SavePosition`
    also ignores non-positive width/height as a defensive backstop against the same class
    of bogus values. `window.json` isn't encrypted (screen coordinates aren't sensitive)
    and lives alongside `vault.json`/`settings.json` without being vault content -
    naturally excluded from `VaultService.ExportBackup` (a backup shouldn't force one
    machine's window layout onto another's), though `ResetToDefault` does still wipe it
    along with everything else. The frontend's own `App.tsx` position-polling
    (`navigator.sendBeacon` to the same `window.json`, added before Photino existed) is
    left in place as a fallback for the `BrowserLauncher` external-browser case, where the
    app still doesn't own a window handle to hook native events on.
  - **Restoring/focusing the existing window** un-minimizes it first (`SetMinimized(false)`
    if needed), then toggles `SetTopMost(true)`/`SetTopMost(false)` (a cross-platform trick
    that reliably raises a window regardless of window manager), plus
    `SetForegroundWindow` via Photino's exposed `WindowHandle` on Windows specifically for
    a more direct/reliable focus there (allowed without the usual foreground-stealing
    restriction, since this process already owns the window it's asking to be focused).
  - **Runtime triage:** if window creation throws (missing WebView2/WebKitGTK), the
    exception is caught, a friendly message naming the exact missing dependency and an
    install link is printed to console and (on Windows) shown in a native `MessageBox`,
    and it falls back to `BrowserLauncher.Launch` so the user isn't stranded with no way
    to reach the app at all.
  - **Verified end-to-end in this repo's dev sandbox** (Linux, with the runtime installed
    for real) and again under Wine (win-x64 build) per the mandatory testing rule, with
    process liveness explicitly monitored second-by-second through the whole sequence -
    not just "the trace lines appeared," which is what missed the native-crash bug the
    first time around: firing two concurrent `EnsureWindowOpen` calls creates exactly one
    window (`_creating` race confirmed closed); moving, resizing, then closing persists
    the exact final position/size to `window.json` and minimizes rather than destroying
    the window; reopening un-minimizes and focuses that same instance (no second `Load`
    call) and the process stays alive indefinitely afterward, on both platforms.
  - Not yet done: no auto-launch on startup (matches the previous browser-launching
    behavior - the app stays silent until the tray icon is clicked, same as before this
    existed) and no equivalent trigger on Linux/macOS yet (no tray/menu-bar icon there -
    see the System tray section's "Not yet done" note); `AppWindowManager` itself is
    written to work on any OS Photino supports, it's just not wired to a UI trigger
    outside Windows yet. In the opt-in `CloseToTray` mode, minimizing instead of closing
    may leave a taskbar entry behind while "closed" on some platforms/window managers,
    unlike apps that fully hide from the taskbar - Photino doesn't expose a hide-not-
    minimize API, and this is a reasonable trade against the alternative (a process crash);
    it doesn't arise in the default close-quits-the-app behavior.

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

## Crash logging (`CrashLogger.cs`)

- Installed as the very first thing `Program.cs` does, before the port probe, vault init,
  or window creation get a chance to throw. Without it, an unhandled exception on the
  published Windows build (no console - see `OutputType=WinExe`, gated to win-x64) just
  closes the process with zero visible trace: no console to print to, nothing on disk,
  nothing on screen - "it flashed and closed" with no way to diagnose it, a real report
  from a user trying the app for the first time.
- Hooks `AppDomain.CurrentDomain.UnhandledException`, which fires for an exception left
  uncaught on *any* thread (the main thread's own top-level statements included) right
  before the runtime tears the process down - one hook covers the whole app rather than
  needing every startup statement wrapped in its own try/catch.
- On every unhandled exception: writes the full exception (message + stack trace) to
  `crash.log` next to the vault (`AppPaths.GetVaultDirectory()`, appended so a run of
  crashes accumulates instead of overwriting), always echoes it to stderr too (visible
  whenever there is a console - plain `dotnet run`/`dotnet build` without `-r` stays a
  normal console app on every OS), and on Windows also shows a native `MessageBox` (same
  `user32.dll` P/Invoke pattern as `AppWindowManager`'s missing-webview-runtime message)
  with the short exception message and the log file's path, so a user hitting this isn't
  just left staring at nothing.
- Doesn't (and can't) catch a genuine native crash with no corresponding .NET exception at
  all (see `AppWindowManager`'s doc comment on the double-`PhotinoWindow` case) - this is
  strictly for .NET-level unhandled exceptions, which cover ordinary startup failures
  (a bad vault file, a permissions error, an unexpected config value) that would otherwise
  be indistinguishable from that native-crash case to an affected user.

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
- **`Dockerfile.wine-test`** packages everything the Wine-testing step above needs (.NET
  SDK, Node, Wine, Xvfb) so it never has to be reinstalled from scratch on a fresh
  machine/sandbox - mount a checkout as a volume and it drops into a shell with Xvfb
  already running and `DISPLAY` set (see README.md's "Testing the Windows build under
  Wine" section for the exact commands). Dev/test tool only, doesn't bake the repo in.

## Workflow

- Base branch: `main`.
- Land all changes via pull request against `main` — no direct pushes once history exists.
