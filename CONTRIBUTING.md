# Contributing to Siftlane

Thank you for helping build a calmer file-transfer client.

## Local workflow

1. Install the prerequisites listed in the README.
2. Create a focused branch from `main`.
3. Run `pnpm install` and `pnpm tauri dev`.
4. Add tests for state-machine, persistence, and security-sensitive behavior.
5. Run every command in the README's quality-check section before opening a pull request.

Keep protocol details behind `RemoteFilesystem`; the UI should depend on typed commands and shared domain shapes, not transport libraries. Never log passwords, passphrases, private key contents, or full command payloads that may contain credentials.

## Scope

The current release line focuses on SFTP reliability on macOS, followed by Windows and Linux. FTP/explicit FTPS support should arrive as a separate adapter after the protocol-neutral core has proven stable.
