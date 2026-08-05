"""Asymmetric consent tokens: same wire format, forging power stays at the hub.

The properties that make the pod era possible, each pinned:

* the payload is BYTE-IDENTICAL across algorithms -- no new field, so every
  deployed parser keeps parsing;
* HMAC issuance (the default) is byte-identical to the historic signer;
* an Ed25519 token verifies with the PUBLIC key alone -- a process holding
  only public material (a pod) validates authenticity and cannot issue;
* a tagged signature never falls through to HMAC, an unknown kid is invalid,
  and a verifier without the public keys REJECTS (what an old binary does);
* golden vectors: Ed25519 is deterministic, so the committed signatures are
  stable expected outputs -- a codec change that alters them is a wire break.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import pytest

from hushh_mcp.consent import token_signing
from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.consent.token_signing import (
    hmac_signature,
    reset_caches,
    sign_payload,
    verify_payload,
)
from hushh_mcp.types import AgentID, UserID

VECTORS = json.loads(
    (Path(__file__).parent / "fixtures" / "hct_ed25519_golden_vectors.json").read_text()
)
TEST_SEED_B64 = VECTORS["test_seed_b64"]
TEST_PUBLIC_B64 = VECTORS["public_key_b64"]
TEST_KID = VECTORS["kid"]

HMAC_KEY = "unit-test-signing-key-32-characters!"


@pytest.fixture(autouse=True)
def _clean_signing_env(monkeypatch: pytest.MonkeyPatch):
    for env in (
        token_signing.SIGNING_ALG_ENV,
        token_signing.PRIVATE_KEY_ENV,
        token_signing.KID_ENV,
        token_signing.PUBLIC_KEYS_ENV,
    ):
        monkeypatch.delenv(env, raising=False)
    reset_caches()
    yield
    reset_caches()


def _configure_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(token_signing.SIGNING_ALG_ENV, "ed25519")
    monkeypatch.setenv(token_signing.PRIVATE_KEY_ENV, TEST_SEED_B64)
    monkeypatch.setenv(token_signing.KID_ENV, TEST_KID)
    reset_caches()


def _configure_verifier_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(token_signing.PUBLIC_KEYS_ENV, json.dumps({TEST_KID: TEST_PUBLIC_B64}))
    reset_caches()


# --- wire-format invariants -----------------------------------------------------------


def test_default_issuance_is_byte_identical_to_the_historic_hmac():
    payload = "u|a|vault.owner|1|2"
    assert sign_payload(payload, hmac_key=HMAC_KEY) == hmac_signature(payload, HMAC_KEY)


def test_the_payload_is_identical_across_algorithms(monkeypatch: pytest.MonkeyPatch):
    now_ms = int(time.time() * 1000)
    hmac_token = issue_token(
        UserID("user_x"), AgentID("agent_one"), "vault.owner", expires_at_ms=now_ms + 60_000
    )
    _configure_issuer(monkeypatch)
    ed_token = issue_token(
        UserID("user_x"), AgentID("agent_one"), "vault.owner", expires_at_ms=now_ms + 60_000
    )

    def payload_segment(token: str) -> str:
        return token.split(":", 1)[1].split(".", 1)[0]

    hmac_payload = base64.urlsafe_b64decode(payload_segment(hmac_token.token))
    ed_payload = base64.urlsafe_b64decode(payload_segment(ed_token.token))
    # Same fields, same order, same separators; only issued_at can differ.
    assert hmac_payload.split(b"|")[:3] == ed_payload.split(b"|")[:3]
    assert len(hmac_payload.split(b"|")) == len(ed_payload.split(b"|")) == 5


# --- the asymmetric property ----------------------------------------------------------


def test_an_ed25519_token_verifies_with_only_the_public_key(monkeypatch: pytest.MonkeyPatch):
    _configure_issuer(monkeypatch)
    token = issue_token(UserID("user_pod"), AgentID("agent_one"), "vault.owner")

    # Now become the pod: no private key, no alg flag -- only public material.
    monkeypatch.delenv(token_signing.SIGNING_ALG_ENV, raising=False)
    monkeypatch.delenv(token_signing.PRIVATE_KEY_ENV, raising=False)
    _configure_verifier_only(monkeypatch)

    valid, reason, parsed = validate_token(token.token, expected_scope="vault.owner")
    assert valid is True, reason
    assert parsed is not None and str(parsed.user_id) == "user_pod"


def test_a_verifier_only_process_cannot_issue(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(token_signing.SIGNING_ALG_ENV, "ed25519")
    _configure_verifier_only(monkeypatch)
    with pytest.raises(RuntimeError):
        issue_token(UserID("user_pod"), AgentID("agent_one"), "vault.owner")


def test_commercial_tokens_carry_the_flag_through_ed25519(monkeypatch: pytest.MonkeyPatch):
    _configure_issuer(monkeypatch)
    token = issue_token(UserID("user_c"), AgentID("agent_one"), "cap.one.invoke", commercial=True)
    valid, reason, parsed = validate_token(token.token, require_commercial=True)
    assert valid is True, reason
    assert parsed is not None and parsed.commercial is True


# --- fail-closed everywhere -----------------------------------------------------------


def test_a_tagged_signature_never_falls_through_to_hmac():
    payload = "u|a|vault.owner|1|2"
    forged = f"ed25519.{TEST_KID}.{base64.urlsafe_b64encode(b'x' * 64).decode().rstrip('=')}"
    assert verify_payload(payload, forged, hmac_key=HMAC_KEY) is False


def test_an_unknown_kid_is_invalid(monkeypatch: pytest.MonkeyPatch):
    _configure_issuer(monkeypatch)
    token = issue_token(UserID("user_k"), AgentID("agent_one"), "vault.owner")
    # Verifier configured with a DIFFERENT kid namespace.
    monkeypatch.delenv(token_signing.PRIVATE_KEY_ENV, raising=False)
    monkeypatch.delenv(token_signing.SIGNING_ALG_ENV, raising=False)
    monkeypatch.setenv(
        token_signing.PUBLIC_KEYS_ENV, json.dumps({"some-other-kid": TEST_PUBLIC_B64})
    )
    reset_caches()
    valid, reason, _ = validate_token(token.token)
    assert valid is False and reason == "Invalid signature"


def test_an_unconfigured_verifier_rejects_like_an_old_binary(monkeypatch: pytest.MonkeyPatch):
    """The rollout-safety property: a process that knows nothing of Ed25519 keys
    (the old deployed verifier) REJECTS a tagged token rather than accepting it."""
    _configure_issuer(monkeypatch)
    token = issue_token(UserID("user_o"), AgentID("agent_one"), "vault.owner")
    for env in (
        token_signing.SIGNING_ALG_ENV,
        token_signing.PRIVATE_KEY_ENV,
        token_signing.PUBLIC_KEYS_ENV,
    ):
        monkeypatch.delenv(env, raising=False)
    reset_caches()
    valid, reason, _ = validate_token(token.token)
    assert valid is False and reason == "Invalid signature"


def test_hmac_tokens_keep_validating_while_asymmetric_keys_are_configured(
    monkeypatch: pytest.MonkeyPatch,
):
    """Verify-both: the rollout deploys keys everywhere BEFORE flipping issuance,
    and every already-issued HMAC token must keep working throughout."""
    token = issue_token(UserID("user_h"), AgentID("agent_one"), "vault.owner")
    _configure_verifier_only(monkeypatch)
    valid, reason, _ = validate_token(token.token)
    assert valid is True, reason


# --- golden vectors -------------------------------------------------------------------


def test_every_golden_vector_verifies_and_tampering_breaks_it(
    monkeypatch: pytest.MonkeyPatch,
):
    _configure_verifier_only(monkeypatch)
    for vector in VECTORS["vectors"]:
        assert verify_payload(vector["payload"], vector["signature"], hmac_key=HMAC_KEY) is True
        tampered = vector["payload"].replace("user_", "usur_")
        assert verify_payload(tampered, vector["signature"], hmac_key=HMAC_KEY) is False


def test_the_signer_reproduces_the_golden_signatures(monkeypatch: pytest.MonkeyPatch):
    """Ed25519 is deterministic: same seed + payload -> same signature. A codec
    change that alters these is a wire-format break, caught here."""
    _configure_issuer(monkeypatch)
    monkeypatch.setenv(token_signing.KID_ENV, TEST_KID)
    reset_caches()
    for vector in VECTORS["vectors"]:
        assert sign_payload(vector["payload"], hmac_key=HMAC_KEY) == vector["signature"]
