#!/usr/bin/env python3
"""Deny gh pr create/edit when the body is not the repo PR template."""

from __future__ import annotations

import json
import re
import sys

REQUIRED_HEADINGS = (
    "## What Changed",
    "## Why",
    "## UI Changes",
    "## Validation",
    "## Checklist",
)

PR_WRITE_RE = re.compile(r"(^|[\s;&|])gh(\s+|--)(.*\s)?pr\s+(create|edit)(\s|$)", re.DOTALL)
BODY_FLAG_RE = re.compile(r"(--body(=|\s)|-F\s|--body-file(=|\s))")


def allow() -> None:
    print(json.dumps({"permission": "allow"}))
    sys.exit(0)


def deny(message: str) -> None:
    print(
        json.dumps(
            {
                "permission": "deny",
                "user_message": message,
                "agent_message": message,
            }
        )
    )
    sys.exit(0)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # failClosed is set; still prefer allow on unreadable input for non-gh noise
        allow()

    command = payload.get("command") or ""
    if not PR_WRITE_RE.search(command):
        allow()

    if not BODY_FLAG_RE.search(command):
        allow()

    if re.search(r"##\s*Summary\b", command):
        deny(
            "Blocked: PR body uses ## Summary. Read .github/pull_request_template.md "
            "and use ## What Changed / ## Why / ## UI Changes / ## Validation / ## Checklist instead."
        )

    if re.search(r"##\s*Test\s+plan\b", command, re.IGNORECASE):
        deny(
            "Blocked: PR body uses ## Test plan. Use ## Validation from "
            ".github/pull_request_template.md (list local CI gates you actually ran)."
        )

    for heading in REQUIRED_HEADINGS:
        if heading not in command:
            deny(
                f"Blocked: PR body is missing '{heading}'. Fill every section from "
                ".github/pull_request_template.md before calling gh pr create/edit."
            )

    allow()


if __name__ == "__main__":
    main()
