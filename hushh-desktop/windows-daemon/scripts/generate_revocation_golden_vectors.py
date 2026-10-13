"""Generates golden vectors for _BoundedRevocationCache's eviction-TTL logic
from the real Python implementation (hushh_mcp/consent/token.py).

Only the pure, deterministic part is captured here: given a token string (or
garbage), what eviction timestamp does _evict_after_ms compute relative to a
fixed "now"? The actual add()/__contains__() locking/eviction behavior is
straightforward enough (and inherently time-dependent) that it's verified
directly in C# unit tests rather than via fixtures.

Run with the backend's own venv:

    cd hushh-desktop/windows-daemon
    ../backend/.venv/Scripts/python.exe scripts/generate_revocation_golden_vectors.py
"""

import base64
import json
import os
import sys
from pathlib import Path

os.environ["APP_SIGNING_KEY"] = "test-golden-vector-signing-key-do-not-use-in-prod"
os.environ["VAULT_DATA_KEY"] = "a" * 64

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from hushh_mcp.consent.token import _BoundedRevocationCache, issue_token  # noqa: E402
from hushh_mcp.constants import DEFAULT_CONSENT_TOKEN_EXPIRY_MS  # noqa: E402
from hushh_mcp.types import UserID, AgentID  # noqa: E402

cache = _BoundedRevocationCache()
NOW_MS = 1_700_000_000_000  # fixed reference "now" for reproducibility

cases = []

# A real, well-formed token -> evict_after_ms == embedded expires_at + grace.
real_token = issue_token(UserID("u1"), AgentID("a1"), "vault.owner").token
cases.append({
    "name": "well_formed_token",
    "tokenStr": real_token,
    "expectedEvictAfterMs": cache._evict_after_ms(real_token, NOW_MS),
})

# Commercial token (6-field payload) -> same rule, still parts[4].
commercial_token = issue_token(UserID("u2"), AgentID("a1"), "agent.kai.chat", commercial=True).token
cases.append({
    "name": "commercial_token",
    "tokenStr": commercial_token,
    "expectedEvictAfterMs": cache._evict_after_ms(commercial_token, NOW_MS),
})

# Garbage / malformed strings -> falls back to now + MALFORMED_TOKEN_TTL_MS.
for name, garbage in [
    ("not_a_token_at_all", "not-a-token-at-all"),
    ("no_colon", "HCTabcdef.123456"),
    ("no_dot", "HCT:abcdefgh"),
    ("bad_base64", "HCT:not-valid-base64!!!.deadbeef"),
    ("wrong_field_count", "HCT:" + base64.urlsafe_b64encode(b"a|b|c").decode() + ".sig"),
]:
    cases.append({
        "name": name,
        "tokenStr": garbage,
        "expectedEvictAfterMs": cache._evict_after_ms(garbage, NOW_MS),
    })

output = {
    "nowMs": NOW_MS,
    "expiredTokenGraceMs": cache._EXPIRED_TOKEN_GRACE_MS,
    "malformedTokenTtlMs": cache._MALFORMED_TOKEN_TTL_MS,
    "defaultConsentTokenExpiryMs": DEFAULT_CONSENT_TOKEN_EXPIRY_MS,
    "cases": cases,
}

out_path = Path(__file__).resolve().parents[1] / "fixtures" / "revocation_cache_golden_vectors.json"
out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"Wrote {len(cases)} cases to {out_path}")
