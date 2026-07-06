# consent-protocol/tests/integrations/test_jws_structure.py
"""
Characterization tests for pre-flight structural validation of consent tokens.

Source of truth: hushh_mcp/consent/token.py :: validate_token()

TRUTH-FIRST NOTE
----------------
The task framed this as "JWS" (JSON Web Signature) validation. That framing is
inaccurate and these tests pin the *real* format so no reviewer is misled:

- Hushh consent tokens are NOT RFC 7515 JWS. A JWS is three base64url segments
  joined by dots: `header.payload.signature`. Hushh tokens are a proprietary
  shape:  `<PREFIX>:<base64url(payload)>.<hmac_hex_signature>`
  where the DECODED payload is a `|`-delimited record
  (`user_id|agent_id|scope|issued_at|expires_at[|commercial]`), not JSON.
- There is exactly ONE structural delimiter checked before the heavy path:
  after the first `:` split, the signed part must contain a `.`. If it does not,
  validate_token returns `(False, "Malformed token", None)` immediately — it
  never reaches base64 decode, HMAC, expiry, or scope work.
- Everything else ("truncated blocks", "unusual punctuation", wrong field
  count) is caught either by base64 decode raising (returned as
  "Malformed token: ...") or by the field-count guard returning
  "Malformed token" — all BEFORE the HMAC signature comparison and expiry
  checks. That early-rejection ordering is what these tests lock.

The filename keeps the requested `jws` label for traceability with the task,
but the assertions describe the actual `PREFIX:b64.sig` + `|` contract.
"""

import base64

import pytest

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX


def _b64(raw: str) -> str:
    return base64.urlsafe_b64encode(raw.encode()).decode()


def test_missing_dot_delimiter_is_rejected_as_malformed_before_decode():
    # signed part has no '.' separating payload from signature -> immediate exit.
    token = f"{CONSENT_TOKEN_PREFIX}:{_b64('a|b|c|1|2')}"  # note: no '.sig'
    valid, reason, obj = validate_token(token)
    assert valid is False
    assert reason == "Malformed token"
    assert obj is None


def test_string_without_colon_prefix_split_is_malformed():
    # No ':' at all: token_str.split(':', 1) yields a single element, so the
    # unpack into (prefix, signed_part) raises ValueError -> "Malformed token: ".
    valid, reason, obj = validate_token("this-string-has-no-delimiters-at-all")
    assert valid is False
    assert reason is not None and reason.startswith("Malformed token")
    assert obj is None


def test_truncated_base64_block_fails_decode_before_signature_check():
    # Correct outer shape (prefix:...'.'sig) but the payload segment is not
    # valid base64 -> urlsafe_b64decode raises binascii.Error, surfaced as
    # "Malformed token: ..." well before any HMAC comparison.
    token = f"{CONSENT_TOKEN_PREFIX}:@@not-base64@@.deadbeefsignature"
    valid, reason, obj = validate_token(token)
    assert valid is False
    assert reason is not None and reason.startswith("Malformed token")
    assert obj is None


def test_punctuation_crammed_payload_with_wrong_field_count_is_malformed():
    # Decodes cleanly as base64 but the '|'-delimited record has neither 5 nor 6
    # fields (it is punctuation noise), so the field-count guard rejects it
    # BEFORE computing/comparing the HMAC signature.
    noisy = _b64("!!!;;;,,,???###")  # zero '|' delimiters -> 1 field
    token = f"{CONSENT_TOKEN_PREFIX}:{noisy}.whatever-signature"
    valid, reason, obj = validate_token(token)
    assert valid is False
    assert reason == "Malformed token"
    assert obj is None


def test_wrong_prefix_is_rejected_before_payload_decode():
    # Structurally shaped (has ':' and '.') but the prefix is not the canonical
    # consent-token prefix. The prefix guard fires before base64 decode.
    token = f"WRONGPREFIX:{_b64('u|a|attr.x|1|9999999999999')}.sig"
    valid, reason, obj = validate_token(token)
    assert valid is False
    assert reason == "Invalid token prefix"
    assert obj is None


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
