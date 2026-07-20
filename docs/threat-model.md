# Threat model

## Protected assets

- Authentication secrets and private-key passphrases
- Integrity of downloaded and uploaded files
- Server identity decisions and trusted host-key fingerprints
- Local profile and transfer metadata

## Assumptions

The operating system, logged-in user account, system keyring, and SSH cryptographic implementation are trusted. Siftlane does not defend against a fully compromised endpoint or a server that is already legitimately trusted but malicious.

## Controls

- Trust-on-first-use requires explicit confirmation; mismatches are never auto-accepted.
- Secrets cross the webview boundary only for the immediate connection attempt and are not logged or written to SQLite.
- Partial destinations prevent an interrupted transfer from appearing complete.
- Remote paths are normalized before filesystem commands.
- Tauri capabilities and the webview CSP restrict exposed native functionality.

## Known limitations before stable release

- Release signing and update-key rotation procedures are not yet operational.
- The current queue limits global concurrency; its per-host preference is reserved for scheduler refinement.
- Conflict `rename` requires choosing a new destination; automatic name generation is not yet implemented.
- End-to-end interoperability tests against multiple OpenSSH server versions are still required.
