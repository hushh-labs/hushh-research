"""SPDX-FileCopyrightText: 2026 Hushh
SPDX-License-Identifier: Apache-2.0

Deterministic golden-vector emitter for Hushh Consent Tokens (HCT).

The output JSON is committed at consent-protocol/tests/fixtures/hct_golden_vectors.json
and consumed by two parity gates:

1. ``tests/test_token_golden_parity.py`` re-runs this emitter and diffs the
   result against the committed JSON. Catches Python-side regressions in
   ``hushh_mcp.consent.token._sign`` or the canonical payload format.

2. ``apps/one-mac/Tests/OneConsentTests/GoldenVectorTests.swift`` loads the
   same JSON and asserts the Swift port produces byte-identical token
   strings for each input. Catches Swift-side drift from the canonical
   Python contract.

The signing key, timestamps, and inputs are all fixed so the JSON is
reproducible byte-for-byte across runs and machines.

Run manually: ``python3 scripts/emit_hct_golden_vectors.py``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path
from typing import Optional

# Fixed signing key for the golden vectors. NEVER use this key in production.
GOLDEN_SIGNING_KEY: str = "golden_vector_signing_key_for_hct_parity_only_32+"

# Pinned anchor timestamp (2026-01-01T00:00:00.000Z) in milliseconds.
GOLDEN_ISSUED_AT_MS: int = 1_767_225_600_000

# Pinned default expiry: 7 days after issued_at. Matches DEFAULT_CONSENT_TOKEN_EXPIRY_MS.
GOLDEN_DEFAULT_TTL_MS: int = 1000 * 60 * 60 * 24 * 7

CONSENT_TOKEN_PREFIX: str = "HCT"  # noqa: S105 - Hushh Consent Token prefix, not a credential

REPO_ROOT: Path = Path(__file__).resolve().parents[1]
OUTPUT_PATH: Path = REPO_ROOT / "tests" / "fixtures" / "hct_golden_vectors.json"


def _sign(input_string: str, signing_key: str) -> str:
    """HMAC-SHA256(signing_key, input_string) as lowercase hexdigest.

    Matches ``hushh_mcp.consent.token._sign`` byte-for-byte: both arguments
    are UTF-8 encoded; output is hex (lowercase, 64 chars).
    """
    return hmac.new(
        signing_key.encode("utf-8"),
        input_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _build_token(
    *,
    user_id: str,
    agent_id: str,
    scope: str,
    issued_at: int,
    expires_at: int,
    commercial: bool,
    signing_key: str,
) -> str:
    """Build a token string exactly as ``hushh_mcp.consent.token.issue_token`` does."""
    if commercial:
        raw = f"{user_id}|{agent_id}|{scope}|{issued_at}|{expires_at}|commercial"
    else:
        raw = f"{user_id}|{agent_id}|{scope}|{issued_at}|{expires_at}"
    signature = _sign(raw, signing_key)
    encoded = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")
    return f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"


def _vector(
    *,
    name: str,
    user_id: str,
    agent_id: str,
    scope: str,
    issued_at_ms: Optional[int] = None,
    expires_in_ms: Optional[int] = None,
    commercial: bool = False,
) -> dict:
    """Materialize one golden vector with its expected token output."""
    issued_at = GOLDEN_ISSUED_AT_MS if issued_at_ms is None else issued_at_ms
    ttl = GOLDEN_DEFAULT_TTL_MS if expires_in_ms is None else expires_in_ms
    expires_at = issued_at + ttl
    token = _build_token(
        user_id=user_id,
        agent_id=agent_id,
        scope=scope,
        issued_at=issued_at,
        expires_at=expires_at,
        commercial=commercial,
        signing_key=GOLDEN_SIGNING_KEY,
    )
    return {
        "name": name,
        "input": {
            "user_id": user_id,
            "agent_id": agent_id,
            "scope": scope,
            "issued_at": issued_at,
            "expires_at": expires_at,
            "commercial": commercial,
            "signing_key": GOLDEN_SIGNING_KEY,
        },
        "expected_token": token,
    }


def build_vectors() -> list[dict]:
    """Return the canonical 12-vector golden set.

    Coverage:
      1.  legacy non-commercial, static scope, ASCII IDs
      2.  legacy non-commercial, pkm.read static scope
      3.  legacy non-commercial, dynamic attr.<domain>.<attr> scope
      4.  legacy non-commercial, dynamic attr.<domain>.* wildcard
      5.  legacy non-commercial, kai-agent operation scope
      6.  commercial flag, vault.owner master scope
      7.  commercial flag, dynamic attr.financial.holdings
      8.  commercial flag, portfolio.analyze
      9.  edge: empty agent_id
      10. UUID-style user_id with hyphens
      11. long path-style scope string
      12. issued_at on day-boundary plus 1ms (catches off-by-one math)
    """
    return [
        _vector(
            name="01_legacy_vault_owner",
            user_id="user_alice",
            agent_id="agent_one",
            scope="vault.owner",
        ),
        _vector(
            name="02_legacy_pkm_read",
            user_id="user_bob",
            agent_id="agent_kai",
            scope="pkm.read",
        ),
        _vector(
            name="03_legacy_attr_dynamic",
            user_id="user_carol",
            agent_id="agent_one",
            scope="attr.financial.gmail",
        ),
        _vector(
            name="04_legacy_attr_wildcard",
            user_id="user_dave",
            agent_id="agent_kai",
            scope="attr.financial.*",
        ),
        _vector(
            name="05_legacy_kai_analyze",
            user_id="user_erin",
            agent_id="agent_kai",
            scope="agent.kai.analyze",
        ),
        _vector(
            name="06_commercial_vault_owner",
            user_id="user_frank",
            agent_id="agent_one",
            scope="vault.owner",
            commercial=True,
        ),
        _vector(
            name="07_commercial_attr_holdings",
            user_id="user_grace",
            agent_id="agent_kai",
            scope="attr.financial.holdings",
            commercial=True,
        ),
        _vector(
            name="08_commercial_portfolio_analyze",
            user_id="user_heidi",
            agent_id="agent_kai",
            scope="portfolio.analyze",
            commercial=True,
        ),
        _vector(
            name="09_edge_empty_agent_id",
            user_id="user_ivan",
            agent_id="",
            scope="vault.owner",
        ),
        _vector(
            name="10_uuid_user_id",
            user_id="550e8400-e29b-41d4-a716-446655440000",
            agent_id="agent_one",
            scope="pkm.read",
        ),
        _vector(
            name="11_long_path_scope",
            user_id="user_judy",
            agent_id="agent_one",
            scope="attr.financial.brokerages.fidelity.portfolios.retirement.401k",
        ),
        _vector(
            name="12_day_boundary_plus_one",
            user_id="user_kim",
            agent_id="agent_kai",
            scope="agent.kai.analyze",
            issued_at_ms=GOLDEN_ISSUED_AT_MS + 1,
            expires_in_ms=60_000,  # 60-second TTL exercises short-lived MCP session tokens
        ),
    ]


def main(argv: list[str]) -> int:
    vectors = build_vectors()
    payload = {
        "version": 1,
        "description": (
            "Hushh Consent Token (HCT) golden vectors. Source of truth: "
            "consent-protocol/hushh_mcp/consent/token.py. Re-emit with "
            "consent-protocol/scripts/emit_hct_golden_vectors.py."
        ),
        "vectors": vectors,
    }

    serialized = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    check_only = "--check" in argv
    if check_only:
        existing = OUTPUT_PATH.read_text(encoding="utf-8") if OUTPUT_PATH.exists() else ""
        if existing != serialized:
            sys.stderr.write(
                "Golden vector drift detected. Re-run scripts/emit_hct_golden_vectors.py "
                "(without --check) and commit the updated tests/fixtures/hct_golden_vectors.json.\n"
            )
            return 1
        sys.stdout.write("Golden vectors match committed JSON.\n")
        return 0

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(serialized, encoding="utf-8")
    sys.stdout.write(f"Wrote {len(vectors)} golden vectors to {OUTPUT_PATH}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
