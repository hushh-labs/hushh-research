# consent-protocol/tests/integrations/test_sanitizer.py
"""
Characterization tests for the recursive PII payload sanitizer.

Source of truth: hushh_mcp/consent/pii_sanitizer.py
    - sanitize_payload  (recursive, non-mutating dict traversal)
    - _sanitize_value   (per-key masking dispatch)

TRUTH-FIRST NOTE
----------------
The proposed premise said "unconsented keys ('raw_input', 'session_cache') are
stripped or masked" by key name. That is NOT how this sanitizer works, and these
tests pin the real contract:

- `sanitize_payload` NEVER removes keys. It returns a copy with the SAME key set;
  no key allowlist/denylist strips structural nodes.
- Masking is CONTENT-based, not key-name based for arbitrary keys. Only keys in
  `_FORMAT_MASK_KEYS` / `_TEXT_MASK_KEYS` get forced masking; every other string
  is still passed through the email/phone maskers, so embedded PII is masked but
  the surrounding structure is preserved verbatim.
- `raw_input` and `session_cache` are not in any mask set, so their non-PII
  string content survives unchanged; PII *inside* those values is still masked
  because every string routes through `sanitize_log_value`.

If the project later wants true key-based stripping of `raw_input` /
`session_cache`, that is a new capability to add to `pii_sanitizer.py` behind an
explicit denylist — not something the current sanitizer silently does. These
assertions lock the boundary so that change would be deliberate and reviewed.
"""

from hushh_mcp.consent.pii_sanitizer import sanitize_payload


def test_sanitize_payload_masks_pii_content_but_keeps_all_keys():
    payload = {
        "email": "alice@example.com",
        "raw_input": "user typed hello world",
        "session_cache": "cache-token-xyz",
        "amount": 42,
    }
    out = sanitize_payload(payload)
    # Truth correction: no key is stripped — structural key set is preserved.
    assert set(out.keys()) == set(payload.keys())
    # PII-bearing known key is masked.
    assert out["email"] == "a***e@example.com"
    # Non-PII, non-masked keys pass through their content unmodified.
    assert out["raw_input"] == "user typed hello world"
    assert out["session_cache"] == "cache-token-xyz"
    # Non-string scalars pass through unchanged.
    assert out["amount"] == 42


def test_sanitize_payload_masks_embedded_pii_inside_unconsented_keys():
    # Even for keys not in any mask set, embedded email/phone content is masked
    # because every string routes through sanitize_log_value.
    payload = {"raw_input": "contact bob@example.com now"}
    out = sanitize_payload(payload)
    assert "bob@example.com" not in out["raw_input"]
    assert out["raw_input"] == "contact b***b@example.com now"


def test_sanitize_payload_recurses_into_nested_dicts():
    payload = {
        "session_cache": {
            "email": "carol@example.com",
            "note": "harmless note",
        }
    }
    out = sanitize_payload(payload)
    assert out["session_cache"]["email"] == "c***l@example.com"
    # Adjacent public structural node inside the nested dict is untouched.
    assert out["session_cache"]["note"] == "harmless note"


def test_sanitize_payload_recurses_into_lists_of_dicts():
    payload = {
        "raw_input": [
            {"email": "dave@example.com"},
            {"label": "plain"},
        ]
    }
    out = sanitize_payload(payload)
    assert out["raw_input"][0]["email"] == "d***e@example.com"
    # Adjacent public node in the list passes through unmutated.
    assert out["raw_input"][1]["label"] == "plain"


def test_sanitize_payload_does_not_mutate_the_input():
    payload = {"email": "erin@example.com", "raw_input": "keep me"}
    snapshot = {"email": "erin@example.com", "raw_input": "keep me"}
    sanitize_payload(payload)
    # Original dict must be untouched (non-mutating contract).
    assert payload == snapshot


def test_sanitize_payload_masks_text_identity_keys_even_without_pattern():
    # _TEXT_MASK_KEYS force full masking even when the value has no email/phone.
    payload = {
        "full_name": "Jane Doe",
        "session_cache": "Jane Doe",
    }
    out = sanitize_payload(payload)
    # Identity key is fully masked (first char + stars).
    assert out["full_name"] == "J*******"
    # Same literal under a non-masked key is NOT force-masked (no PII pattern).
    assert out["session_cache"] == "Jane Doe"
