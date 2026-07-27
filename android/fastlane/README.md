# Fastlane Setup for Google Play Store

This directory contains Fastlane configuration for automatically uploading slopterm Android builds to Google Play Store.

## Prerequisites

### 1. Install Fastlane

Fastlane requires Ruby. On Ubuntu (used by GitHub Actions), it's pre-installed.

```bash
# Install Ruby (if not already installed)
sudo apt-get install ruby-full

# Install Bundler
gem install bundler

# Install Fastlane dependencies
cd android/fastlane
bundle install
```

### 2. Google Play Service Account

1. Go to [Google Play Console](https://play.google.com/console/)
2. Navigate to **Settings** → **API Access**
3. Click **"Create Service Account"**
4. In the Google Cloud Console, create a service account with **"Project Admin"** or **"Release Manager"** role
5. Download the JSON key file and save it as `android/fastlane/service-account.json`

> **⚠️ IMPORTANT:** Add `service-account.json` to `.gitignore` - never commit this file!

### 3. Release Signing Keystore

Generate a release keystore:

```bash
keytool -genkeypair \
  -v -keystore slopterm-release.keystore \
  -alias slopterm-release \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass YOUR_STORE_PASSWORD \
  -keypass YOUR_KEY_PASSWORD
```

Store it in the `android/` directory and configure signing in `android/Slopterm.Android.csproj`.

> **⚠️ IMPORTANT:** Add `*.keystore` and `*.jks` to `.gitignore`

## Available Lanes

| Lane | Description | Track |
|------|-------------|-------|
| `release` | Upload to Production | production |
| `beta` | Upload to Beta | beta |
| `internal` | Upload to Internal Testing | internal |

## Usage

### Local Development

```bash
# Install dependencies
cd android/fastlane
bundle install

# Build the APK
cd ..
dotnet publish -c Release -f net10.0-android

# Upload to Google Play
cd fastlane
bundle exec fastlane release
```

### CI/CD (GitHub Actions)

The GitHub Actions workflow automatically:
1. Builds the APK
2. Signs it with the release keystore
3. Uploads to Google Play using Fastlane

## Configuration

### GitHub Secrets Required

| Secret Name | Description |
|-------------|-------------|
| `ANDROID_STORE_PASSWORD` | Keystore store password |
| `ANDROID_KEY_PASSWORD` | Keystore key password |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded keystore file |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Base64-encoded service account JSON |

### Setting Up Secrets

```bash
# Encode your keystore
base64 -w 0 slopterm-release.keystore > keystore.base64

# Encode your service account JSON
base64 -w 0 service-account.json > service-account.base64

# Add to GitHub Secrets (Settings → Secrets → Actions)
gh secret set ANDROID_STORE_PASSWORD "your_store_password"
gh secret set ANDROID_KEY_PASSWORD "your_key_password"
gh secret set ANDROID_KEYSTORE_BASE64 "$(cat keystore.base64)"
gh secret set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON "$(cat service-account.base64)"
```

## Version Management

The APK version is automatically calculated from the root `VERSION` file:
- `versionCode = MAJOR * 10000 + MINOR * 100 + PATCH`
- `versionName =` contents of VERSION file (e.g., `0.0.1-beta`)

To release a new version:
```bash
echo "0.0.2" > VERSION
git add VERSION
git commit -m "Bump to 0.0.2"
git push
```

## Release Status Options

The `upload_to_play_store` action supports these `release_status` values:
- `draft` - Upload but don't publish (default, recommended for CI)
- `inReview` - Upload and submit for review
- `published` - Upload and immediately publish to users

**Recommendation:** Use `draft` in CI, then manually review and publish in Google Play Console.

## Troubleshooting

### "No APK found"
Make sure you ran `dotnet publish -c Release -f net10.0-android` before running Fastlane.

### "Permission denied"
Ensure the service account has the correct permissions in Google Play Console.

### "Invalid keystore"
Verify your keystore path and passwords in `android/Slopterm.Android.csproj`.

### Fastlane not found
Run `bundle install` in the `android/fastlane` directory.
