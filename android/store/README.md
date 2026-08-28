# Play Store listing assets

Artwork for the Google Play listing, kept in the repo so it is versioned and reproducible
rather than living in someone's downloads folder.

`fastlane/Fastfile` uploads the `.aab` only (`skip_upload_images: true`) — the listing itself
is maintained by hand in the Play Console, so these files are uploaded manually.

## `feature-graphic.png`

The Play Console's **Feature graphic**: exactly **1024 × 500 px**, 24-bit PNG, no alpha. Play
rejects anything else, so don't resize or re-export it through a tool that adds an alpha
channel.

Built from `feature-graphic.html` rather than a binary design file, so it stays editable and
diffable. It uses the app's own brand mark (`web/public/favicon.svg`) and palette
(`--app-bg` `#020617`, `--app-surface` `#0f172a`, accent indigo `#4f46e5`).

Regenerate after editing the HTML:

```sh
cd android/store
node render.mjs        # needs e2e/'s Playwright install: (cd ../../e2e && npm install)
```

Layout note: everything meaningful sits inside a ~40px margin, because Play crops the
feature graphic on some surfaces and overlays a play button on the centre of others.
