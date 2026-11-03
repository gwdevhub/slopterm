# slopterm web

React + TypeScript + Tailwind + xterm.js front-end for slopterm. Talks to the `server/`
backend over HTTP + WebSocket; see the root [README](../README.md) for how the two fit
together.

```sh
npm install
npm run dev      # Vite dev server with hot reload, UI only (no backend wired up yet)
npm run build    # production build, output goes to ../server/wwwroot
```

There's no dev-server proxy to the backend yet, so `npm run dev` is only useful for
iterating on layout/components in isolation. For an end-to-end test, run `npm run build`
then `dotnet run` in `../server` — it serves the built bundle directly.

## Composition regression tests (no build)

With Node 22.6+ and dependencies installed:

```sh
npx playwright install chromium
npm run test:composition
```

These run the composition TypeScript source via Node's native type erasure against the
installed prebuilt xterm bundle in headless Chromium, plus the Android commit-order bridge.
They require no application build, backend, SSH server, or Android emulator. On Linux,
Playwright's browser system dependencies must also be installed.
