"""Characterization tests for pre-flight environment-template alignment.

These are self-contained pinning tests. They do **not** import, patch, or depend
on any consent-protocol runtime, IAM, vault, or live shell state. They exercise a
small, local ``.env``-style parsing helper defined inside this module to pin the
observable behaviour any pre-flight workspace verification script relies on:

* dotenv-style lines are parsed into a clean key/value dictionary,
* comments and blank lines are ignored,
* keys declared in a template but absent from the local file are flagged as
  incomplete (rather than silently defaulted),
* obvious exposed-credential sequences are surfaced for review, and
* parsing never mutates the live process environment (``os.environ``).

The parser here is intentionally minimal and hermetic so the tests document
current expected behaviour without introducing any new production contract.
"""

from __future__ import annotations

import os

import pytest

# Value fragments that, if present in a committed template, indicate an exposed
# credential sequence rather than a placeholder. Kept deliberately conservative.
_EXPOSED_CREDENTIAL_MARKERS = ("sk-", "AKIA", "-----BEGIN")


def parse_env_lines(lines: list[str]) -> dict[str, str]:
    """Parse dotenv-style lines into a dict, ignoring comments and blanks.

    Lines without an ``=`` separator are skipped. Surrounding whitespace and a
    single pair of matching quotes around the value are stripped. Keys are
    preserved verbatim (no case folding) so the caller sees exactly what the
    file declared.
    """
    parsed: dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            parsed[key] = value
    return parsed


def missing_required_keys(parsed: dict[str, str], required: list[str]) -> list[str]:
    """Return required keys that are absent or bound to an empty value."""
    return [key for key in required if not parsed.get(key)]


def find_exposed_credentials(parsed: dict[str, str]) -> list[str]:
    """Return keys whose values look like real (non-placeholder) secrets."""
    flagged: list[str] = []
    for key, value in parsed.items():
        if any(marker in value for marker in _EXPOSED_CREDENTIAL_MARKERS):
            flagged.append(key)
    return flagged


@pytest.fixture()
def mock_env_lines() -> list[str]:
    return [
        "# Hushh local workspace template",
        "",
        "API_HOST=localhost",
        'SERVICE_NAME="consent-protocol"',
        "OPENAI_API_KEY=   ",  # declared but incomplete
        "# trailing comment",
        "MALFORMED_LINE_WITHOUT_SEPARATOR",
    ]


def test_parser_isolates_keys_cleanly_from_mock_file(mock_env_lines: list[str]) -> None:
    parsed = parse_env_lines(mock_env_lines)

    # Comments, blanks, and separator-less lines are excluded entirely.
    assert set(parsed) == {"API_HOST", "SERVICE_NAME", "OPENAI_API_KEY"}
    assert parsed["API_HOST"] == "localhost"
    # Surrounding quotes are stripped from the value.
    assert parsed["SERVICE_NAME"] == "consent-protocol"


def test_parser_flags_incomplete_keys(mock_env_lines: list[str]) -> None:
    parsed = parse_env_lines(mock_env_lines)
    required = ["API_HOST", "SERVICE_NAME", "OPENAI_API_KEY", "DATABASE_URL"]

    missing = missing_required_keys(parsed, required)

    # OPENAI_API_KEY is present-but-empty; DATABASE_URL is absent. Both flagged.
    assert missing == ["OPENAI_API_KEY", "DATABASE_URL"]
    # Fully-provided keys are never reported as missing.
    assert "API_HOST" not in missing
    assert "SERVICE_NAME" not in missing


def test_parser_identifies_exposed_credential_sequences() -> None:
    parsed = parse_env_lines(
        [
            "SAFE_PLACEHOLDER=changeme",
            "OPENAI_API_KEY=sk-livesecrettokenvalue0000000000",
            "AWS_ACCESS_KEY_ID=AKIAEXAMPLEEXPOSEDKEY",
            "BENIGN_FLAG=true",
        ]
    )

    flagged = find_exposed_credentials(parsed)

    assert set(flagged) == {"OPENAI_API_KEY", "AWS_ACCESS_KEY_ID"}
    # Placeholder and benign values must not trip the detector.
    assert "SAFE_PLACEHOLDER" not in flagged
    assert "BENIGN_FLAG" not in flagged


def test_parsing_does_not_mutate_live_shell_state(mock_env_lines: list[str]) -> None:
    sentinel = "HUSHH_ENV_VERIFICATION_SENTINEL"
    assert sentinel not in os.environ

    before = dict(os.environ)
    parsed = parse_env_lines(mock_env_lines + [f"{sentinel}=should_not_leak"])

    # The sentinel is visible in the parsed result...
    assert parsed[sentinel] == "should_not_leak"
    # ...but never written through to the live process environment.
    assert sentinel not in os.environ
    assert dict(os.environ) == before
