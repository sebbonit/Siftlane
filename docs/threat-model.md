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
- Completed transfers are verified before promotion: SHA-256 read-back for files up to 64 MB and
  source/destination size verification for larger files.
- Remote paths are normalized before filesystem commands.
- Privileged SFTP commands use a separate SSH channel with fixed commands and shell-quoted paths; `sudo -n` is attempted before password fallback.
- Saved “run remote commands” actions execute user-authored shell strings on an already-authenticated SFTP session (trusted-operator automation). Working directories are shell-quoted; command bodies are not logged.
- Diagnostic logging is disabled by default and runtime-gated by the persisted opt-in setting. The
  disk logger accepts only Siftlane's dedicated diagnostics target, whose structured events use
  allowlisted metadata. Credentials, secret values, hosts, usernames, paths, filenames, commands,
  file contents, and free-form error messages/details are excluded.
- Diagnostic retention is bounded to one active 256 KB file plus three rotated files. Disabling
  diagnostics stops new entries; retained files can be cleared from Settings.
- Tauri capabilities and the webview CSP restrict exposed native functionality.

## Known limitations before stable release

- Update packages are signed with a Tauri/minisign keypair. Apple notarization is not used; macOS Gatekeeper may still warn on first install of unsigned `.dmg`/`.app` builds.
- Update-key rotation procedures are not yet documented.
- Real-server SFTP and FTP/FTPS interoperability tests are opt-in and must be run by release
  maintainers; broader automated coverage across multiple OpenSSH and FTP server versions remains.
- Private-key authentication does not grant sudo by itself. Passwordless privileged editing requires an administrator-managed `NOPASSWD` sudoers policy; cached sudo authorization from a terminal is not assumed to be available to Siftlane.
- Privileged writes use `tee` against the existing target inode to retain its ownership and mode; privileged creates and deletes use fixed directory-aware commands. Administrators should narrowly scope sudoers rules because they grant root-level file modification.
