# tests/integrations/test_clock_skew.py
"""Characterization tests: how token validation behaves around server clock skew.

TRUTH-FIRST NOTE (verified against hushh_mcp/consent/token.py):

The originally proposed premise for these tests was a "60-second grace window"
for clock desynchronization in the token evaluation pipeline. That grace window
DOES NOT EXIST in `validate_token`. The expiry check is a strict, zero-tolerance
cutoff:

    if int(time.time() * 1000) >= int(expires_at_str):
        return False, "Token expired", None

So a token is valid up to and including the last millisecond before
`expires_at`, and is rejected the instant wall-clock time reaches `expires_at`.
There is no tolerance for a server whose clock runs fast.

The only 60-based grace constant in this module is
`_BoundedRevocationCache._EXPIRED_TOKEN_GRACE_MS`, which is 60 * 60 * 1000
(one HOUR, not 60 seconds) and governs when *revocation* markers may be evicted
from the in-memory cache. It never widens the expiry window: an expired token
is still rejected by `validate_token` regardless of the revocation cache.

These tests pin that real behavior down so any future introduction of a genuine
skew-tolerance window is a deliberate, reviewed change rather than silent drift.
"""

import base64
import time

from hushh_mcp.consent.token import _sign, issue_token, validate_token
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX, ConsentScope
from hushh_mcp.types import AgentID, UserID

USER_ID = UserID("user_clock_skew")
AGENT_ID = AgentID("agent_clock_skew")
SCOPE = ConsentScope.AGENT_KAI_INFER
# A different, real scope used to prove expiry is checked before scope.
OTHER_SCOPE = ConsentScope.VAULT_OWNER



def _token_with_absolute_expiry(expires_at_ms: int, issued_at_ms: int | None = None) -> str:
    """Forge a correctly-signed token string with an exact `expires_at`.

    This mirrors the non-commercial 5-field signed payload produced by
    issue_token(), but lets a test pin the absolute expiry timestamp so the
    skew boundary is deterministic rather than dependent on sleeping.
    """
    if issued_at_ms is None:
        issued_at_ms = expires_at_ms - 60_000
    raw = f"{USER_ID}|{AGENT_ID}|{SCOPE.value}|{issued_at_ms}|{expires_at_ms}"
    signature = _sign(raw)
    encoded = base64.urlsafe_b64encode(raw.encode()).decode()
    return f"{CONSENT_TOKEN_PREFIX}:{encoded}.{signature}"


# 1. A token that expires comfortably in the future validates cleanly.
def test_token_before_expiry_is_valid():
    token = issue_token(USER_ID, AGENT_ID, SCOPE, expires_in_ms=5_000)
    valid, reason, obj = validate_token(token.token, expected_scope=SCOPE)
    assert valid is True
    assert reason is None
    assert obj is not None
    assert obj.expires_at > int(time.time() * 1000)


# 2. Exactly ~1 second before expiry the token is still accepted: the window is
#    inclusive of every instant strictly before expires_at.
def test_token_one_second_before_expiry_is_valid():
    expires_at = int(time.time() * 1000) + 1_000
    token_str = _token_with_absolute_expiry(expires_at)
    valid, reason, obj = validate_token(token_str, expected_scope=SCOPE)
    assert valid is True
    assert reason is None
    assert obj is not None


# 3. The moment wall-clock time has reached/passed expires_at, the token is
#    rejected with "Token expired". This is the hard cutoff (no tolerance).
def test_token_at_or_just_past_expiry_is_rejected():
    expires_at = int(time.time() * 1000) - 1  # already 1 ms in the past
    token_str = _token_with_absolute_expiry(expires_at)
    valid, reason, obj = validate_token(token_str, expected_scope=SCOPE)
    assert valid is False
    assert reason == "Token expired"
    assert obj is None


# 4. CORE CHARACTERIZATION: there is NO 60-second skew grace. A token that
#    expired 30 seconds ago (well inside a hypothetical 60s window) is rejected.
def test_no_sixty_second_grace_window_thirty_seconds_past_expiry():
    expires_at = int(time.time() * 1000) - 30_000  # 30s past expiry
    token_str = _token_with_absolute_expiry(expires_at)
    valid, reason, obj = validate_token(token_str, expected_scope=SCOPE)
    assert valid is False, "expiry is zero-tolerance; no 60s clock-skew grace exists"
    assert reason == "Token expired"
    assert obj is None


# 5. Even 59 seconds past expiry (the far edge of the mythical grace window) the
#    token stays rejected, confirming the cutoff is not merely off-by-one.
def test_no_grace_at_fifty_nine_seconds_past_expiry():
    expires_at = int(time.time() * 1000) - 59_000
    token_str = _token_with_absolute_expiry(expires_at)
    valid, reason, _ = validate_token(token_str, expected_scope=SCOPE)
    assert valid is False
    assert reason == "Token expired"


# 6. Expiry is enforced BEFORE scope: an expired token presented with the wrong
#    scope reports "Token expired" (not "Scope mismatch"), so an out-of-window
#    clock never leaks which scopes an expired token held.
def test_expiry_checked_before_scope_for_skewed_token():
    expires_at = int(time.time() * 1000) - 5_000
    token_str = _token_with_absolute_expiry(expires_at)
    valid, reason, obj = validate_token(token_str, expected_scope=OTHER_SCOPE)

    assert valid is False
    assert reason == "Token expired"
    assert obj is None
