# slopterm e2e tests

Playwright tests that drive the real app in a real browser: build the React UI, run the
actual .NET backend, connect it to a disposable `sshd` container, and assert the terminal
actually shows live shell output.

Requires: Docker (for the throwaway SSH target) and the .NET 8 SDK on `PATH` (the backend
is started via `dotnet run`, so `server/wwwroot` must already contain a built front-end -
run `npm run build` in `web/` first).

```sh
npm install
npx playwright install --with-deps chromium   # once
npm test
```

`global-setup.ts` starts a `lscr.io/linuxserver/openssh-server` container bound to a
random loopback port with a throwaway test user, starts the backend and captures its
printed token URL, writes both to `.tmp/context.json` for the tests to read, and tears
both down afterwards. Nothing here touches a real SSH server or persists past the test
run.

`E2E_DOCKER_NETWORK` is an escape hatch for running this harness itself inside a
container that only reaches Docker over a mounted socket (Docker-outside-of-Docker) -
not needed on a normal machine or CI runner.
