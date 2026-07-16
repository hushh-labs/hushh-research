"""Characterization tests: consent-token decoding across multi-byte UTF-8 payloads.

These tests pin the *observed* behavior of the consent-token codec in
``hushh_mcp.consent.token`` when the signed payload carries multi-byte UTF-8
characters (emoji, Kanji, Arabic, Cyrillic, etc.) inside its fields.

Truth-first note on the token format (see ``hushh_mcp/consent/token.py``):

* ``issue_token`` builds a pipe-delimited payload
  ``user_id|agent_id|scope|issued_at|expires_at`` (plus a trailing
  ``|commercial`` for commercial tokens), UTF-8 encodes it, and wraps it with
  ``base64.urlsafe_b64encode``.
* ``validate_token`` reverses this: ``urlsafe_b64decode`` -> ``.decode()``
  (UTF-8) -> ``split("|")``.

The pipe delimiter ``|`` is ASCII ``0x7C``. In UTF-8, every byte of a multi-byte
sequence has its high bit set (``0x80``-``0xFF``), so ``0x7C`` can never appear
as a fragment of a multi-byte character. That means base64 + UTF-8 + ``split("|")``
round-trips international field values without character distortion or field
boundary corruption.

This suite is characterization-only: it documents and locks that guarantee. It
introduces no production code changes.
"""

import base64

import pytest

from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.constants import CONSENT_TOKEN_PREFIX, ConsentScope


# Multi-byte UTF-8 samples spanning several scripts and the emoji plane.
UTF8_SAMPLES = [
    ("emoji", "user_\U0001f680\U0001f512"),        # 🚀🔒 (4-byte astral)
    ("kanji", "\u30e6\u30fc\u30b6\u30fc_\u6f22\u5b57"),  # ユーザー_漢字 (3-byte)
    ("arabic", "\u0645\u0633\u062a\u062e\u062f\u0645"),  # مستخدم (2-byte)
    ("cyrillic", "\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c"),  # пользователь
    ("mixed", "\U0001f9d1\u200d\U0001f4bb_\u00e9\u00fc_\u4f60\u597d"),  # 🧑‍💻_éü_你好
]


@pytest.mark.parametrize("label,marker", UTF8_SAMPLES, ids=[s[0] for s in UTF8_SAMPLES])
def test_token_roundtrips_multibyte_user_id(label: str, marker: str) -> None:
    """A multi-byte UTF-8 user_id survives issue -> validate without distortion."""
    token = issue_token(
        user_id=marker,
        agent_id="agent_ascii",
        scope=ConsentScope.VAULT_OWNER,
    )

    valid, reason, parsed = validate_token(token.token)

    assert valid is True, f"[{label}] expected valid token, got reason={reason!r}"
    assert reason is None
    assert parsed is not None
    # The exact code points must be preserved through base64 + UTF-8 + split.
    assert parsed.user_id == marker
    assert parsed.agent_id == "agent_ascii"


@pytest.mark.parametrize("label,marker", UTF8_SAMPLES, ids=[s[0] for s in UTF8_SAMPLES])
def test_token_roundtrips_multibyte_agent_id(label: str, marker: str) -> None:
    """A multi-byte UTF-8 agent_id survives issue -> validate without distortion."""
    token = issue_token(
        user_id="user_ascii",
        agent_id=marker,
        scope=ConsentScope.VAULT_OWNER,
    )

    valid, reason, parsed = validate_token(token.token)

    assert valid is True, f"[{label}] expected valid token, got reason={reason!r}"
    assert parsed is not None
    assert parsed.agent_id == marker
    assert parsed.user_id == "user_ascii"


def test_token_roundtrips_multibyte_in_both_identity_fields() -> None:
    """Both identity fields carrying different multi-byte scripts stay isolated."""
    user_marker = "\u6f22\u5b57_user"     # 漢字_user
    agent_marker = "\u0627\u0644\u0648\u0643\u064a\u0644"  # الوكيل (Arabic for "agent")

    token = issue_token(
        user_id=user_marker,
        agent_id=agent_marker,
        scope=ConsentScope.VAULT_OWNER,
    )

    valid, _reason, parsed = validate_token(token.token)

    assert valid is True
    assert parsed is not None
    # Field boundaries must not bleed across the pipe delimiter.
    assert parsed.user_id == user_marker
    assert parsed.agent_id == agent_marker


def test_multibyte_payload_is_valid_urlsafe_base64() -> None:
    """The encoded segment is well-formed urlsafe base64 that decodes back to UTF-8.

    This inspects the wire form directly to prove the transport container itself
    stays intact when the payload holds astral-plane characters.
    """
    marker = "vault_\U0001f680"  # vault_🚀
    token = issue_token(
        user_id=marker,
        agent_id="agent_ascii",
        scope=ConsentScope.VAULT_OWNER,
    )

    prefix, signed_part = token.token.split(":", 1)
    assert prefix == CONSENT_TOKEN_PREFIX

    encoded, _signature = signed_part.split(".", 1)
    decoded = base64.urlsafe_b64decode(encoded.encode()).decode("utf-8")
    parts = decoded.split("|")

    # Legacy non-commercial payloads have exactly five pipe-delimited fields.
    assert len(parts) == 5
    assert parts[0] == marker
    assert parts[1] == "agent_ascii"


def test_multibyte_commercial_token_preserves_flag_and_identity() -> None:
    """Commercial multi-byte tokens keep both the trailing flag and UTF-8 fields."""
    marker = "\U0001f4bc_\u4f01\u696d"  # 💼_企業 (briefcase + "enterprise")
    token = issue_token(
        user_id=marker,
        agent_id="agent_ascii",
        scope=ConsentScope.VAULT_OWNER,
        commercial=True,
    )

    valid, _reason, parsed = validate_token(token.token)

    assert valid is True
    assert parsed is not None
    assert parsed.commercial is True
    assert parsed.user_id == marker

    # Confirm the sixth signed field ("commercial") coexists with multi-byte data.
    _prefix, signed_part = token.token.split(":", 1)
    encoded, _signature = signed_part.split(".", 1)
    parts = base64.urlsafe_b64decode(encoded.encode()).decode("utf-8").split("|")
    assert len(parts) == 6
    assert parts[5] == "commercial"


def test_multibyte_token_signature_still_binds_payload() -> None:
    """The HMAC signature computed over the UTF-8 payload still detects tampering.

    A one-character substitution in the encoded multi-byte payload must invalidate
    the signature — proving the codec does not weaken integrity for i18n input.
    """
    marker = "user_\u00e9\u00e8\u00ea"  # user_éèê
    token = issue_token(
        user_id=marker,
        agent_id="agent_ascii",
        scope=ConsentScope.VAULT_OWNER,
    )

    prefix, signed_part = token.token.split(":", 1)
    encoded, signature = signed_part.split(".", 1)

    # Decode, mutate the identity field, re-encode — leaving the old signature.
    parts = base64.urlsafe_b64decode(encoded.encode()).decode("utf-8").split("|")
    parts[0] = "user_\u00e9\u00e8\u00eb"  # flip the final accented character
    tampered_payload = "|".join(parts)
    tampered_encoded = base64.urlsafe_b64encode(tampered_payload.encode("utf-8")).decode()
    tampered_token = f"{prefix}:{tampered_encoded}.{signature}"

    valid, reason, parsed = validate_token(tampered_token)

    assert valid is False
    assert reason == "Invalid signature"
    assert parsed is None
