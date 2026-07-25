#!/usr/bin/env python3
"""Unit checks for .cursor/hooks/enforce-pr-template.sh"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".cursor" / "hooks" / "enforce-pr-template.sh"

GOOD_BODY = """## What Changed

- something

## Why

- reason

## UI Changes

- none

## Validation

- `pnpm test` — pass

## Checklist

- [x] focused
"""

BAD_SUMMARY = """## Summary

- nope

## Testing

- Not run.
"""


def run(payload: dict) -> dict:
    out = subprocess.check_output(
        [str(SCRIPT)],
        input=json.dumps(payload).encode(),
        cwd=str(ROOT),
    )
    return json.loads(out.decode())


def expect(name: str, payload: dict, permission: str, needle: str | None = None) -> None:
    result = run(payload)
    if result.get("permission") != permission:
        raise AssertionError(f"{name}: expected {permission}, got {result}")
    if needle and needle not in json.dumps(result):
        raise AssertionError(f"{name}: expected message to contain {needle!r}, got {result}")
    print(f"ok  {name}")


def main() -> int:
    heredoc_bad = (
        'gh pr create --title "x" --body "$(cat <<\'EOF\'\n'
        + BAD_SUMMARY
        + 'EOF\n)"'
    )
    heredoc_good = (
        'gh pr create --title "x" --body "$(cat <<\'EOF\'\n'
        + GOOD_BODY
        + 'EOF\n)"'
    )

    expect("deny summary+testing heredoc", {"command": heredoc_bad}, "deny", "## Summary")
    expect("allow good heredoc", {"command": heredoc_good}, "allow")
    expect(
        "deny missing body",
        {"command": 'gh pr create --title "x"'},
        "deny",
        "--body",
    )
    expect(
        "deny --fill without body",
        {"command": "gh pr create --fill"},
        "deny",
        "--fill",
    )
    expect(
        "deny gh --repo pr create summary",
        {
            "command": 'gh --repo sebbonit/Siftlane pr create --title "x" --body "## Summary\\n\\n## Testing\\n"'
        },
        "deny",
        "## Summary",
    )
    expect(
        "allow unrelated shell",
        {"command": "pnpm test", "tool_name": "Shell"},
        "allow",
    )
    expect(
        "allow preToolUse non-pr",
        {"tool_name": "Shell", "tool_input": {"command": "git status"}},
        "allow",
    )
    expect(
        "deny preToolUse bad body",
        {
            "tool_name": "Shell",
            "tool_input": {
                "command": 'gh pr create --title "x" --body "## Summary\\n\\n## Test plan\\n"'
            },
        },
        "deny",
        "## Summary",
    )

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "body.md"
        path.write_text(BAD_SUMMARY, encoding="utf-8")
        expect(
            "deny bad body-file",
            {"command": f'gh pr create --title "x" --body-file {path}', "cwd": tmp},
            "deny",
            "## Summary",
        )
        path.write_text(GOOD_BODY, encoding="utf-8")
        expect(
            "allow good body-file",
            {"command": f'gh pr create --title "x" --body-file {path}', "cwd": tmp},
            "allow",
        )

    print("all enforce-pr-template checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
