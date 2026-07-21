# Contributing to Siftlane

Thank you for helping build a calmer file-transfer client.

## Before opening a pull request

Siftlane is an early-alpha project with a deliberately narrow scope. Please open an issue first for feature proposals, architectural changes, dependency additions, or changes to security-sensitive behavior. A pull request without a related issue may be closed if it does not match the current roadmap.

Pull requests should be small, focused, and clearly motivated. Do not submit unsolicited rewrites, formatting-only changes, generated files, promotional content, or unrelated refactors. Maintainers may decline or close contributions that increase maintenance or security risk without a clear user benefit.

## Local workflow

1. Install the prerequisites listed in the README.
2. Create a focused branch from `main`.
3. Run `pnpm install` and `pnpm tauri dev`.
4. Add tests for state-machine, persistence, and security-sensitive behavior.
5. Run every command in the README's quality-check section before opening a pull request.

Keep protocol details behind `RemoteFilesystem`; the UI should depend on typed commands and shared domain shapes, not transport libraries. Never log passwords, passphrases, private key contents, or full command payloads that may contain credentials.

## Review and repository protection

All changes require maintainer review before merging. Do not assume that opening a pull request grants permission to merge, publish releases, or change repository settings. Security reports, credentials, private keys, and exploit details must never be posted in issues or pull requests; follow [SECURITY.md](SECURITY.md) instead.

The repository uses `.github/CODEOWNERS` to assign maintainer review. GitHub branch protection is enabled for `main`: pull-request review, code-owner approval, conversation resolution, linear history, and restrictions on force-pushes and branch deletion are required. CI runs on pull requests; its check names will be added as required status checks once they are stable in GitHub.

## Scope

The current release line focuses on SFTP reliability on macOS, followed by Windows and Linux. FTP/explicit FTPS support should arrive as a separate adapter after the protocol-neutral core has proven stable.
