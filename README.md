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
click it (or its right-click menu's "Open") to open the app in your browser, and "Quit" to
stop it. Linux/macOS builds still print the URL to the console for now (see `AGENTS.md`'s
System tray section).

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

### Testing in Docker

`Dockerfile.test` builds the linux-x64 backend (with the React UI embedded) so anyone can
try the app without installing the .NET SDK or Node locally. **This is for dev/testing
only, not a supported way to run the app for real** — there's no tray icon, no app-mode
browser window (see `server/BrowserLauncher.cs`), and PWA install doesn't apply inside a
container. It's the same HTTP/WebSocket surface the e2e suite already drives headlessly.

```sh
docker build -f Dockerfile.test -t slopterm-test .
docker run --rm --network host slopterm-test   # see note below on --network host
```

The app deliberately binds `127.0.0.1` only (see `AGENTS.md`'s "No bundled browser" note)
— it's never meant to be reachable from anywhere but the same machine. That means normal
`-p 51823:51823` port-publishing won't reach it (Docker forwards published ports to the
container's own network interface, not its loopback), so `--network host` is required to
share the host's loopback directly. `--network host` works as expected on Linux; on Docker
Desktop for Mac/Windows it may not be available the same way, in which case running the
.NET/Node toolchain directly (see above) is the simpler option there.

Once running, grab the printed `http://127.0.0.1:51823/?token=...` URL from `docker logs`
and open it in your own browser. Vault data is ephemeral by default (lost when the
container exits) — mount a volume at `/data` (`SLOPTERM_VAULT_DIR`) to persist it across
runs.
