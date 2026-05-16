"""SPDX-FileCopyrightText: 2026 Hushh
SPDX-License-Identifier: Apache-2.0

Parity gate: catches drift between the canonical HCT signer in
``hushh_mcp.consent.token`` and the committed golden vectors at
``tests/fixtures/hct_golden_vectors.json``.

Two halves of this contract:

1. Re-run the emitter (``scripts/emit_hct_golden_vectors.py --check``) and
   diff against the committed JSON. Catches Python-side regressions where
   ``_sign``, the canonical payload format, or the prefix change.

2. Reconstruct each token from the committed inputs using the same low-level
   primitives ``hushh_mcp.consent.token.issue_token`` uses, and assert the
   resulting string matches ``expected_token`` byte-for-byte. Catches
   regressions that the emitter itself wouldn't notice (e.g. if both the
   emitter and the real signer were updated together but the new behaviour
   doesn't match prior outputs).

The Swift port at ``apps/one-mac/Sources/OneConsent/TokenCodec.swift`` is
gated by the same golden JSON via
``apps/one-mac/Tests/OneConsentTests/GoldenVectorTests.swift``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
EMITTER_PATH = REPO_ROOT / "scripts" / "emit_hct_golden_vectors.py"
GOLDEN_JSON_PATH = REPO_ROOT / "tests" / "fixtures" / "hct_golden_vectors.json"
CONSENT_TOKEN_PREFIX = "HCT"  # noqa: S105 - Hushh Consent Token prefix, not a credential


def _load_golden_payload() -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(GOLDEN_JSON_PATH.read_text(encoding="utf-8"))
    return payload


def _rebuild_token(spec: dict) -> str:
    user_id = spec["user_id"]
    agent_id = spec["agent_id"]
    scope = spec["scope"]
    issued_at = int(spec["issued_at"])
    expires_at = int(spec["expires_at"])
    commercial = bool(spec["commercial"])
    signing_key = spec["signing_key"]

    if commercial:
        raw = f"{user_id}|{agent_id}|{scope}|{issued_at}|{expires_at}|commercial"
    else:
        raw = f"{user_id}|{agent_id}|{scope}|{issued_at}|{expires_at}"

    signature = hmac.new(
        signing_key.encode("utf-8"),
        raw.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    encoded = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")
    return f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"


def test_emitter_check_mode_against_committed_json() -> None:
    """Re-run the deterministic emitter and ensure no drift vs. committed JSON."""
    result = subprocess.run(  # noqa: S603 - inputs are constants, not user-controlled
        [sys.executable, str(EMITTER_PATH), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"emit_hct_golden_vectors.py --check failed:\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}\n"
        "Re-run scripts/emit_hct_golden_vectors.py and commit the regenerated JSON."
    )


def test_golden_json_is_well_formed() -> None:
    payload = _load_golden_payload()
    assert payload["version"] == 1
    assert isinstance(payload["vectors"], list)
    assert len(payload["vectors"]) == 12, "expected 12 golden vectors"
    names = [vec["name"] for vec in payload["vectors"]]
    assert len(set(names)) == len(names), "vector names must be unique"


@pytest.mark.parametrize("vector_index", range(12))
def test_token_round_trip_matches_expected(vector_index: int) -> None:
    """Re-construct each token from its committed inputs; assert byte parity."""
    payload = _load_golden_payload()
    vector = payload["vectors"][vector_index]
    rebuilt = _rebuild_token(vector["input"])
    assert rebuilt == vector["expected_token"], (
        f"HCT parity drift on vector '{vector['name']}'. "
        f"Inputs: {vector['input']!r}. "
        f"Expected: {vector['expected_token']!r}. "
        f"Got: {rebuilt!r}."
    )


def test_token_uses_canonical_prefix() -> None:
    payload = _load_golden_payload()
    for vec in payload["vectors"]:
        token = vec["expected_token"]
        prefix, _, _ = token.partition(":")
        assert prefix == CONSENT_TOKEN_PREFIX, (
            f"vector {vec['name']!r} has prefix {prefix!r}, expected {CONSENT_TOKEN_PREFIX!r}"
        )


def test_signature_is_lowercase_hex_64_chars() -> None:
    payload = _load_golden_payload()
    for vec in payload["vectors"]:
        token = vec["expected_token"]
        _, _, signed = token.partition(":")
        _, _, signature = signed.partition(".")
        assert len(signature) == 64, (
            f"vector {vec['name']!r} signature is {len(signature)} chars; expected 64"
        )
        assert signature == signature.lower(), f"vector {vec['name']!r} signature has uppercase hex"
        int(signature, 16)  # raises ValueError if not hex
