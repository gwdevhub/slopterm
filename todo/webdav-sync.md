# WebDAV vault sync

**Status: implemented.** The code lives in `core/VaultSync/`, the UI in
`web/src/components/CollectionsSection.tsx`, and the tests in `tests/` (plus
`e2e/tests/collections.spec.ts`). Read [scheduled-jobs.md](scheduled-jobs.md)'s note on two
devices firing one job.

**The membership half of this document was NOT built, deliberately.** No members.json, no
per-device keypairs, no signatures, no key epochs, no rotation. Who may read and write a
collection is decided by the WebDAV server's own accounts and permissions - several people
can each have their own login against one shared folder, everyone can share a single login,
or the folder can need no login at all. Revoking someone happens where their access actually
lives: on the server. An app-level permission model layered on top of that would be a second,
weaker one that lies about what it enforces - and the rules written below for it don't hold
together anyway, since a pinned signer and "any member may sign, there are no roles" are
mutually exclusive (the second device to join signs with a key nobody pinned).

What survives from the crypto section is the part that earns its keep: a collection key that
records are encrypted under before they're uploaded, so the server stores ciphertext it
cannot read. It travels in the collection's token alongside the WebDAV credentials.
BouncyCastle went with the asymmetric crypto, so the Wine/CNG concern that motivated it is
moot.

Two other things ended up different, both found by running against real servers:

- **Preconditions are best-effort and the code now assumes nothing.** Apache's mod_dav
  returns no ETag at all - not on PUT, not in PROPFIND - so an unconditional path was
  mandatory: without it every push sent `If-None-Match: *`, got a permanent 412, and was
  abandoned silently. See `VaultSyncService.PushRecordAsync`.
- **A conflict copy requires positive evidence that both sides moved.** "No sync state" is
  not evidence, and treating it as one manufactured duplicates of records nobody had touched.

Verified against the Caddy share this project uses (with two different WebDAV accounts) and
against Apache mod_dav - see `tests/webdav-servers.sh`. The win-x64 build was exercised under
Wine driving a real sync.

## What this delivers

A user points a collection of hosts (and whatever else they choose) at a WebDAV URL. Every
device holding that collection's token converges on the same content, encrypted end to end.
Teams share a collection by sharing its token.

- Private + two team collections = three URLs (or three folders on one Nextcloud), restored on
  a new device by pasting one line of text.
- **Everyone in a collection can add, edit and delete.** No roles, no permission model of our
  own - the WebDAV server's ACL is the only access control, and it's the server's problem.
- **The UI never displays stored credential material**, to anyone, in any collection. That's a
  product decision rather than a permission: a saved secret is something the app uses, not
  something it shows back to you.
- **A host can name a credential instead of carrying one**, so a team shares the host inventory
  while each member connects with their own key. This is the important one - see below.

## The honesty section - read before designing anything

**Hiding credentials in the UI is a guardrail, not a boundary.** Any device that connects to a
host holds that host's secret in plaintext, so masking it stops casual copying,
shoulder-surfing and accidental pasting into a chat - not a patched build, a debugger, or
someone reading the vault file. Say so in the UI ("stored, not shown"), and never imply the
user is being denied something.

The only thing that genuinely restricts a member is the **WebDAV ACL**: a read-only share
returns 403 on PUT/DELETE regardless of what client they run. Nothing here builds on that, but
that's where the real boundary is if it's ever wanted - so handle a 403 on push gracefully
("this collection is read-only for you") rather than as a sync error loop.

Designs that make "use a credential but never see it" actually true need infrastructure the
app doesn't have: an SSH CA issuing short-lived certificates, or a bastion that authenticates
on the user's behalf. Out of scope; don't design anything that forecloses adding one later.

## Credential resolution by name

The feature that makes team sharing genuinely useful: **a synced host doesn't have to carry a
secret at all.**

`CredentialRecord.Kind` gains `"keychain"`, alongside a new `KeychainName` field naming a
keychain entry. `KeychainEntryRecord` already has a `Name`, and that name - not an id - is the
join key, because the whole point is that it may resolve to a *different, local* entry on every
device.

Resolution at connect time, in order:

1. A keychain entry with that name in the **`local` collection** - the user's own key always wins.
2. A keychain entry with that name in the **same collection** as the host - a deliberately
   shared team key, e.g. a `team-credentials` collection synced to its own WebDAV path.
3. A keychain entry with that name in any other collection this device holds.
4. The local `~/.ssh` default identities, reusing `SshConfigService`'s existing lookup of
   `id_ed25519`/`id_ecdsa`/`id_rsa` - so "my normal SSH key" needs no keychain entry at all.
5. Nothing: the card shows "no key on this device", SSH/SFTP disabled - exactly how an
   `~/.ssh/config` alias with no resolvable identity already behaves (reuse `HostCard`'s
   `canConnect` gate) - plus a "link a key" action.

So a team syncs `prod-db` at `10.0.0.5:22` as user `deploy` with `KeychainName: "prod-deploy"`,
and each member's own `prod-deploy` key resolves locally. Addresses, ports, usernames, groups
and startup snippets are shared; nobody's private key ever leaves their device.

Names are unique within a collection (enforce on save). Across collections, precedence is the
list above, and the host card should show which entry actually resolved, so a surprise is
visible rather than mysterious.

An inline secret in a shared collection stays allowed - some teams really do share a service
account - but saving one must warn plainly that everyone in the collection will have it.

## What syncs

Per collection, a set of opt-in **scopes**. Anything the app stores should be *able* to sync;
the defaults just have to be sensible.

| Scope | Default | Notes |
|---|---|---|
| `hosts` | on | the point of the feature |
| `snippets` | on | |
| `keychain` | **off** | on = deliberately sharing private keys; the warning has to be blunt |
| `port-forwards` | on | reference hosts by id, so they follow the hosts |
| `sync-rules` | off | folder-sync rules point at *local* paths; useful across one user's devices, rarely for a team |
| `preferences` | off | appearance + AI endpoint/model + UI toggles - see below |
| `recent-connections` | off | mildly private, little value shared |
| `logs` | never | append-only, noisy, per-device by nature |
| `open-tabs` | never | describes one device's current session state |
| `github-token` | never | a credential for something unrelated to this collection |

**Preferences need a split before they can sync.** `settings.json` today holds
`RequireMasterPassword` next to `CloseToTray` / `ShowSshConfigHosts` / `AiBaseUrl`,
and it has to stay readable *before* the vault is unlocked, because it's what decides whether
to prompt at all. `RequireMasterPassword` describes how *this device's* vault is encrypted and
must never sync. So: leave `settings.json` as the pre-unlock device file, and move the syncable
preferences (plus the existing `secrets/appearance` record) into one vault-stored `preferences`
record a collection can carry.

## Data model

### Collections

A **collection** is the unit of sync and sharing. Every record belongs to exactly one.

- `local` is implicit, always exists, has no remote, never leaves the device. **Today's records
  stay exactly where they are** (`hosts/{id}.json` etc.) and are treated as the `local`
  collection - no migration, no file moves, and an older build can still read the vault.
- Every other collection lives under `collections/{collectionId}/…` with the same per-type
  record folders. `collectionId` is 128 random bits, hex.

```
vault.json                                  # unchanged
settings.json                               # unchanged, device-local, pre-unlock
hosts/{id}.json  snippets/{id}.json  …      # unchanged = the `local` collection
collections/{cid}/collection.json           # name, remote config, scopes, sync state
collections/{cid}/hosts/{id}.json           # same envelope shape as today
collections/{cid}/members.json              # cached copy of the remote members file
collections/{cid}/tombstones/{id}.json
collections/{cid}/identity.json             # this device's keypair for this collection
```

Everything under `collections/` is encrypted at rest with the **vault key**, exactly like
today's records - the collection key is only for what goes over the wire.

### Remote layout (WebDAV)

```
<base>/slopterm/v1/collection.json          # {version, collectionId, name, createdAt} - no secrets
<base>/slopterm/v1/members.json             # member list + wrapped collection keys, signed
<base>/slopterm/v1/records/{type}/{id}.json # encrypted envelopes
<base>/slopterm/v1/tombstones/{id}.json
```

### Envelope

Mirrors today's on-disk shape, so the sync layer moves records without decrypting them:

```json
{
  "id": "01J…", "type": "host",
  "updatedAt": "2026-07-30T12:00:00Z",
  "hlc": "2026-07-30T12:00:00.123Z-0007-<deviceFingerprint8>",
  "keyEpoch": 3,
  "nonce": "b64", "ciphertext": "b64",
  "authorFingerprint": "sha256:…"
}
```

`hlc` is a hybrid logical clock (physical ms, logical counter, device id as tiebreak). Wall
time alone loses to clock skew between a phone and a laptop, and the failure mode is a deleted
host coming back.

## Crypto

- **Collection key (CK)**: 256-bit AES-GCM key, independent of the vault key. Independent on
  purpose: a no-password vault (the default install, whose key derives from the public
  `VaultCrypto.NoPasswordSeed`) can then still sync safely, because what leaves the device is
  never encrypted under that public-seeded key.
- **Device identity**: X25519 (wrapping) + Ed25519 (signing) keypair per device per collection,
  in `identity.json`. `fingerprint = SHA-256(x25519 pub || ed25519 pub)`, shown as short hex
  groups for out-of-band verification.
- **Use BouncyCastle**, already in the publish output transitively via SSH.NET, so X25519/
  Ed25519 cost no new package. The BCL alternative (P-256 `ECDiffieHellman` + `ECDsa`) is
  tempting but Wine cannot generate ECDH keys at all (`CngKey.Create` throws 0x80090029 -
  documented in AGENTS.md), which would leave the repo's mandatory Wine pass unable to exercise
  any of this. Make it a direct `PackageReference` rather than relying on a transitive one.
- **Wrapping**: `wrappedKey = ephPub || AES-GCM(HKDF-SHA256(X25519(ephPriv, memberPub)), CK)`,
  fresh ephemeral per member per epoch.
- **Records**: AES-GCM under CK, reusing `VaultCrypto`'s existing encrypt/decrypt.

### members.json

```json
{
  "version": 1,
  "keyEpoch": 3,
  "members": [
    { "id": "…", "label": "marc-laptop", "x25519": "b64", "ed25519": "b64",
      "wrappedKey": "b64", "addedAt": "…", "addedBy": "sha256:…" }
  ],
  "signature": "b64 Ed25519 over the canonical JSON of everything above"
}
```

Clients **must** verify the signature against a pinned key before trusting a member list, or
anyone with write access to the share could add themselves. The creating device's key is pinned
at creation; a joining device pins the signer carried in the invite token. Any member may sign
(there are no roles) - the signature says "this came from someone already in the collection",
not "from someone senior".

## Pairing: copy and paste, nothing else

Typing a WebDAV URL plus credentials on a phone is the worst part of this feature, and the
answer is a **single line of text the user copies and pastes** - not a camera.

**No camera permission.** Scanning a QR inside the WebView would mean the `CAMERA` manifest
permission, a runtime prompt, `WebChromeClient.OnPermissionRequest` granting
`RESOURCE_VIDEO_CAPTURE`, and a camera entry on the Play listing and data-safety form. That is
a permanent, visible cost on an SSH client - which people are right to be suspicious of - in
exchange for a one-time convenience. Not worth it. Text transfers fine over whatever the user
already uses to move a password between their own devices.

- **Invite token**: base64url of `{v, collectionId, name, remoteUrl, auth, CK, signerEd25519Pub,
  scopes}`, prefixed `slopterm:collection:v1:` - same shape as the existing host-share token
  (`HostShareCodec`), so follow that codec's conventions rather than inventing a second one.
  One token per collection; joining is paste-and-confirm.
- **Sync configuration dump**: one blob covering *every* collection's remote + key, so a fresh
  device is restored in a single paste instead of one token per collection. Same codec, a
  `slopterm:sync-config:v1:` prefix and an array payload. This is the "set up my new phone"
  path, and it's what the feature should be demoed with.
- Both are **copy buttons and a paste box**, on every platform, with no platform-specific code:
  `navigator.clipboard` works because 127.0.0.1 is a secure context, and a plain textarea works
  even when it doesn't.
- **Rendering a QR is still fine** if it's ever wanted - drawing one needs no permission at all,
  and the user's own camera app can read it. Only *scanning* inside the app is ruled out. Not
  in scope for the first cut.
- The token/dump **is** the access (possession = membership; there are no accounts) and it
  carries CK, so treat it like a password: reveal-on-demand, warn against pasting it into chat,
  and note that rotating the key invalidates every token issued before it. Offer the dump
  passphrase-wrapped as well as raw, mirroring how the vault backup already works.

## Sync algorithm

Per collection, driven by `VaultSyncService`:

1. **Pull.** `PROPFIND Depth: 1` on each enabled scope's `records/{type}/` → names + ETags.
   Diff against the per-record ETag in the local sync state; `GET` only what changed. Same for
   `tombstones/`.
2. **Merge**, per record: higher `hlc` wins; a tombstone beats a record with a lower `hlc`.
   When both sides changed since the last sync, keep the loser as a copy (`name + " (conflict
   2026-07-30)"`) rather than dropping it - a silently lost host is the one bug users never
   forgive.
3. **Push.** `PUT` with `If-Match: <last known ETag>` (`If-None-Match: *` for creates). On 412:
   re-GET, merge, retry, bounded at ~3 attempts. Preconditions are best-effort - Nextcloud's
   handling is quirky and some servers ignore them - so last-writer-wins by HLC stays the
   fallback, and the conflict copy is what makes that survivable.
4. **Deletes** write a tombstone and remove the record. GC tombstones older than 90 days (must
   comfortably exceed "laptop was in a drawer for a month").
5. **Triggers**: on unlock, on local change (debounced ~2s), every 5 min, on Android foreground,
   and a manual "Sync now". Never while the vault is locked.

State lives in `collection.json`: last sync time, per-record `{etag, hlc}`, last error.
Everything is best-effort - a failed sync surfaces in the UI, never throws into a caller.

## Membership and revocation (NOT BUILT - see the status note above)

- **Join**: paste token → generate this device's identity → unwrap CK → add self to
  `members.json` (signed) → full pull.
- **Leave**: delete the local collection; optionally remove self from `members.json`.
- **Remove someone else**: drop their entry, then **rotate** - new CK at `keyEpoch+1`,
  re-encrypt every record, re-wrap for the remaining members, PUT `members.json` last so a
  crash mid-rotation leaves records readable by everyone still holding the old epoch. A client
  seeing a `keyEpoch` it can't unwrap re-fetches `members.json`; a removed one finds no wrapped
  key for its fingerprint and reports "you no longer have access to this collection".
- **Rotation does not un-know anything.** The removed member keeps every credential they ever
  synced. The revoke dialog must say so and prompt to rotate the affected SSH credentials -
  that's the only thing that actually locks them out of the hosts. A collection that shares
  only host inventory and resolves keys by name is dramatically better off here, which is the
  best argument for making that the documented default.

## Surfaces to build

Backend (`core/VaultSync/`):

- `IVaultSyncRemote` - `ListAsync(prefix)`, `GetAsync(path)`, `PutAsync(path, bytes, ifMatch)`,
  `DeleteAsync(path)`. One interface so git/S3 can follow without touching merge logic.
- `WebDavRemote` - hand-rolled on `HttpClient`: PUT/GET/DELETE/PROPFIND/MKCOL, basic auth,
  minimal XML parse of the multistatus (href + getetag). No new package.
- `VaultSyncService` - one background loop per collection, with the same
  never-let-the-loop-die try/catch `ForwardingService` had to learn the hard way.
- `CollectionCrypto` - CK generation and record encryption. No wrapping or signing: see the status note.
- `CredentialResolver` - the name-based lookup above, shared by the connect endpoints and by
  whatever the UI uses to decide whether a host is connectable.
- Endpoints: `/api/vault/collections` (CRUD incl. scopes), `/api/collections/{id}/sync`,
  `/api/collections/status`, `/api/collections/join`, `/api/collections/{id}/token`.

Frontend:

- A **Collections** sidebar section: name, remote, scopes, last sync, Sync now, Copy invite
  token, Leave - plus a "Copy sync configuration" action covering every collection at once,
  and the paste box that restores it.
- Join flow: paste a token or a sync-configuration dump. Identical on every platform; no
  camera, no platform-specific code.
- `ConnectionForm`: a collection picker, and a credential mode of "use a key named…" alongside
  the existing paste/browse/keychain-entry options.
- `HostCard`: a collection badge, and the existing `canConnect` treatment when nothing resolves
  on this device.
- Credential fields: masked everywhere, replace-don't-reveal on edit, no copy button, and the
  host-share export drops inline secrets for hosts that resolve by name.

## Testing

- **Unit**: HLC ordering; the merge matrix (local-only, remote-only, both-changed, tombstone vs.
  update, tombstone GC); wrap/unwrap round-trip; rotation leaves exactly the remaining members
  able to decrypt; members.json signature rejection; credential resolution precedence, including
  the "same name resolves to a different local key on each device" case.
- **Integration against a real server**, in Docker like the SSH one: two `VaultSyncService`
  instances against one WebDAV container, asserting convergence, a real 412 retry, a delete
  propagating, and a removed member failing to decrypt after rotation. Use **two** server
  implementations ([KaraDAV](https://github.com/kd2org/karadav) is Nextcloud-compatible and
  light; Apache `mod_dav` is the other obvious choice) - ETag/precondition behaviour is exactly
  where servers differ.
- **Wine**, per the repo rule: win-x64 build against the same container. This is why the crypto
  is BouncyCastle and not CNG.
- **e2e**: create a collection, join from a second browser context, edit on one and see it on
  the other, a host whose key resolves only locally, and the paste-to-join path.

## Phasing

1. **One collection, one device, WebDAV round-trip** - envelope, PROPFIND/GET/PUT, sync state,
   CK straight from a pasted token.
2. **Merge for real**: HLC, tombstones, conflict copies, 412 retry, two-instance integration test.
3. **Credential resolution by name** + the "no key on this device" host state. Shippable and
   useful before membership exists at all.
4. **Membership**: identities, signed members.json, join/leave.
5. **Revocation + rotation**, with the "rotate your SSH credentials too" prompt.
6. **Scopes beyond hosts/snippets**, including the `preferences` split out of `settings.json`.
7. *(Later, optional)* A second `IVaultSyncRemote` - git is the interesting one for teams, since
   it brings real ACLs and per-change attribution.

## Pitfalls

- Write local files atomically (temp + move); a half-written record is a corrupt vault.
- Never log CK, wrapped keys, tokens or ciphertext (existing security rule).
- WebDAV servers disagree about trailing slashes, percent-encoding, whether PROPFIND returns
  the collection itself as the first entry, and whether MKCOL on an existing path is 405 or
  201. Normalise once, in `WebDavRemote`, and keep it out of the merge logic.
- Recommend **app passwords** (Nextcloud) rather than account passwords in the UI copy.
- `RequireMasterPassword` must never sync - it describes this device's own vault encryption.
- A host that resolves its key by name must never fall back to *silently* connecting with a
  different key than the card claims; show what resolved.
- Don't start a sync loop for a locked vault, and don't let one keep the app from quitting.
