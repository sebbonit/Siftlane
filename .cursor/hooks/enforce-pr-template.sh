#!/usr/bin/env python3
"""Deny gh PR create/edit when the body is not the repo PR template.

Used by both beforeShellExecution and preToolUse (Shell). Accepts either payload
shape and validates the resolved PR body text (including --body-file contents).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

REQUIRED_HEADINGS = (
    "## What Changed",
    "## Why",
    "## UI Changes",
    "## Validation",
    "## Checklist",
)

FORBIDDEN_HEADING_RES = (
    (re.compile(r"(?m)^#{1,6}\s*Summary\b"), "## Summary"),
    (re.compile(r"(?m)^#{1,6}\s*Test\s*plan\b", re.IGNORECASE), "## Test plan"),
    (re.compile(r"(?m)^#{1,6}\s*Testing\b", re.IGNORECASE), "## Testing"),
)

# gh pr create|edit, including `gh --repo owner/name pr create`
PR_WRITE_RE = re.compile(
    r"(^|[\s;&|])gh(\s+|--)(.*\s)?pr\s+(create|edit)(\s|$)",
    re.DOTALL,
)
# REST/GraphQL create-pull helpers
PR_API_WRITE_RE = re.compile(
    r"(^|[\s;&|])gh(\s+|--)(.*\s)?api\b[^\n]*\b(pulls|pullRequests)\b",
    re.IGNORECASE | re.DOTALL,
)

BODY_FILE_RE = re.compile(
    r"(?:--body-file|--body_file|-F)\s*=?\s*(?P<path>(?:'[^']+'|\"[^\"]+\"|\S+))"
)
BODY_EQ_RE = re.compile(r"(?:--body|-b)=(?P<body>(?:'[^']*'|\"[^\"]*\"|\S+))")
BODY_NEXT_RE = re.compile(
    r"(?:--body|-b)\s+(?P<body>(?:'[^']*'|\"[^\"]*\"|\$\([^\)]*\)|\S+))"
)


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


def extract_command(payload: dict) -> str:
    command = payload.get("command")
    if isinstance(command, str) and command.strip():
        return command

    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict):
        nested = tool_input.get("command")
        if isinstance(nested, str) and nested.strip():
            return nested

    # Some harnesses nest under "input"
    nested_input = payload.get("input")
    if isinstance(nested_input, dict):
        nested = nested_input.get("command")
        if isinstance(nested, str) and nested.strip():
            return nested

    return ""


def strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def unwrap_dollar_heredoc(command: str) -> str | None:
    """Pull the literal body out of --body \"$(cat <<'EOF' ... EOF)\" forms."""
    marker = re.search(
        r"""--body(?:=|\s+)["']?\$\(cat\s+<<['\"]?(\w+)['\"]?""",
        command,
    )
    if not marker:
        # also: --body "$(cat <<EOF ...)"
        marker = re.search(r"""\$\(cat\s+<<['\"]?(\w+)['\"]?""", command)
        if not marker:
            return None
    tag = marker.group(1)
    # Content between newline after opener and a line that is exactly the tag
    rest = command[marker.end() :]
    # Drop a single leading quote/paren leftovers then find body
    m = re.search(
        rf"\r?\n(.*)\r?\n{re.escape(tag)}\s*\)",
        rest,
        re.DOTALL,
    )
    if not m:
        return None
    return m.group(1)


def load_body_file(path_token: str, cwd: str | None) -> str | None:
    path = strip_quotes(path_token)
    if path in {"-", "/dev/stdin"}:
        return None
    candidates = [Path(path)]
    if cwd and not Path(path).is_absolute():
        candidates.insert(0, Path(cwd) / path)
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.read_text(encoding="utf-8")
        except OSError:
            continue
    return None


def extract_body(command: str, cwd: str | None) -> tuple[str | None, str]:
    """Return (body_text_or_none, source_label)."""
    heredoc = unwrap_dollar_heredoc(command)
    if heredoc is not None:
        return heredoc, "heredoc"

    file_match = BODY_FILE_RE.search(command)
    if file_match:
        loaded = load_body_file(file_match.group("path"), cwd)
        if loaded is None:
            return None, "body-file-unreadable"
        return loaded, "body-file"

    eq_match = BODY_EQ_RE.search(command)
    if eq_match:
        return strip_quotes(eq_match.group("body")), "body"

    # Prefer scanning tokens so we don't confuse --body-file with --body
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        tokens = command.split()

    for index, token in enumerate(tokens):
        if token in {"--body", "-b"} and index + 1 < len(tokens):
            value = tokens[index + 1]
            if value.startswith("$("):
                continue
            return strip_quotes(value), "body"
        if token.startswith("--body=") or token.startswith("-b="):
            return strip_quotes(token.split("=", 1)[1]), "body"

    next_match = BODY_NEXT_RE.search(command)
    if next_match:
        value = next_match.group("body")
        if not value.startswith("$("):
            return strip_quotes(value), "body"

    return None, "missing"


def validate_body(body: str) -> str | None:
    """Return a deny message, or None if valid."""
    for pattern, label in FORBIDDEN_HEADING_RES:
        if pattern.search(body):
            return (
                f"Blocked: PR body uses {label}. Read .github/pull_request_template.md "
                "and use ## What Changed / ## Why / ## UI Changes / ## Validation / ## Checklist instead."
            )

    for heading in REQUIRED_HEADINGS:
        if heading not in body:
            return (
                f"Blocked: PR body is missing '{heading}'. Fill every section from "
                ".github/pull_request_template.md before calling gh pr create/edit."
            )

    # Placeholder-only bodies still fail the spirit of the template
    if re.search(r"(?m)^-\s*$", body) and body.count("\n-") >= 3:
        # only complain when sections look empty; keep soft — headings already required
        pass

    return None


def is_pr_write(command: str) -> bool:
    return bool(PR_WRITE_RE.search(command) or PR_API_WRITE_RE.search(command))


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        # failClosed is set on callers — deny opaque PR writes, allow noise
        deny(
            "Blocked: could not parse hook payload while enforcing the PR template. "
            "Retry gh pr create/edit with an explicit --body from .github/pull_request_template.md."
        )

    if not isinstance(payload, dict):
        allow()

    command = extract_command(payload)
    if not command:
        # preToolUse for non-shell, or empty stdin — do not block unrelated tools
        event = str(payload.get("hook_event_name") or "")
        tool = str(payload.get("tool_name") or "")
        if event.startswith("preToolUse") or tool:
            allow()
        # beforeShellExecution with empty command is suspicious under failClosed
        allow()

    if not is_pr_write(command):
        allow()

    # --fill / web / editor flows have no inline template — require an explicit body
    if re.search(r"(^|\s)--fill(\s|$)", command) and not re.search(
        r"(^|\s)(--body|-b|--body-file|-F)(=|\s|$)", command
    ):
        deny(
            "Blocked: `gh pr create --fill` skips the repo template. Pass --body "
            "(or --body-file) filled from .github/pull_request_template.md."
        )

    cwd = payload.get("cwd") or payload.get("working_directory")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()

    body, source = extract_body(command, cwd)
    if body is None:
        if source == "body-file-unreadable":
            deny(
                "Blocked: could not read --body-file for PR template validation. "
                "Use a real file path whose contents follow .github/pull_request_template.md."
            )
        deny(
            "Blocked: gh pr create/edit must pass --body or --body-file with the full "
            "repo template (What Changed / Why / UI Changes / Validation / Checklist)."
        )

    error = validate_body(body)
    if error:
        deny(error)

    allow()


if __name__ == "__main__":
    main()
