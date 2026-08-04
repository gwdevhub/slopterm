# Run slopterm Tests

Build frontend, backend, all OS binaries (win-x64, linux-x64, osx-x64, osx-arm64, Android APK), and execute the full e2e test suite.

## Commands

```bash
# Build frontend
cd web && npm run build

# Build backend and all desktop OS binaries
cd ../server
for rid in win-x64 linux-x64 osx-x64 osx-arm64; do
  dotnet publish -c Release -r $rid
  cp "bin/Release/net10.0/${rid}/publish/Slopterm.Server" "../../slopterm-${rid}"
done

# Build Android APK
dotnet workload install android
cd ../android
dotnet publish -c Release -f net10.0-android
apk="$(find bin/Release/net10.0-android -name '*-Signed.apk' | head -1)"
[ -z "$apk" ] && apk="$(find bin/Release/net10.0-android -name '*.apk' | head -1)"
cp "$apk" ../../slopterm-android.apk

# Build core library
cd ../core
dotnet build

# Unit + sync integration tests (offline; the WebDAV ones skip without a server)
cd ../tests
dotnet test

# Optional: the same WebDAV suite against real servers, since server disagreement over
# ETags and preconditions is exactly what this code has to tolerate
cd ..
./tests/webdav-servers.sh                    # Apache mod_dav + KaraDAV in Docker
SLOPTERM_WEBDAV_USER=… SLOPTERM_WEBDAV_PASS=… ./tests/webdav-servers.sh https://your-share/

# Run e2e tests
cd ../e2e
npm install
npx playwright install --with-deps chromium
npm test
```

## What it does

1. **`npm run build`** - Vite builds React frontend to `../core/wwwroot`
2. **Desktop binaries** - `dotnet publish` creates self-contained single-file executables for win-x64, linux-x64, osx-x64, osx-arm64
3. **Android APK** - Installs Android workload, then publishes APK from android/ directory
4. **`dotnet build`** - .NET builds core library, embedding wwwroot as resources in `Slopterm.Core.dll`
5. **`npm install`** - Installs Playwright test dependencies
6. **`playwright install`** - Downloads Chromium browser for test execution
7. **`npm test`** - Runs all `e2e/tests/*.spec.ts` files via Playwright

## Test flow

`global-setup.ts` runs before all tests:
- Starts Docker container: `lscr.io/linuxserver/openssh-server:latest` with test user `slopterm_test`/`slopterm_test_pw`
- Starts backend: `dotnet run --no-launch-profile` from `server/`
- Captures base URL with auth token, writes to `.tmp/context.json`
- Each test reads this context to connect to the running app
- After tests complete: kills dotnet process, removes Docker container, cleans `.tmp/`
