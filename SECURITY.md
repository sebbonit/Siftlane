# Security policy

Siftlane is pre-release software and does not yet have a supported production version.

Please report suspected vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow for this repository. Do not open a public issue containing credentials, hostnames, private keys, server logs, or exploit details.

## Security boundaries

- SSH host keys are denied by default until the user explicitly trusts their fingerprint.
- A changed key is shown as a stronger warning and never silently replaced.
- Passwords and private-key passphrases are stored only in the operating system keyring.
- SQLite stores profiles, trusted public host-key fingerprints, preferences, and transfer metadata—not secrets.
- The webview uses a restrictive content security policy and a minimal Tauri capability set.

See [docs/threat-model.md](docs/threat-model.md) for assumptions and known limitations.
