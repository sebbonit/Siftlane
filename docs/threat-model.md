# Threat model

## Protected assets

- Authentication secrets and private-key passphrases
- Transient sudo passwords and root-level file-edit authorization
- Integrity of downloaded and uploaded files
- Server identity decisions and trusted host-key fingerprints
- Local profile and transfer metadata

## Assumptions

The operating system, logged-in user account, system keyring, and SSH cryptographic implementation are trusted. Siftlane does not defend against a fully compromised endpoint or a server that is already legitimately trusted but malicious.

## Controls

- Trust-on-first-use requires explicit confirmation; mismatches are never auto-accepted.
- Secrets cross the webview boundary only for the immediate connection attempt and are not logged or written to SQLite.
- Sudo passwords cross the webview boundary only for one privileged operation; they are not persisted, cached, or logged.
- Partial destinations prevent an interrupted transfer from appearing complete.
- Remote paths are normalized before filesystem commands.
- Privileged SFTP commands use a separate SSH channel with fixed commands and shell-quoted paths; `sudo -n` is attempted before password fallback.
- Tauri capabilities and the webview CSP restrict exposed native functionality.

## Known limitations before stable release

- Release signing and update-key rotation procedures are not yet operational.
- The current queue limits global concurrency; its per-host preference is reserved for scheduler refinement.
- Conflict `rename` requires choosing a new destination; automatic name generation is not yet implemented.
- End-to-end interoperability tests against multiple OpenSSH server versions are still required.
- Private-key authentication does not grant sudo by itself. Passwordless privileged editing requires an administrator-managed `NOPASSWD` sudoers policy; cached sudo authorization from a terminal is not assumed to be available to Siftlane.
- Privileged writes use `tee` against the existing target inode to retain its ownership and mode; privileged creates and deletes use fixed directory-aware commands. Administrators should narrowly scope sudoers rules because they grant root-level file modification.
