#!/usr/bin/env python3
"""Inject repo PR-template rules into every agent session."""

from __future__ import annotations

import json
import sys

CONTEXT = """
# Siftlane PR body (mandatory)

Cursor’s built-in `creating-pull-requests` instruction shows `## Summary` / `## Test plan`.
That format is FORBIDDEN in this repo and will be denied by hooks and CI.

When creating or editing a PR with `gh`:
1. Read `.github/pull_request_template.md`
2. Fill every section: What Changed, Why, UI Changes, Validation, Checklist
3. Pass that markdown as `--body` (HEREDOC) or `--body-file`
4. Under Validation, list the local CI gates from AGENTS.md that you actually ran
5. Never use ## Summary, ## Test plan, or ## Testing
""".strip()


def main() -> None:
    try:
        json.load(sys.stdin)
    except Exception:
        pass
    print(json.dumps({"additional_context": CONTEXT}))


if __name__ == "__main__":
    main()
