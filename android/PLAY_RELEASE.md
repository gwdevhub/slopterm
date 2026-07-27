# Google Play releases (fastlane)

Uploads the Android App Bundle to Google Play. Driven by
`.github/workflows/versioned-release.yml` — bumping the root `VERSION` file and merging to `main`
builds a signed `.aab`, uploads it here, and attaches the matching signed `.apk` to the GitHub
release. `.github/workflows/android.yml` only verifies the build compiles; it never signs or
uploads.

> Do **not** move this file to `fastlane/README.md`. fastlane regenerates that file from the lane
> descriptions every single time it runs and will silently destroy anything hand-written there —
> which is exactly how the first version of this document was lost.

## One-time setup, done by hand

These cannot be automated. All of them are complete as of the `0.0.1-beta` release.

1. **Create the app in the Play Console and upload the first `.aab` manually.**
   The Play Developer API cannot create a new app listing, and supply refuses to run against an
   app that has never had a build uploaded. Done: versionCode 1200 on the internal track.
2. **Complete the store listing**: title, short/full description, icon, screenshots, content
   rating questionnaire, target audience, **privacy policy URL**, and the **Data safety** form.
   slopterm asks for `INTERNET` and sets `usesCleartextTraffic="true"` (for its own loopback
   server), so expect the data-safety answers to get looked at.
3. **Create a service account** — Play Console → Setup → API access → link a Google Cloud
   project → create a service account → grant it *Release manager* (or at minimum "Release apps
   to testing tracks" plus the production track if you use it) → download a JSON key. Make sure
   the **Google Play Android Developer API** is enabled in that Cloud project.
4. **Create the upload keystore** and keep a backup somewhere that is not this repo or CI:

   ```bash
   keytool -genkeypair -v \
     -keystore upload.keystore \
     -alias upload \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

   Enroll in **Play App Signing** so this is only the *upload* key — then losing it is
   recoverable. Without it, losing this file means the app can never be updated again. Play also
   requires the certificate to stay valid past 2033, so don't shorten `-validity`.

## GitHub secrets

| Secret | Required | Notes |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | yes | `base64 -w0 upload.keystore` |
| `ANDROID_STORE_PASSWORD` | yes | keystore password |
| `ANDROID_KEY_PASSWORD` | yes | key password (same as the store password for a PKCS12 keystore) |
| `ANDROID_KEY_ALIAS` | no | defaults to `upload` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | yes | `base64 -w0 service-account.json` |

Both file secrets are **base64**, not raw contents — the workflow pipes them through
`base64 --decode`. Pasting raw JSON produces an unusable key file. Watch for trailing newlines in
the password secrets; the keystore password file is written with `printf '%s'` precisely so one
doesn't creep in.

```bash
gh secret set ANDROID_KEYSTORE_BASE64 --body "$(base64 -w0 upload.keystore)"
gh secret set ANDROID_STORE_PASSWORD --body 'your_store_password'
gh secret set ANDROID_KEY_PASSWORD --body 'your_key_password'
gh secret set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --body "$(base64 -w0 service-account.json)"
```

The keystore secrets are checked at the start of the release job — it opens the decoded keystore
with the password and looks up the alias, so a mis-encoded or mismatched secret fails there with
a readable error instead of somewhere inside MSBuild's signing step.

## Lanes

| Lane | Track |
|---|---|
| `release` | production |
| `beta` | beta (open/closed testing) |
| `internal` | internal testing |

All three upload as `release_status: 'draft'`, so nothing reaches users until you promote it in
the Play Console. Valid statuses are `draft`, `completed`, `inProgress`, `halted` — override with
`SLOPTERM_PLAY_RELEASE_STATUS`, and override the track with `SLOPTERM_PLAY_TRACK`.

CI picks the track from `VERSION`: anything containing `alpha`/`beta`/`rc` goes to **internal**,
everything else to **production**. That is what stops a prerelease from landing on the production
track.

### Dry run

`validate_only:true` uploads the bundle into a Play edit, asks Google to validate it, then throws
the edit away without committing. Nothing is published and no versionCode is consumed:

```bash
bundle exec fastlane android internal validate_only:true
```

## Running it locally

```bash
cd android
dotnet publish -c Release -f net10.0-android \
  -p:AndroidPackageFormats="aab%3Bapk" \
  -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=/abs/path/upload.keystore \
  -p:AndroidSigningKeyAlias=upload \
  -p:AndroidSigningStorePass=file:/abs/path/store.pass \
  -p:AndroidSigningKeyPass=file:/abs/path/key.pass

cd fastlane
bundle install
bundle exec fastlane android internal validate_only:true    # picks up the newest *-Signed.aab
bundle exec fastlane android internal aab:/abs/path/to.aab  # or point it at one
```

Put the service account key at `android/fastlane/service-account.json` (gitignored) or set
`SUPPLY_JSON_KEY` to its path.

The `%3B` in `AndroidPackageFormats` is not a typo — MSBuild treats a literal `;` inside `-p:` as
a property *separator*, so `-p:AndroidPackageFormats="aab;apk"` fails with
`MSB1006: Property is not valid. Switch: apk`.

Local builds need **JDK 21** (`XA0030` is a hard error on anything newer, including JDK 26) and
the Android SDK with platform `android-36`. If you don't have JDK 21 installed, a portable one
works — unzip `https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip` anywhere and pass
`-p:JavaSdkDirectory=<that folder>` along with `-p:AndroidSdkDirectory=<sdk>`. CI is on JDK 17,
which the SDK also accepts.

**Every path in the Fastfile is anchored to the Fastfile's own directory, never to the working
directory.** fastlane runs lanes with the working directory set to the *parent* of `fastlane/`,
which is not where a relative path in the Fastfile reads as pointing — a relative
`json_key_file("service-account.json")` in the Appfile resolves to `android/service-account.json`,
not `android/fastlane/service-account.json`. Keep using `File.expand_path(..., __dir__)`.

## Versioning

`android/Directory.Build.props` derives both values from the root `VERSION` file — see the
"Cutting a release" section of the [repo README](../README.md) for the format, the progression,
and the enforced bounds. A malformed `VERSION` fails the build with `SLOP0001` rather than
silently producing a lower versionCode than the last release.

## Play Console warnings that are expected

Two advisory warnings appear on every upload. Neither blocks a release, and neither is worth
acting on today — don't re-litigate them each time:

- **"There is no deobfuscation file associated with this App Bundle."** We don't run
  R8/ProGuard, so there is no mapping file to upload and crash reports are already unobfuscated.
  R8 would shrink the app, but the size checkpoint in `AGENTS.md` already passes without it
  (~15 MB for the delivered `arm64-v8a` slice against a 40 MB bar).
- **"This App Bundle contains native code, and you've not uploaded debug symbols."** The `.so`
  files are the AOT-compiled managed assemblies plus the Mono runtime. Play wants a separate
  symbols file under `BUNDLE-METADATA/com.android.tools.build.debugsymbols`, which is an Android
  Gradle Plugin feature (`ndk.debugSymbolLevel`) with no .NET for Android equivalent — there is
  no MSBuild property that produces it. It only affects how readable *native* frames are in Play
  Console; a .NET app's crashes are overwhelmingly managed exceptions, which carry managed stack
  traces regardless. `$(AndroidStripNativeLibraries)` also defaults to `false`, so packaging
  doesn't strip whatever symbols the libraries already carry. If managed Release stack traces
  ever need symbolicating, `$(MonoSymbolArchive)` produces `.mSYM` artifacts for
  `mono-symbolicate` — that's the lever to reach for, not the Play symbols file.

## Troubleshooting

- **"No .aab found"** — the Release publish emits both `.aab` and `.apk`; check
  `android/bin/Release/net10.0-android/` and that the publish actually succeeded.
- **"Package not found" / supply cannot find the app** — the app has not had its first manual
  upload yet, or `package_name` in `Appfile` doesn't match the Play listing.
- **"Version code N has already been used"** — `VERSION` wasn't bumped, or you re-ran the release
  workflow for a version that already shipped. versionCodes are consumed permanently.
- **"Invalid default value for json_key, doesn't match verify_block"** — the service account file
  isn't where the resolved path points. Set `SUPPLY_JSON_KEY` to an absolute path.
- **Play rejects the signature** — the build must be signed by the SDK (`AndroidKeyStore=true`),
  which runs zipalign + apksigner. `jarsigner` alone produces a v1-only signature, which Play
  refuses for anything targeting API 30+.
