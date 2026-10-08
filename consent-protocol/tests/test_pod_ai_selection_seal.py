"""The sealed "Bring your own AI" envelope (contract C1), byte for byte and check by check.

The golden vector (``tests/fixtures/ai_selection_seal_vector_v1.json``) is shared with
the app: both ends must produce the identical envelope from identical inputs, or a
device and its agent silently disagree about what was sealed. Every acceptance check
then has its own negative control: the same envelope with that one property broken is
refused with its typed code, and the untouched envelope still opens.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.services import pod_ai_selection_seal as seal
from hushh_mcp.services.pod_session_authority import canonical_json

VECTOR = json.loads(
    (Path(__file__).parent / "fixtures" / "ai_selection_seal_vector_v1.json").read_text()
)
POD_PRIVATE = seal.b64url_decode(VECTOR["podPrivateKey"])
POD_PUBLIC = seal.b64url_decode(VECTOR["podPublicKey"])
POD = X25519PrivateKey.from_private_bytes(POD_PRIVATE)
HUSHH_ID = VECTOR["aad"]["hushhId"]
KEY_ID = VECTOR["podKeyId"]
NOW = VECTOR["aad"]["issuedAtMs"]


def _sealed(*, plaintext: dict | None = None, **aad_changes) -> dict:
    """A fresh envelope to the vector's pod, with one property changed."""
    aad = {**VECTOR["aad"], **aad_changes}
    return seal.seal_ai_selection(
        plaintext if plaintext is not None else VECTOR["plaintext"],
        pod_public_key_raw=POD_PUBLIC,
        aad=aad,
    )


def _open(envelope, **overrides):
    kwargs = {
        "pod_private_key": POD,
        "hushh_id": HUSHH_ID,
        "pod_key_id": KEY_ID,
        "now_ms": NOW,
        "floor_issued_at_ms": 0,
        **overrides,
    }
    return seal.open_ai_selection(envelope, **kwargs)


def _refused(envelope, code: str, **overrides) -> None:
    with pytest.raises(seal.AiSelectionRefused) as refused:
        _open(envelope, **overrides)
    assert refused.value.code == code


# -- the golden vector ---------------------------------------------------------------


def test_the_vector_seals_byte_identically_and_opens_to_its_plaintext():
    envelope = seal.seal_ai_selection(
        VECTOR["plaintext"],
        pod_public_key_raw=POD_PUBLIC,
        aad=VECTOR["aad"],
        ephemeral_private_key_raw=seal.b64url_decode(VECTOR["ephemeralPrivateKey"]),
        iv=seal.b64url_decode(VECTOR["iv"]),
    )
    assert envelope == VECTOR["expectedEnvelope"]
    assert canonical_json(envelope) == VECTOR["expectedEnvelopeCanonical"]
    assert seal.aad_bytes(VECTOR["aad"]).decode() == VECTOR["aadCanonical"]
    assert canonical_json(VECTOR["plaintext"]) == VECTOR["plaintextCanonical"]
    # The key the device must derive, step by step, so a mismatch names its step.
    shared = seal.b64url_decode(VECTOR["sharedSecret"])
    epk = seal.b64url_decode(VECTOR["ephemeralPublicKey"])
    assert epk + POD_PUBLIC == seal.b64url_decode(VECTOR["hkdfSalt"])
    assert seal.derive_key(shared, epk, POD_PUBLIC) == seal.b64url_decode(VECTOR["aesKey"])
    # The binding's standard-base64 key is the same 32 bytes the vector seals to.
    assert base64.b64decode(VECTOR["podPublicKeyStandardBase64"]) == POD_PUBLIC

    opened = _open(VECTOR["expectedEnvelope"])
    assert (opened.provider, opened.model, opened.api_key) == (
        "openai",
        None,
        "sk-test-vector-not-a-real-key",
    )
    assert (opened.issued_at_ms, opened.selection_id) == (NOW, VECTOR["aad"]["selectionId"])
    assert "sk-test-vector" not in repr(opened), "the key never appears in a repr"


# -- one negative control per check ----------------------------------------------------


def test_a_tampered_ciphertext_or_aad_is_a_bad_envelope():
    good = VECTOR["expectedEnvelope"]
    ct = bytearray(seal.b64url_decode(good["ct"]))
    ct[0] ^= 1
    _refused({**good, "ct": seal.b64url_encode(bytes(ct))}, seal.BAD_ENVELOPE)
    # Edited AAD fails authentication even when the edit is "valid" for this pod.
    _refused({**good, "aad": {**good["aad"], "issuedAtMs": NOW + 1}}, seal.BAD_ENVELOPE)
    assert _open(good).api_key, "negative control: the untouched envelope opens"


@pytest.mark.parametrize(
    "aad_change",
    [
        {"purpose": "pod_config"},
        {"hushhId": "ha1_someone_else"},
        {"podKeyId": "podk_another_key"},
        {"selectionId": "not-a-uuid"},
        {"selectionId": "6f1c2d3e-4b5a-1c6d-8e7f-9a0b1c2d3e4f"},  # a v1 uuid
    ],
    ids=["purpose", "hushh_id", "pod_key_id", "selection_id", "selection_id_version"],
)
def test_an_envelope_for_another_purpose_owner_or_key_is_refused(aad_change):
    _refused(_sealed(**aad_change), seal.BAD_ENVELOPE)


def test_the_wrong_pod_key_cannot_open_it():
    _refused(
        VECTOR["expectedEnvelope"], seal.BAD_ENVELOPE, pod_private_key=X25519PrivateKey.generate()
    )


@pytest.mark.parametrize(
    "issued_at",
    [NOW - seal.MAX_CLOCK_SKEW_MS - 1, NOW + seal.MAX_CLOCK_SKEW_MS + 1],
    ids=["too_old", "from_the_future"],
)
def test_an_envelope_outside_ten_minutes_is_stale(issued_at):
    _refused(_sealed(issuedAtMs=issued_at), seal.STALE_SELECTION)
    # Negative control: the edge of the window is still fresh.
    edge = NOW - seal.MAX_CLOCK_SKEW_MS if issued_at < NOW else NOW + seal.MAX_CLOCK_SKEW_MS
    assert _open(_sealed(issuedAtMs=edge)).issued_at_ms == edge


def test_a_replay_or_rollback_against_the_stored_selection_is_stale():
    envelope = VECTOR["expectedEnvelope"]
    _refused(envelope, seal.STALE_SELECTION, floor_issued_at_ms=NOW)  # replay
    _refused(envelope, seal.STALE_SELECTION, floor_issued_at_ms=NOW + 1)  # rollback
    assert _open(envelope, floor_issued_at_ms=NOW - 1).issued_at_ms == NOW


def test_an_unsupported_provider_is_named_as_such():
    _refused(
        _sealed(plaintext={**VECTOR["plaintext"], "provider": "anthropic"}),
        seal.PROVIDER_UNSUPPORTED,
    )
    gemini = {**VECTOR["plaintext"], "provider": "gemini", "transport": "developer_api"}
    assert _open(_sealed(plaintext=gemini)).provider == "gemini"


@pytest.mark.parametrize(
    "plaintext_change",
    [
        {"apiKey": ""},
        {"apiKey": "   "},
        {"apiKey": "k" * (seal.MAX_API_KEY_CHARS + 1)},
        {"surprise": "field"},
        {"model": "bad model id"},
        {"transport": "vertex_api_key"},  # not an OpenAI transport
    ],
    ids=["empty_key", "blank_key", "long_key", "unknown_field", "bad_model", "transport"],
)
def test_a_malformed_selection_is_a_bad_envelope(plaintext_change):
    _refused(_sealed(plaintext={**VECTOR["plaintext"], **plaintext_change}), seal.BAD_ENVELOPE)


def test_a_key_at_the_length_limit_is_accepted():
    longest = {**VECTOR["plaintext"], "apiKey": "k" * seal.MAX_API_KEY_CHARS}
    assert len(_open(_sealed(plaintext=longest)).api_key) == seal.MAX_API_KEY_CHARS


@pytest.mark.parametrize(
    "envelope_change",
    [
        {"v": 2},
        {"v": True},
        {"alg": "X25519-HKDF-SHA256-CHACHA20"},
        {"extra": 1},
        {"iv": VECTOR["expectedEnvelope"]["iv"] + "="},  # padded: not canonical
        {"epk": VECTOR["expectedEnvelope"]["epk"][:-2]},  # not 32 bytes
    ],
    ids=["version", "bool_version", "alg", "extra_key", "padded_b64", "short_epk"],
)
def test_a_structurally_wrong_envelope_is_refused_before_any_decryption(envelope_change):
    _refused({**VECTOR["expectedEnvelope"], **envelope_change}, seal.BAD_ENVELOPE)
