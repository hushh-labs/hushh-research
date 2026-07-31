"""Generates HCT golden vectors from the real Python token codec.

Run with the backend's own venv so `hushh_mcp` resolves exactly as it does
in production:

    cd hushh-desktop/windows-daemon
    ../backend/.venv/Scripts/python.exe scripts/generate_golden_vectors.py

APP_SIGNING_KEY / VAULT_DATA_KEY below are fixed TEST-ONLY values used to
make vectors reproducible across regenerations -- never the real per-device
signing key. The C# parity tests embed the same fixed key.
"""

import base64
import hmac
import json
import os
import sys
from pathlib import Path

os.environ["APP_SIGNING_KEY"] = "test-golden-vector-signing-key-do-not-use-in-prod"
os.environ["VAULT_DATA_KEY"] = "a" * 64

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from hushh_mcp.config import APP_SIGNING_KEY  # noqa: E402
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX  # noqa: E402
from hushh_mcp.consent.token import validate_token  # noqa: E402
import hashlib  # noqa: E402


def sign(raw: str) -> str:
    return hmac.new(APP_SIGNING_KEY.encode(), raw.encode(), hashlib.sha256).hexdigest()


def build_token(user_id, agent_id, scope, issued_at, expires_at, commercial=False):
    """Mirrors token.py::issue_token's construction exactly, but with
    caller-supplied (deterministic) timestamps instead of time.time()."""
    if commercial:
        raw = f"{user_id}|{agent_id}|{scope}|{issued_at}|{expires_at}|commercial"
    else:
        raw = f"{user_id}|{agent_id}|{scope}|{issued_at}|{expires_at}"
    signature = sign(raw)
    token_string = f"{CONSENT_TOKEN_PREFIX}:{base64.urlsafe_b64encode(raw.encode()).decode()}.{signature}"
    return token_string, signature


def make_case(name, user_id, agent_id, scope, issued_at, expires_at, commercial=False, expect_valid=True, expect_reason=None):
    token_string, signature = build_token(user_id, agent_id, scope, issued_at, expires_at, commercial)
    valid, reason, parsed = validate_token(token_string)
    case = {
        "name": name,
        "input": {
            "userId": user_id,
            "agentId": agent_id,
            "scope": scope,
            "issuedAt": issued_at,
            "expiresAt": expires_at,
            "commercial": commercial,
        },
        "expectedToken": token_string,
        "expectedSignature": signature,
        "expectedValid": valid,
        "expectedReason": reason,
    }
    assert valid == expect_valid, f"{name}: expected valid={expect_valid}, got {valid} ({reason})"
    if expect_reason is not None:
        assert reason == expect_reason, f"{name}: expected reason={expect_reason!r}, got {reason!r}"
    return case


def make_malformed_case(name, token_string, expect_reason_substr):
    valid, reason, parsed = validate_token(token_string)
    assert not valid, f"{name}: expected invalid, got valid (reason={reason})"
    assert expect_reason_substr in (reason or ""), f"{name}: expected reason containing {expect_reason_substr!r}, got {reason!r}"
    return {
        "name": name,
        "rawToken": token_string,
        "expectedValid": False,
        "expectedReasonContains": expect_reason_substr,
    }


FAR_FUTURE = 4_102_444_800_000  # 2100-01-01T00:00:00Z, ms since epoch
FIXED_ISSUED = 1_700_000_000_000  # 2023-11-14T22:13:20Z


cases = [
    make_case(
        "vault_owner_non_commercial",
        "user_alpha", "agent_hushh_default", "vault.owner",
        FIXED_ISSUED, FAR_FUTURE, commercial=False,
    ),
    make_case(
        "kai_analyze_commercial",
        "user_beta", "agent_kai", "agent.kai.analyze",
        FIXED_ISSUED, FAR_FUTURE, commercial=True,
    ),
    make_case(
        "dynamic_attr_scope",
        "user_gamma", "agent_one", "attr.financial.holdings",
        FIXED_ISSUED, FAR_FUTURE, commercial=False,
    ),
    make_case(
        "dynamic_attr_wildcard_scope",
        "user_delta", "agent_kai", "attr.financial.*",
        FIXED_ISSUED, FAR_FUTURE, commercial=False,
    ),
    make_case(
        "pkm_write",
        "user_epsilon", "agent_one", "pkm.write",
        FIXED_ISSUED, FAR_FUTURE, commercial=False,
    ),
    make_case(
        "unicode_user_id",
        "user_pärth_日本語", "agent_one", "vault.owner",
        FIXED_ISSUED, FAR_FUTURE, commercial=False,
    ),
    make_case(
        "expired_token",
        "user_zeta", "agent_kai", "agent.kai.chat",
        FIXED_ISSUED, FIXED_ISSUED + 1000, commercial=False,
        expect_valid=False, expect_reason="Token expired",
    ),
]

malformed_cases = [
    make_malformed_case("bad_prefix", "XYZ:" + "HCT:abc.def".split(":", 1)[1], "Invalid token prefix"),
    make_malformed_case("no_dot_separator", "HCT:abcdefgh", "Malformed token"),
    make_malformed_case("not_base64", "HCT:not-valid-base64!!!.deadbeef", "Malformed token"),
]

# Tampered-signature case: take a valid token and flip its signature.
_valid_token, _sig = build_token("user_tamper", "agent_one", "vault.owner", FIXED_ISSUED, FAR_FUTURE)
_tampered = _valid_token[:-1] + ("0" if _valid_token[-1] != "0" else "1")
malformed_cases.append(
    make_malformed_case("tampered_signature", _tampered, "Invalid signature")
)


def make_gate_case(name, user_id, agent_id, scope, commercial, expected_scope=None, require_commercial=None, expires_in=None):
    issued_at = FIXED_ISSUED
    expires_at = FIXED_ISSUED + expires_in if expires_in is not None else FAR_FUTURE
    token_string, _ = build_token(user_id, agent_id, scope, issued_at, expires_at, commercial)
    valid, reason, parsed = validate_token(token_string, expected_scope=expected_scope, require_commercial=require_commercial)
    return {
        "name": name,
        "token": token_string,
        "expectedScope": expected_scope,
        "requireCommercial": require_commercial,
        "expectedValid": valid,
        "expectedReason": reason,
    }


gate_cases = [
    make_gate_case("scope_exact_match", "u1", "a1", "vault.owner", False, expected_scope="vault.owner"),
    make_gate_case("scope_vault_owner_grants_anything", "u2", "a1", "vault.owner", False, expected_scope="attr.financial.holdings"),
    make_gate_case("scope_wildcard_domain_grants_specific", "u3", "a1", "attr.financial.*", False, expected_scope="attr.financial.holdings"),
    make_gate_case("scope_mismatch_cross_domain", "u4", "a1", "attr.financial.*", False, expected_scope="attr.food.groceries"),
    make_gate_case("scope_mismatch_static", "u5", "a1", "agent.kai.chat", False, expected_scope="agent.kai.execute"),
    make_gate_case("commercial_required_and_present", "u6", "a1", "agent.kai.chat", True, require_commercial=True),
    make_gate_case("commercial_required_but_absent", "u7", "a1", "agent.kai.chat", False, require_commercial=True),
    make_gate_case("non_commercial_required_and_matches", "u8", "a1", "agent.kai.chat", False, require_commercial=False),
    make_gate_case("non_commercial_required_but_token_is_commercial", "u9", "a1", "agent.kai.chat", True, require_commercial=False),
    make_gate_case("scope_and_commercial_both_pass", "u10", "a1", "attr.financial.*", True, expected_scope="attr.financial.holdings", require_commercial=True),
    make_gate_case("expiry_checked_before_scope", "u11", "a1", "agent.kai.chat", False, expected_scope="agent.kai.execute", expires_in=-1000),
]

output = {
    "signingKey": os.environ["APP_SIGNING_KEY"],
    "consentTokenPrefix": CONSENT_TOKEN_PREFIX,
    "cases": cases,
    "malformedCases": malformed_cases,
    "gateCases": gate_cases,
}

out_path = Path(__file__).resolve().parents[1] / "fixtures" / "hct_golden_vectors.json"
out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"Wrote {len(cases)} cases + {len(malformed_cases)} malformed cases + {len(gate_cases)} gate cases to {out_path}")
