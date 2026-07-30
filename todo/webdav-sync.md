# WebDAV vault sync, with membership, revocation and read-only members

**Status: planned, not implemented.** This is written to be picked up and built from - it
states what to build, in what order, and which decisions are already made vs. deliberately
left open. Read [scheduled-jobs.md](scheduled-jobs.md)'s note on two devices firing one job
before shipping both features together.

Not to be confused with **Folder sync** (`core/SyncService.cs`), which mirrors local ↔ remote
*directories over SFTP* and has nothing to do with this. Name the new code
`VaultSyncService` / `core/VaultSync/` so the two never get confused in a stack trace.

## What this delivers

A user points a collection of hosts/snippets/keys at a WebDAV URL. Every device that has the
collection's invite token converges on the same content, encrypted end to end. Teams share a
collection by sharing its token; the WebDAV server's own ACL decides who may write.

- Private + two team collections = three URLs (or three folders on one Nextcloud), entered
  once per device.
- Revocation: remove a member, rotate the collection key, re-encrypt. Old token stops working.
- Read-only members: cannot create or modify records (server-enforced), and the UI never
  reveals credential material to them (**not** server-enforced - see the honesty section).

## The honesty section - read this before designing anything

**"Can use a credential but cannot read it" is not enforceable in this architecture.** A
read-only member's device has to present the password/private key to the SSH server, so it
must hold the plaintext. Hiding it in the UI stops casual copying, shoulder-surfing and
accidental pasting into a chat; it does not stop a modified build, a debugger, or reading the
vault file. Ship it as a guardrail and *say so in the UI* - "hidden on this device", never
"you cannot access this".

What write-restriction *is* real: the WebDAV ACL. A read-only share returns 403 on PUT/DELETE,
so "cannot create new ones" holds even against a patched client. Lean on that, and make the
client's own restriction a UX nicety on top of it.

The only designs that make "use but never see" true need infrastructure the app doesn't have:
an SSH CA issuing short-lived certificates, a bastion that authenticates on the user's behalf,
or agent forwarding from a trusted machine. Out of scope here; don't design anything that
forecloses adding one later.

A cryptographic variant that *is* enforceable, if the requirement ever shifts to "can see the
inventory but cannot connect": encrypt record metadata under the collection key and the
credential under a second key wrapped only for full members. Restricted members then genuinely
cannot decrypt the secret - and genuinely cannot connect either. One paragraph of code; a
completely different product decision. Don't build it on spec.

## Data model

### Collections

A **collection** is the unit of sync and sharing. Every host/snippet/keychain entry belongs to
exactly one.

- `local` is implicit, always exists, has no remote, never leaves the device. **Today's records
  stay exactly where they are** (`hosts/{id}.json` etc.) and are treated as the `local`
  collection - no migration, no file moves, and an older build can still read the vault.
- Every other collection lives under `collections/{collectionId}/…` with the same per-type
  record folders. `collectionId` is 128 random bits, hex.

Local layout:

```
vault.json                                  # unchanged
settings.json                               # unchanged
hosts/{id}.json  snippets/{id}.json  …      # unchanged = the `local` collection
collections/{cid}/collection.json           # name, remote config, our role, sync state
collections/{cid}/hosts/{id}.json           # same envelope shape as today
collections/{cid}/members.json              # cached copy of the remote members file
collections/{cid}/tombstones/{id}.json
collections/{cid}/identity.json             # this device's keypair for this collection
```

Everything under `collections/` is encrypted at rest with the **vault key**, exactly like
today's records - the collection key is only used for what goes over the wire.

### Remote layout (WebDAV)

```
<base>/slopterm/v1/collection.json          # {version, collectionId, name, createdAt} - no secrets
<base>/slopterm/v1/members.json             # member list + wrapped collection keys, signed
<base>/slopterm/v1/records/{type}/{id}.json # encrypted envelopes
<base>/slopterm/v1/tombstones/{id}.json
```

`{type}` ∈ `hosts | snippets | keychain | port-forwards`. **Never sync** `logs/`,
`secrets/open-tabs`, `secrets/github-token`, `secrets/appearance` or `settings.json`: they're
device-local, noisy, or credentials for something else entirely.

### Envelope

Mirrors today's on-disk shape, so the sync layer moves records around without decrypting them:

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
  purpose: it means a no-password vault (the default install, whose key derives from a public
  constant - see `VaultCrypto.NoPasswordSeed`) can still sync safely, because what leaves the
  device is never encrypted under that public-seeded key.
- **Device identity**: an X25519 keypair (wrapping) + Ed25519 keypair (signing) per device per
  collection, in `identity.json`. `fingerprint = SHA-256(x25519 pub || ed25519 pub)`, shown as
  a short hex group for out-of-band verification when adding someone.
- **Use BouncyCastle**, which is *already in the publish output* transitively via SSH.NET, so
  X25519/Ed25519 cost no new package. The BCL alternative (P-256 `ECDiffieHellman` + `ECDsa`)
  is tempting but Wine cannot generate ECDH keys at all (`CngKey.Create` throws 0x80090029 -
  documented in AGENTS.md), which would make the repo's mandatory Wine test pass unable to
  exercise any of this. BouncyCastle sidesteps that entirely. Make it a direct
  `PackageReference` rather than relying on a transitive one.
- **Wrapping**: `wrappedKey = ephPub || AES-GCM(HKDF-SHA256(X25519(ephPriv, memberPub)), CK)`,
  fresh ephemeral per member per epoch.
- **Records**: AES-GCM under CK, reusing `VaultCrypto`'s existing encrypt/decrypt.

### members.json

```json
{
  "version": 1,
  "keyEpoch": 3,
  "members": [
    { "id": "…", "label": "marc-laptop", "role": "owner|member|restricted",
      "x25519": "b64", "ed25519": "b64", "wrappedKey": "b64",
      "addedAt": "…", "addedBy": "sha256:…" }
  ],
  "signature": "b64 Ed25519 over the canonical JSON of everything above, by an owner"
}
```

Clients **must** verify the signature against a known-owner key before trusting a member list,
or anyone with write access to the WebDAV share could add themselves. The first owner's key is
pinned when the collection is created; joining devices pin the signer from the invite token.

### Invite token

What a new device scans/pastes. Base64url of `{v, collectionId, name, remoteUrl, auth, CK,
signerEd25519Pub, role}`, prefixed `slopterm:collection:v1:`. QR it - typing a WebDAV
credential on a phone is the single worst part of this feature.

Two properties worth stating: the token *is* the access (possession = membership, no accounts
anywhere), and it contains CK, so an invite must be treated like a password and is
single-purpose - after joining, the device registers its own keypair in `members.json` and the
token can be invalidated by rotating.

## Sync algorithm

Per collection, driven by `VaultSyncService`:

1. **Pull.** `PROPFIND Depth: 1` on each `records/{type}/` → names + ETags. Diff against the
   per-record ETag in the local sync state; `GET` only what changed. Same for `tombstones/`.
2. **Merge**, per record: higher `hlc` wins; a tombstone beats a record with a lower `hlc`.
   When both sides changed since the last sync, keep the loser as a copy (`name + " (conflict
   2026-07-30)"`) rather than dropping it - a silently lost host is the one bug users never
   forgive.
3. **Push.** `PUT` with `If-Match: <last known ETag>` (`If-None-Match: *` for creates). On 412:
   re-GET, merge, retry, bounded at ~3 attempts. Preconditions are best-effort - Nextcloud's
   handling is quirky and some servers ignore them - so last-writer-wins by HLC has to remain
   the fallback, and the conflict copy above is what makes that survivable.
4. **Deletes** write a tombstone and remove the record. GC tombstones older than 90 days (must
   comfortably exceed "laptop was in a drawer for a month").
5. **Triggers**: on unlock, on local change (debounced ~2s), every 5 min, on Android foreground,
   and a manual "Sync now". Never on a timer while the vault is locked.

State lives in `collection.json`: last sync time, per-record `{etag, hlc}`, last error.
Everything is best-effort - a failed sync surfaces in the UI, never throws into a caller.

## Roles, revocation, rotation

| Role | Records | Members | Credentials in UI |
|---|---|---|---|
| `owner` | read/write | add, remove, rotate | shown |
| `member` | read/write | — | shown |
| `restricted` | read only | — | masked, no copy, no export |

- **Write enforcement is the WebDAV ACL.** Give restricted members a read-only share; the
  client additionally hides create/edit/delete and never attempts a PUT. A 403 on push must be
  handled gracefully ("this collection is read-only for you"), not as a sync error loop.
- **Revocation** = remove the member from `members.json`, then **rotate**: new CK at
  `keyEpoch+1`, re-encrypt every record, re-wrap for remaining members, PUT members.json last
  (so a crash mid-rotation leaves readable records for everyone who still has the old epoch).
  A client seeing `keyEpoch` higher than it can unwrap re-fetches `members.json`; a revoked
  one finds no wrapped key for its fingerprint and reports "you no longer have access".
- **Rotation does not un-know anything.** The removed member keeps every credential they ever
  synced. Say this in the revoke dialog, and prompt to rotate the actual SSH credentials -
  that's the only thing that genuinely locks them out of the hosts.

## Surfaces to build

Backend (`core/VaultSync/`):

- `IVaultSyncRemote` - `ListAsync(prefix)`, `GetAsync(path)`, `PutAsync(path, bytes, ifMatch)`,
  `DeleteAsync(path)`. One interface so git/S3 can follow without touching the merge logic.
- `WebDavRemote` - hand-rolled on `HttpClient`: PUT/GET/DELETE/PROPFIND/MKCOL, basic auth,
  minimal XML parse of the multistatus (name + getetag). No new package.
- `VaultSyncService` - one background loop per collection, with the same
  never-let-the-loop-die try/catch `ForwardingService` had to learn the hard way.
- `CollectionCrypto` - CK generation, wrap/unwrap, members.json signing/verification, rotation.
- Endpoints: `/api/vault/collections` (CRUD), `/api/collections/{id}/sync|status`,
  `/api/collections/{id}/members` (list/add/remove), `/api/collections/{id}/rotate`,
  `/api/collections/join`, `/api/collections/{id}/token`.

Frontend:

- A **Collections** sidebar section: name, remote, role, last sync, member list, Sync now,
  Rotate key, Leave.
- Join flow: paste token (QR scan on Android via the existing bridge pattern).
- `ConnectionForm` gains a collection picker; `HostCard` gains a small collection badge.
- Restricted mode: credential fields masked and read-only, no "Copy"/share-token export, "New
  host"/Edit/Delete hidden for that collection.

## Testing

- **Unit**: HLC ordering; the merge matrix (local-only, remote-only, both-changed, tombstone
  vs. update, tombstone GC); wrap/unwrap round-trip; rotation leaves exactly the remaining
  members able to decrypt; members.json signature rejection.
- **Integration against a real server**, in Docker like the SSH one: two `VaultSyncService`
  instances against one WebDAV container, asserting convergence, a real 412 retry, a delete
  propagating, and a revoked member failing to decrypt after rotation. Pick a small server
  ([KaraDAV](https://github.com/kd2org/karadav) is Nextcloud-compatible and light; Apache
  `mod_dav` is the other obvious choice) - and test against **two** implementations, because
  ETag/precondition behaviour is exactly where servers differ.
- **Wine**, per the repo rule: win-x64 build against the same container. This is why the crypto
  is BouncyCastle and not CNG.
- **e2e**: create a collection, join from a second browser context, edit on one, see it on the
  other, restricted mode hides secrets.

## Phasing

1. **One collection, one device, WebDAV round-trip.** Envelope, PROPFIND/GET/PUT, sync state,
   no members - CK comes straight from the token. Proves the transport.
2. **Merge for real**: HLC, tombstones, conflict copies, 412 retry, two-instance integration test.
3. **Membership**: identities, members.json, signing, roles, join/leave.
4. **Revocation + rotation**, with the "rotate your SSH credentials too" prompt.
5. **Restricted UI** + graceful read-only (403) handling.
6. *(Later, optional)* A second `IVaultSyncRemote` - git is the interesting one for teams,
   since it brings real ACLs and per-change attribution.

## Pitfalls

- Write local files atomically (temp + move); a half-written record is a corrupt vault.
- Never log CK, wrapped keys, tokens or ciphertext (existing security rule).
- WebDAV servers disagree about trailing slashes, percent-encoding, whether PROPFIND returns
  the collection itself as the first entry, and whether MKCOL on an existing path is 405 or
  201. Normalise once, in `WebDavRemote`, and keep it out of the merge logic.
- Recommend **app passwords** (Nextcloud) rather than account passwords in the UI copy.
- A `restricted` member must not be able to add members even if the ACL is misconfigured -
  verify the members.json signature, don't trust the role field in your own copy.
- Don't start a sync loop for a locked vault, and don't let one keep the app from quitting.
