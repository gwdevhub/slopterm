# Privacy policy for slopterm

**Last updated: 2026-07-30**

slopterm is an SSH/SFTP terminal client that runs entirely on your own device. It has no
accounts, no backend service of ours, and nothing to sign up for.

**The short version:** we collect nothing. slopterm sends no telemetry, no analytics, no crash
reports, and no usage data anywhere. There are no ads and no advertising or analytics SDKs. Your
hosts, credentials and terminal sessions stay on your device, except when you tell slopterm to
talk to a server you chose — the hosts you connect to, and (optionally) an AI endpoint and
GitHub for updates. Those are spelled out in [Network connections](#network-connections-slopterm-makes)
below.

There is no "we" that receives your data at all: slopterm has no server side. The rest of this
document is about what the app stores locally and which computers it talks to, because that is
all there is to disclose.

## What slopterm stores on your device

Everything slopterm remembers lives in one directory on your machine:

| Platform | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\slopterm\vault` |
| macOS | `~/Library/Application Support/slopterm/vault` |
| Linux | `$XDG_DATA_HOME/slopterm/vault` (usually `~/.local/share/slopterm/vault`) |
| Android | the app's private storage, which only slopterm can read |

Setting the `SLOPTERM_VAULT_DIR` environment variable moves it elsewhere.

What ends up in there:

- **Hosts** — address, port, username, label, and the other connection details you enter.
- **Credentials and keys** — SSH passwords, private keys, key passphrases, and keychain entries.
- **Your working data** — snippets, port-forwarding rules, folder-sync rules, connection logs,
  recently-used connections, and which tabs were open (so sessions can be restored on restart).
- **AI chat transcripts**, if you use the AI agent — including the terminal output that was sent
  as context.
- **A GitHub token**, if you enter one for updates.
- **Settings** — including the AI endpoint URL and model name, which are stored in plain text
  since neither is a secret.
- **`crash.log` and `startup.log`** — local diagnostic files. If slopterm crashes, the details
  are written here and, on Windows, shown in a dialog. They are never uploaded; nobody sees them
  unless you send them to someone yourself.

Terminal scrollback is held in memory for the life of a session and is not written to disk,
apart from the tab snapshot used to restore sessions and any AI transcript you created.

slopterm reads `~/.ssh/config` only if you turn on the "show SSH config hosts" setting, and it
only reads it — that file is never modified.

### Encryption, and its limits

Vault items are encrypted individually with AES-GCM, using a key derived with Argon2id.

Be aware of what that does and does not protect:

- **With a master password set** (opt-in, under Settings), the key is derived from your password.
  Without it, the vault contents cannot be decrypted. We cannot recover it for you — there is no
  reset, because there is no server holding a copy.
- **Without a master password** — the default, so a new install opens with no prompt — the key is
  derived from a fixed seed built into the app. The files are not readable in a text editor, but
  anyone who can run code as your user account, or read your disk, can decrypt them. If your
  threat model includes other people using your machine, or a stolen laptop, set a master
  password.

Two related things worth knowing:

- **Host share tokens** (the "Copy" action on a host) are encrypted under a fixed, non-secret,
  app-wide key so they aren't plaintext on your clipboard. Any slopterm build can decode one, and
  a token includes that host's credentials. Treat a share token as being as sensitive as the
  password inside it.
- Decrypted vault contents are never written to logs or to disk in the clear.

## Network connections slopterm makes

slopterm's own HTTP server binds to loopback (`127.0.0.1`) only, and is not reachable from your
network unless you explicitly opt in to a different binding. Each launch generates its own access
token, and requests are checked against the expected `Origin`/`Host`. The UI in your browser or
app window talks to the backend over that loopback connection.

Beyond that, slopterm opens exactly these connections:

**1. The hosts you connect to.** SSH and SFTP sessions go directly from your device to the host
you configured — nothing is proxied or relayed through anything of ours. Credentials are sent only
to the host they belong to. What that host logs is up to whoever runs it.

**2. Folder sync**, if you create sync rules. These use SFTP against a host you already
configured, so the same applies: your device to your server, directly.

**3. An update check to GitHub — desktop only.** On Windows, macOS and Linux, slopterm asks
`api.github.com` once at startup whether a newer release exists. It compares checksums and sends
nothing about you or your setup. As with any HTTP request, GitHub sees your IP address and can log
it — see
[GitHub's Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-privacy-statement).
A GitHub token is optional and only used to raise GitHub's rate limit; if you have entered one, it
is sent to authenticate that request.

**The mobile app never makes this request.** Android updates come from Google Play, so the check
exits before opening any connection. No check happens on development builds either.

**4. The AI agent, if you use it.** This is the one feature that can send the contents of your
terminal somewhere. When you talk to the agent, slopterm sends your messages plus **recent
terminal output** from that session to the OpenAI-compatible endpoint set in Settings.

- **By default that endpoint is `http://127.0.0.1:11434/v1`** — a local Ollama server on your own
  machine. With the default, this data does not leave your device.
- **If you change it to a remote or hosted provider, your terminal output goes to that provider**
  and is governed by their privacy policy and retention, not this one. Terminal output routinely
  contains hostnames, file paths, environment details, and sometimes secrets, so choose that
  endpoint deliberately.
- Sending nothing is always an option: if you don't use the agent, no request is made.

That is the complete list. slopterm loads no remote fonts, scripts, or other third-party
resources — the entire UI is embedded in the binary.

## Third parties

There are no third-party SDKs in slopterm: no analytics, no advertising, no crash-reporting
service, no attribution or tracking libraries of any kind.

The only outside parties that ever receive data are ones you pick: the SSH/SFTP hosts you connect
to, GitHub if update checks run, and the AI endpoint you configure. We have no business
relationship involving your data with any of them, and receive nothing back from them.

## Android specifics

- The only Android permission slopterm requests is `INTERNET`, which it needs to reach your SSH
  hosts.
- Notifications are generated locally on the device. There is no push service and no Firebase
  Cloud Messaging — nothing is delivered from a server, so nothing about you is registered with
  one.
- The mobile app makes no update check and no other network request of its own. Apart from
  reaching the SSH/SFTP hosts you configure (and an AI endpoint, if you set one up), it does not
  contact any server.
- App data is kept in slopterm's private storage and is not shared with other apps.
- No data is collected or shared with the developer or anyone else, and none is used for
  advertising, tracking, or profiling.

## Your control over your data

Because everything is local, you are the one holding it:

- Delete individual hosts, credentials, snippets, logs and chats in the app.
- Delete the entire vault directory listed above to remove everything at once.
- On Android, uninstalling the app removes its data.
- No deletion request needs to be sent to us, because we never had a copy.

## Children

slopterm is a developer tool. It is not directed at children and does not knowingly collect
information from anyone, of any age.

## Changes to this policy

If slopterm's data handling changes, this document changes with it in the same commit, and the
date at the top is updated. Because the policy is versioned in the repository alongside the code,
you can see its full history — and diff any two versions — in git.

## Contact

Questions about this policy or slopterm's data handling: open an issue in the
[project repository](https://github.com/gwdevhub/slopterm).

slopterm is free software distributed under the MIT License (see [LICENSE](./LICENSE)), provided
without warranty.
