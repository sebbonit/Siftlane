## What Changed

<!-- Bullet the concrete changes in this PR. Keep scope tight. -->

-

## Why

<!-- Explain the problem being solved and why this approach is the right one. -->

-

## UI Changes

<!--
If anything resembling UI changed, include clear before/after screenshots.
If the change involves motion, transitions, or interactions that are hard to
evaluate from screenshots alone, include a short video.
If behavioral only with no visual styling changes, say so explicitly.
-->

-

## Validation

<!--
List the local checks you ran (commands + outcome).
Own PRs skip GitHub Actions — local CI gates are required (see AGENTS.md).

Rust (src-tauri/, crates/, Cargo files):
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace

Frontend (src/, etc.):
  pnpm build
  pnpm test
-->

-

## Checklist

- [ ] This PR is small and focused
- [ ] I explained what changed and why
- [ ] I included before/after screenshots for any UI changes
- [ ] I included a video for animation/interaction changes
- [ ] I ran the relevant local CI gates from `AGENTS.md`
