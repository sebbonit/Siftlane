# Siftlane

Siftlane is a lightweight, native SFTP desktop client built with Rust, Tauri 2, TypeScript, and React. It is designed around a quiet dual-pane workflow: saved connections, strict SSH host-key verification, resumable file transfers, and no advertising or upgrade popups.

![Siftlane dual-pane SFTP client](docs/images/siftlane-app.png)

> **Project status:** early alpha. The SFTP vertical slice is implemented and usable for development. FTP/FTPS, recursive directory transfers, remote search, bookmarks, and signed release updates remain roadmap items.

## What works

- SFTP password, private-key, and SSH-agent authentication through `russh`
- Unknown and changed host-key confirmation with SHA-256 fingerprints
- Connection profiles in SQLite; passwords/passphrases only in the OS keyring
- Local/remote dual-pane browser with remote-focused mode
- Upload/download queue with progress, pause, cancel, retry, conflict prompts, partial files, and restart recovery
- Remote create, rename, delete, and POSIX permission operations
- Persistent preferences, window state, transfer history, and recent connections
- Native macOS, Windows, and Linux packaging configuration
- Browser demo mode for fast UI work without a running Tauri backend

## Development

Prerequisites:

- Rust stable (MSRV 1.88)
- Node.js 22 or newer
- pnpm 11
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

```sh
npm install
npm run tauri dev
```

For frontend-only development, run `npm run dev`. It starts in the same empty first-run state as a fresh desktop install. Run `npm run dev:demo` (or open `/?demo=1`) when you intentionally want the populated UI showcase. Browser connections are simulated; use `npm run tauri dev` to exercise real SFTP and native persistence.

## Quality checks

```sh
npm run build
npm test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Architecture

- `crates/siftlane-core`: protocol-neutral models, errors, filesystem trait, and transfer state machine
- `crates/siftlane-sftp`: `russh`/`russh-sftp` adapter and strict host-key verification
- `src-tauri`: commands, SQLite persistence, OS keyring integration, sessions, and transfer runner
- `src`: React UI, Zustand state, typed IPC boundary, and browser demo adapter

SQLite never stores credentials. Keyring entries use the service name `app.siftlane.desktop`, keyed by connection UUID. Uploads and downloads first write uniquely named partial files and use a backup/rename commit sequence to reduce the chance of replacing a destination with incomplete data.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [docs/architecture.md](docs/architecture.md) for more detail.

## License

Licensed under either of Apache License 2.0 or MIT, at your option.
