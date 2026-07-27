# Siftlane

Open-source file transfer client for macOS, Windows, and Linux. SFTP, FTP, and explicit FTPS with a quiet dual-pane workflow — no ads, no upgrade popups.

Built with Rust, Tauri 2, TypeScript, and React. Early alpha: meant for development and evaluation while the cross-platform desktop experience matures.

![Siftlane dual-pane client](./docs/images/siftlane-app.png)

> **Status:** SFTP, FTP, and explicit FTPS work today. Native file drops, external editing, profile portability, enterprise SSH routing, and streamed remote-to-remote copies are available. Implicit FTPS and server-side remote-to-remote copy remain on the roadmap.

## Features at a glance

- SFTP (password, private key, SSH agent), FTP, and explicit FTPS
- Host-key confirmation with SHA-256 fingerprints and OpenSSH `known_hosts` import
- ProxyJump bastions, SOCKS5 / HTTP CONNECT routing, deny-by-default agent forwarding
- Profiles with folders, tags, colors, and notes; credentials only in the OS keyring
- Local/remote dual-pane browser, comparison, and reviewed synchronization
- Transfer queue with pause, retry, priorities, integrity checks, and rate limits
- Native OS file drops, external-editor review, and remote-to-remote copies between sessions

## Dual-pane browser

Connect a profile and work local and remote side by side. Tabs keep multiple sessions open; the queue tracks every upload and download with speed, ETA, and verification status.

![Profile folders, tags, and dual-pane browser](./docs/images/profile-organization.png)

## Directory comparison and sync

**Compare directories** marks local-only, remote-only, newer, and size-mismatch entries without changing either side.

![Directory comparison](./docs/images/directory-comparison.png)

**Synchronize…** always opens a checklist first. Pick two-way (newest wins), upload mirror, or download mirror, then confirm which actions to queue.

![Synchronization review checklist](./docs/images/sync-review.png)

**Synchronized browsing** stores a root pair per profile so navigating one pane follows the other. Multi-select, batch delete/permissions/package, and aggregate sizes live in the same toolbar.

![Multi-selection and transfer queue](./docs/images/multi-selection-queue.png)

Transfer rows expose priority, drag ordering, and a detail drawer with timestamps, retries, partial paths, and errors.

![Transfer queue detail drawer](./docs/images/transfer-queue-details.png)

## Native desktop workflow

Drop files or folders from Finder, Explorer, or a Linux file manager onto the remote pane. Siftlane highlights the destination, then queues the upload through the same conflict-aware path as manual transfers.

![Native file drop onto the remote pane](./docs/images/native-file-drop.png)

**Edit in external editor** downloads a private temporary copy, watches saves, and shows a side-by-side diff before any upload. Confirmed uploads use a temporary remote file and atomic rename.

![External-editor save review](./docs/images/native-external-edit-review.png)

## Remote-to-remote copies

With two sessions open, select remote files and choose **Copy to session…**. Review the route, conflict policy, and destination paths before anything is queued.

![Remote-to-remote route review](./docs/images/remote-to-remote-route.jpg)

Copies stream through the client in ≤256 KB chunks (bounded memory), resume from uniquely named partials, verify size (and SHA-256 up to 64 MB), then commit with an atomic rename.

![Remote-to-remote job in the queue](./docs/images/remote-to-remote-queue.jpg)

## Transfer policies and bandwidth

Choose how symbolic links are handled (skip, copy link, or dereference) and optionally preserve modification times and POSIX permissions. Settings cover global and per-profile rate limits, reusable schedules, and one-hour temporary overrides.

![Bandwidth limits and schedules](./docs/images/bandwidth-settings.png)

## Enterprise SSH

SFTP profiles can ProxyJump through another saved SFTP profile, or reach the host (or bastion) via SOCKS5 / HTTP CONNECT. Agent forwarding is denied by default. Profiles may set ordered allowlists for key exchange, host keys, ciphers, and MACs.

![ProxyJump and SSH options on a profile](./docs/images/enterprise-ssh-profile.png)

**Settings → Trusted hosts** lists every trusted fingerprint with first/last-seen timestamps. Import OpenSSH `known_hosts` (concrete hosts and `[host]:port`); hashed, wildcard, revoked, and CA entries are reported as skipped.

![Trusted SSH host-key management](./docs/images/trusted-host-management.png)

## Portable configuration

**Settings → Profiles & data** exports profiles, bookmarks, and saved actions as versioned `app.siftlane.configuration` JSON. Imports are previewed and merged by stable ID. Plain exports never read the keyring.

![Portable configuration export and import](./docs/images/portable-configuration.png)

**Export encrypted…** is a separate action: it asks for a new passphrase, reads only selected credentials from the keyring, and encrypts with Argon2id + AES-256-GCM. Siftlane does not store or recover that passphrase.

![Encrypted secret export](./docs/images/encrypted-configuration-export.png)

## Project structure

```text
.
├── crates/
│   ├── siftlane-core/       # Shared models, filesystem traits, transfer state machine
│   ├── siftlane-sftp/       # russh / russh-sftp + host-key verification
│   └── siftlane-ftp/        # FTP and explicit FTPS
├── src/                     # React UI, Zustand store, typed IPC, browser demo
├── src-tauri/               # Tauri commands, SQLite, keyring, sessions, transfers
└── docs/                    # Architecture, threat model, screenshots
```

## Development

Prerequisites: Rust stable (MSRV 1.88), Node.js 22+, pnpm 11, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

Frontend-only: `pnpm dev` (empty first-run state) or `pnpm dev:demo` / `/?demo=1` for the populated showcase. Browser connections are simulated — use `pnpm tauri dev` for real SFTP and native persistence.

Regenerate README screenshots from the demo UI (Vite must be running on port 5173):

```sh
pnpm exec vite --host 127.0.0.1 --port 5173
pnpm screenshots:readme
```

## Quality checks

```sh
pnpm build
pnpm test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Security notes

SQLite never stores credentials. Keyring entries use service `app.siftlane.desktop`, keyed by connection UUID. Uploads and downloads write uniquely named partials and commit via backup/rename. External-editor copies live under a process-owned temp root (`0700` / `0600` on Unix) and are removed on shutdown.

### macOS development Keychain

Ad-hoc Rust debug builds get a new code-signing hash each rebuild, which can re-prompt Keychain. `pnpm tauri dev` signs the debug executable with the first available **Apple Development** identity, or a local **Siftlane Development** identity. Set `SIFTLANE_DEV_SIGNING_IDENTITY` when multiple identities exist. Choose **Always Allow** on the first prompt after enabling this.

Without a paid Apple Developer account, create a local **Siftlane Development** code-signing certificate in Keychain Access, trust it for Code Signing, verify with `security find-identity -v -p codesigning`, then run `pnpm tauri dev`.

Protected local/SFTP file ops can use sudo after normal SSH authentication. Siftlane probes `sudo -n` and otherwise prompts for the sudo password for that operation only — it is never stored or logged.

More detail: [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [docs/architecture.md](docs/architecture.md), [docs/integration-testing.md](docs/integration-testing.md), [docs/release-security.md](docs/release-security.md).

## License

Licensed under either of Apache License 2.0 or MIT, at your option.
