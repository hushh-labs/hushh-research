"""An unsigned consent-audit chain can never be mistaken for a signed one.

Measured on dev 2026-10-06: CONSENT_AUDIT_CHAIN_ENABLED=true, no audit signing
key, `consent_audit_chain_unsigned` logged on every consent event, zero receipts
written. ``GET /api/consent/receipts/verify`` still answered ``ok: true`` with
``verified_with_kid: "hushh-audit-1"``, a default kid naming a key the process
never held. These tests pin the explicit verdict, the strict-lane startup refusal,
and the mint tooling the error message points operators at.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from hushh_mcp.consent import audit_signing, token_signing
from hushh_mcp.consent.token_signing import CONSENT_AUDIT, CONSENT_TOKENS
from hushh_mcp.services import consent_audit_chain_service as cac

_SEED = base64.b64encode(bytes(range(32))).decode("ascii")
_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _clean_audit_env(monkeypatch):
    for name in (
        CONSENT_AUDIT.alg_env,
        CONSENT_AUDIT.private_key_env,
        CONSENT_AUDIT.kid_env,
        CONSENT_AUDIT.public_keys_env,
        "CONSENT_AUDIT_CHAIN_ENABLED",
        "HUSSH_POD_MODE",
    ):
        monkeypatch.delenv(name, raising=False)
    token_signing.reset_caches()
    yield
    token_signing.reset_caches()


def _with_key(monkeypatch, *, alg: str | None = "ed25519") -> None:
    if alg:
        monkeypatch.setenv(CONSENT_AUDIT.alg_env, alg)
    monkeypatch.setenv(CONSENT_AUDIT.private_key_env, _SEED)
    monkeypatch.setenv(CONSENT_AUDIT.kid_env, "audit-test")
    token_signing.reset_caches()


def _chain(subject: str, n: int) -> list[dict]:
    receipts, prev = [], cac.GENESIS_HASH
    for seq in range(1, n + 1):
        fields = dict(
            event_type="CONSENT_GRANTED",
            agent_id="personal_agent",
            scope="pkm.read",
            request_id=None,
            token_id=f"t{seq}",
            audit_event_id=seq,
            issued_at_ms=seq,
            metadata={},
        )
        payload = cac._canonical_payload(
            subject_id=subject, ledger=cac.LEDGER_CONSENT, seq=seq, **fields
        )
        digest = cac._chain_hash(prev, payload)
        receipts.append(
            {
                **fields,
                "ledger": cac.LEDGER_CONSENT,
                "seq": seq,
                "prev_hash": prev,
                "hash": digest,
                "signature": cac._sign(digest),
            }
        )
        prev = digest
    return receipts


# --------------------------------------------------------------------------- #
# The verdict
# --------------------------------------------------------------------------- #


def test_an_empty_chain_on_a_keyless_lane_says_unsigned_and_why(monkeypatch):
    """THE dev state. ``ok`` stays true (nothing is broken), and the response says
    in words that nothing is signed and that the missing key is the reason."""
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    result = cac.ConsentAuditChainService.verify_receipts("owner", [])
    assert result["ok"] is True
    assert result["signed"] is False
    assert result["unsigned_reason"] == audit_signing.REASON_SIGNING_KEY_MISSING
    assert result["signing_key_configured"] is False
    assert result["chain_enabled"] is True
    # Never the namespace's default kid: no key held, no receipt verified.
    assert result["verified_with_kid"] is None
    assert result["signing_kid"] is None


def test_an_empty_chain_with_the_chain_off_says_so():
    result = cac.ConsentAuditChainService.verify_receipts("owner", [])
    assert result["signed"] is False
    assert result["unsigned_reason"] == audit_signing.REASON_CHAIN_DISABLED


def test_an_empty_chain_with_a_key_is_still_not_signed(monkeypatch):
    """Nothing written is nothing signed, even when the key is ready."""
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    _with_key(monkeypatch)
    result = cac.ConsentAuditChainService.verify_receipts("owner", [])
    assert result["signed"] is False
    assert result["unsigned_reason"] == audit_signing.REASON_NO_RECEIPTS
    assert result["signing_key_configured"] is True


def test_a_verified_chain_is_signed_and_names_the_kid_that_signed_it(monkeypatch):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    _with_key(monkeypatch)
    result = cac.ConsentAuditChainService.verify_receipts("owner", _chain("owner", 3))
    assert result["ok"] is True and result["signed"] is True
    assert result["verified_with_kid"] == "audit-test"
    assert result["verified_with_kids"] == ["audit-test"]
    assert "unsigned_reason" not in result


def test_a_tampered_chain_is_never_reported_signed(monkeypatch):
    _with_key(monkeypatch)
    receipts = _chain("owner", 2)
    receipts[1]["scope"] = "vault.owner"
    result = cac.ConsentAuditChainService.verify_receipts("owner", receipts)
    assert result["ok"] is False and result["signed"] is False
    assert result["unsigned_reason"] == audit_signing.REASON_VERIFICATION_FAILED
    assert result["verified_with_kid"] is None


async def test_a_regressed_head_is_reported_unsigned(monkeypatch):
    _with_key(monkeypatch)
    receipts = _chain("owner", 2)
    service = cac.ConsentAuditChainService()

    async def _list(*_a, **_k):
        return receipts

    monkeypatch.setattr(service, "list_receipts", _list)
    result = await service.verify_chain("owner", expected_head_seq=5)
    assert result["reason"] == "head_regressed"
    assert result["signed"] is False


def test_a_present_key_signs_even_when_the_alg_flag_is_unset(monkeypatch):
    """Key present means sign. Before, a minted key with no ALG env made every
    append raise "key missing", so the startup guard and the signer disagreed."""
    _with_key(monkeypatch, alg=None)
    assert cac._sign("a" * 64).startswith("ed25519.audit-test.")


# --------------------------------------------------------------------------- #
# Strict lanes refuse to start
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("lane", ["uat", "production", "UAT"])
def test_a_strict_lane_with_the_chain_on_and_no_key_refuses_to_start(monkeypatch, lane):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    with pytest.raises(audit_signing.AuditSigningNotConfigured) as exc:
        audit_signing.enforce_audit_signing_at_startup(lane)
    assert CONSENT_AUDIT.private_key_env in str(exc.value)
    assert "--namespace audit" in str(exc.value)


def test_a_malformed_key_on_a_strict_lane_refuses_to_start(monkeypatch):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    monkeypatch.setenv(CONSENT_AUDIT.private_key_env, "not-a-seed")
    token_signing.reset_caches()
    with pytest.raises(audit_signing.AuditSigningNotConfigured):
        audit_signing.enforce_audit_signing_at_startup("production")


def _published(kid: str, seed_bytes: bytes) -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    raw = (
        Ed25519PrivateKey.from_private_bytes(seed_bytes)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    return json.dumps({kid: base64.b64encode(raw).decode("ascii")})


@pytest.mark.parametrize(
    ("published", "kid_env", "expected"),
    [
        # Malformed map: every /api/consent/receipts/verify call would 500.
        ("{not json", "audit-test", CONSENT_AUDIT.public_keys_env),
        # Seed mounted with no KID env: signs under the namespace default, which
        # no verifier holding only the published map can check.
        (_published("audit-test", bytes(range(32))), None, CONSENT_AUDIT.kid_env),
        # Right kid, wrong half of the pair: the hub fails its own receipts.
        (_published("audit-test", bytes(32)), "audit-test", "is not the public half"),
    ],
    ids=["malformed_map", "kid_not_published", "mismatched_pair"],
)
def test_a_key_verifiers_cannot_check_refuses_a_strict_lane(
    monkeypatch, published, kid_env, expected
):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    _with_key(monkeypatch)
    if kid_env is None:
        monkeypatch.delenv(CONSENT_AUDIT.kid_env)
    monkeypatch.setenv(CONSENT_AUDIT.public_keys_env, published)
    token_signing.reset_caches()
    with pytest.raises(audit_signing.AuditSigningNotConfigured) as exc:
        audit_signing.enforce_audit_signing_at_startup("uat")
    assert expected in str(exc.value)


def test_a_matching_published_map_starts_a_strict_lane(monkeypatch):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    _with_key(monkeypatch)
    monkeypatch.setenv(CONSENT_AUDIT.public_keys_env, _published("audit-test", bytes(range(32))))
    token_signing.reset_caches()
    audit_signing.enforce_audit_signing_at_startup("production")


def test_a_malformed_row_in_a_failed_walk_stays_a_clean_verification_failure():
    """A row the walk already rejected must not turn the verdict into a KeyError."""
    verdict = audit_signing.annotate_verification(
        {"ok": False, "reason": "hash_mismatch"}, [{"seq": 1, "hash": "x"}]
    )
    assert verdict["signed"] is False
    assert verdict["unsigned_reason"] == audit_signing.REASON_VERIFICATION_FAILED
    assert verdict["verified_with_kids"] == []


def test_dev_warns_loudly_and_keeps_serving(monkeypatch, caplog):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    with caplog.at_level(logging.ERROR, logger=audit_signing.__name__):
        audit_signing.enforce_audit_signing_at_startup("dev")
    assert "consent_audit_signing.unsigned" in caplog.text


@pytest.mark.parametrize(
    "setup",
    ["chain_off", "key_present", "pod"],
)
def test_the_guard_stays_out_of_the_way_when_nothing_is_wrong(monkeypatch, setup):
    """Chain off means no receipts and no consumer for the key: refusing to boot
    there would block every uat/production deploy for nothing. A pod never holds
    the audit private key by design."""
    if setup != "chain_off":
        monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "true")
    if setup == "key_present":
        _with_key(monkeypatch)
    if setup == "pod":
        monkeypatch.setenv("HUSSH_POD_MODE", "1")
    audit_signing.enforce_audit_signing_at_startup("production")


def test_process_startup_actually_runs_the_guard():
    """Not an AST claim: a real interpreter importing the config the server
    imports must exit non-zero on a misconfigured strict lane."""
    env = {
        k: v for k, v in os.environ.items() if not k.startswith(("CONSENT_", "HUSSH_POD", "KMS_"))
    }
    env.update(
        ENVIRONMENT="uat",
        CONSENT_AUDIT_CHAIN_ENABLED="true",
        APP_SIGNING_KEY="x" * 40,
        VAULT_DATA_KEY="0" * 64,
    )
    proc = subprocess.run(  # noqa: S603 - fixed argv, test-local input
        [sys.executable, "-c", "import hushh_mcp.config"],
        cwd=_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "Refusing to start (uat)" in proc.stderr


# --------------------------------------------------------------------------- #
# The remedy the error message names exists and matches the deploy wiring
# --------------------------------------------------------------------------- #


def test_the_mint_script_can_mint_the_audit_keypair_under_the_exact_env_names():
    sys.path.insert(0, str(_ROOT / "scripts" / "ops"))
    try:
        import mint_consent_ed25519_key as mint
    finally:
        sys.path.pop(0)
    priv, pub, kid = mint.NAMESPACES["audit"]
    assert (priv, pub) == (CONSENT_AUDIT.private_key_env, CONSENT_AUDIT.public_keys_env)
    assert mint.NAMESPACES["consent"][:2] == (
        CONSENT_TOKENS.private_key_env,
        CONSENT_TOKENS.public_keys_env,
    )
    deploy = (_ROOT.parent / "scripts" / "deploy" / "backend-deploy.sh").read_text("utf-8")
    # A kid mismatch verifies at the hub and fails in every other verifier.
    assert f'consent_audit_ed25519_kid="{kid}"' in deploy
