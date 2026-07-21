# AGENTS.md

## Mandatory: verify before commit / push

Do **not** commit or push until the same checks as `.github/workflows/ci.yml` pass locally.
Failed CI wastes GitHub Actions minutes. `cargo check` alone is **not** enough.

### Always run (changed surface)

**Rust** (any change under `src-tauri/`, `crates/`, or `Cargo.toml` / `Cargo.lock`):

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

If `fmt --check` fails, run `cargo fmt --all`, then re-check.

**Frontend** (any change under `src/`, `index.html`, or JS/TS config):

```bash
pnpm build
pnpm test
```

If both Rust and frontend changed, run **both** suites before pushing.

### Common failures that keep burning CI

| Check | Typical cause |
| --- | --- |
| `cargo fmt --all -- --check` | Unformatted Rust (line wrapping, match arms, etc.) |
| `clippy … -D warnings` | Clippy lints treated as errors (e.g. `collapsible_if`) |
| `pnpm build` | `tsc` errors, unused imports, type mismatches |
| `pnpm test` | Broken UI/behavior in Vitest |

### Commit attribution (critical)

**Never** leave Cursor (or any tool) as a commit co-author on this repo.

Cursor may auto-append this trailer when the agent commits:

```text
Co-authored-by: Cursor <cursoragent@cursor.com>
```

That makes Cursor appear as a GitHub contributor. After every `git commit` made by an agent:

1. Inspect the message: `git log -1 --format=%B`
2. If the trailer is present, strip it immediately:

```bash
git log -1 --format=%B | sed '/Co-authored-by: Cursor <cursoragent@cursor.com>/d;/^---------$/d' | git commit --amend -F -
```

3. Confirm it is gone before `git push`.

Do **not** add `Co-authored-by` for Cursor, Copilot, or similar tools. Author must remain the human repo owner only.

### Rules of thumb

1. After finishing code changes, run the relevant checks **before** `git commit` / `git push`.
2. Never assume green because `cargo check` or the app “builds in the IDE.”
3. Prefer fixing fmt/clippy locally over relying on a follow-up CI fix commit.
4. Do not weaken CI (skip fmt/clippy, relax `-D warnings`) to make failures pass.
5. Never push commits that credit Cursor as co-author.
