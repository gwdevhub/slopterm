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

## Testing

`e2e/` has Playwright tests that build the real app, run it, connect it to a disposable
SSH server, and check the terminal actually shows live shell output in a real browser.
See [e2e/README.md](./e2e/README.md). CI (`.github/workflows/ci.yml`) runs the same build
+ e2e suite on Linux for every PR.
