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

This produces one self-contained file (`bin/Release/net8.0/<rid>/publish/Slopterm.Server[.exe]`)
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
wine bin/Release/net8.0/win-x64/publish/Slopterm.Server.exe
```

Add `WINEDEBUG=+systray` before `wine ...` to confirm the tray icon actually registered
and painted, not just that the process didn't crash (see `AGENTS.md`'s System tray
section). This is a dev/test tool, not a distributable artifact - it doesn't bake the repo
in, your checkout is mounted as a volume instead.
