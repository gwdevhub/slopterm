# slopterm

A cross-platform (Linux, macOS, Windows) SSH/FTP terminal client in the spirit of
[Termius](https://termius.com/), built by [gwdevhub](https://github.com/gwdevhub).

- React + xterm.js front-end
- .NET backend (SSH.NET) for SSH/SFTP, served locally — no bundled browser, point your own
  browser at the printed `localhost` URL
- End-to-end encrypted vault with cross-device sync

Status: Windows-first MVP — connect to a host over SSH (password or private key) and get
a single working terminal tab. No saved hosts, vault, or sync yet. See
[AGENTS.md](./AGENTS.md) for architecture and constraints.

## Running it locally

```sh
cd web
npm install
npm run build      # builds the React UI into ../server/wwwroot

cd ../server
dotnet run         # prints a http://127.0.0.1:<port>/?token=... URL - open it in a browser
```

## Building a standalone executable

```sh
cd web && npm install && npm run build   # build the UI first - it gets embedded below
cd ../server
dotnet publish -c Release -r win-x64     # or linux-x64 / osx-x64 / osx-arm64
```

This produces one self-contained file (`bin/Release/net10.0/<rid>/publish/Slopterm.Server[.exe]`)
with the .NET runtime, all dependencies, and the entire React UI embedded inside it — no
`wwwroot` folder, no .NET install, nothing else needed alongside it.

**On Windows, the published exe has no console window** — look for a tray icon instead;
click it (or its right-click menu's "Open") to open the app in its own window (or bring
it back to focus if it's already open), and "Quit" to stop it. Linux/macOS builds still
print the URL to the console for now (see `AGENTS.md`'s System tray section).

**Or just grab a prebuilt one:** every push to `main` automatically builds and publishes
Windows/Linux/macOS executables to the repo's
[Releases page](https://github.com/gwdevhub/terminal/releases/tag/latest) (tag `latest`,
marked as a pre-release since it tracks `main` directly rather than a cut version) — no
local toolchain needed at all. `.github/workflows/release.yml` also has a manual
`workflow_dispatch` trigger if you need to rebuild it on demand.

## Cutting a release

One file drives every release: **`VERSION`** at the repo root. Bump it, merge to `main`, and
`.github/workflows/versioned-release.yml` cuts tag `v<version>`, publishes the desktop binaries
and the Android APK to a GitHub Release, and uploads the Android App Bundle to Google Play.

### The VERSION format is strict

```
MAJOR.MINOR.PATCH[-prerelease]
```

Valid: `0.0.2` · `0.0.2-beta` · `0.0.2-beta.2` · `0.0.2-rc.1`
Invalid: `v0.0.2` (no leading `v`) · `0.2` (all three parts required) · `0.0.2 beta`

A malformed `VERSION` **fails the build** — the release workflow rejects it up front, and the
Android build errors with `SLOP0001`. That's deliberate: it used to fall back to `0.0.0`, which
silently produces a *lower* Android versionCode than the last release and gets rejected by Google
Play with a far less obvious message.

### Why the format matters: Android versionCode

Google Play orders releases by an integer `versionCode`, ignores the human-readable version
entirely, and permanently refuses a `versionCode` it has already seen.
`android/Directory.Build.props` derives one from `VERSION`:

```
versionCode = (MAJOR*10000 + MINOR*100 + PATCH) * 1000 + PRERELEASE

PRERELEASE = 900              final release (no suffix)
           = 100/200/300/400  alpha / beta / rc / anything else
           + the suffix's trailing number, if it has one
```

The prerelease digits exist so a prerelease sorts *below* the final release of the same version.
Without them `0.0.1-beta` and `0.0.1` would both be versionCode `1`, and shipping the final
0.0.1 after its beta would be impossible.

A typical progression:

| `VERSION` | versionCode |
|---|---|
| `0.0.1-beta` | 1200 |
| `0.0.1-beta.2` | 1202 |
| `0.0.1-rc` | 1300 |
| `0.0.1` | 1900 |
| `0.0.2-alpha` | 2100 |
| `0.1.0` | 100900 |
| `1.0.0` | 10000900 |

Always increasing, so any of these can follow any earlier one. **It can never go down** — once a
version is published, no later release may use a lower `VERSION`.

Bounds the digit budget assumes (all enforced, not just documented): MINOR, PATCH and the
prerelease number stay under 100, and MAJOR stays under 210 (Play caps `versionCode` at
2100000000).

Anything containing `alpha`, `beta` or `rc` is also treated as a prerelease by the workflow: the
GitHub Release is marked pre-release, and the Play upload goes to the **internal** testing track
instead of production. See [android/PLAY_RELEASE.md](./android/PLAY_RELEASE.md) for the
Google Play side.

## Testing

`e2e/` has Playwright tests that build the real app, run it, connect it to a disposable
SSH server, and check the terminal actually shows live shell output in a real browser.
See [e2e/README.md](./e2e/README.md). CI (`.github/workflows/ci.yml`) runs the same build
+ e2e suite on Linux for every PR.

### Testing the Windows build under Wine

Whenever `server/` code changes, `AGENTS.md`'s Testing section requires building the
win-x64 exe and actually running it under Wine before considering the change done (a real
bug - inconsistent Windows CNG support for Curve25519 - was only caught this way, invisible
on Linux). `Dockerfile.wine-test` packages everything that step needs (.NET SDK, Node,
Wine, Xvfb for the tray icon's virtual display) so it never has to be reinstalled from
scratch:

```sh
docker build -f Dockerfile.wine-test -t slopterm-wine-test .
docker run --rm -it -v "$(pwd)":/workspace -w /workspace slopterm-wine-test
```

That drops into a shell with Xvfb already running and `DISPLAY` set, ready for:

```sh
cd web && npm ci && npm run build && cd ../server
dotnet publish -c Release -r win-x64
wine bin/Release/net10.0/win-x64/publish/Slopterm.Server.exe
```

Add `WINEDEBUG=+systray` before `wine ...` to confirm the tray icon actually registered
and painted, not just that the process didn't crash (see `AGENTS.md`'s System tray
section). This is a dev/test tool, not a distributable artifact - it doesn't bake the repo
in, your checkout is mounted as a volume instead.
