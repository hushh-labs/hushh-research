"""The audit ledger is not signed by the key that mints permissions.

WHY THIS EXISTS
The chain was signed with ``APP_SIGNING_KEY``, which is the key that mints consent
tokens. That is not AU-10 non-repudiation, it is self-attestation: the party with
the most reason to rewrite the record of a permission held the only key that
could. And verification RECOMPUTED the MAC, so no verifier existed anywhere that
could check the ledger without also being able to forge it.

Three properties, and the third is the one most likely to be quietly lost:

1. the chain signs under its OWN namespace, and the module does not reach for
   ``APP_SIGNING_KEY`` at all;
2. verification uses the PUBLIC key, so an auditor can check the chain while
   holding nothing that could write to it;
3. verification is STRICT -- an untagged HMAC signature is REFUSED. Dual-accept
   would let anyone holding the old symmetric key mint a fresh row that verifies,
   handing the separation straight back while every test still passed.
"""

from __future__ import annotations

import ast
import base64
import pathlib

import pytest

from hushh_mcp.consent import token_signing
from hushh_mcp.consent.token_signing import (
    CONSENT_AUDIT,
    CONSENT_TOKENS,
    hmac_signature,
    sign_payload,
    verify_payload,
)
from hushh_mcp.services import consent_audit_chain_service as cac

_AUDIT_SEED = base64.b64encode(bytes(range(32))).decode("ascii")
_TOKEN_SEED = base64.b64encode(bytes(range(32, 64))).decode("ascii")
_HASH = "a" * 64


@pytest.fixture
def _both_namespaces_configured(monkeypatch):
    for ns, seed, kid in (
        (CONSENT_AUDIT, _AUDIT_SEED, "audit-test"),
        (CONSENT_TOKENS, _TOKEN_SEED, "token-test"),
    ):
        monkeypatch.setenv(ns.alg_env, "ed25519")
        monkeypatch.setenv(ns.private_key_env, seed)
        monkeypatch.setenv(ns.kid_env, kid)
    token_signing.reset_caches()
    yield
    token_signing.reset_caches()


# --------------------------------------------------------------------------- #
# 1. Separate key material
# --------------------------------------------------------------------------- #


def test_the_namespaces_share_no_environment_variable():
    """Two namespaces sharing an env name would silently share a key, which is
    the whole defect wearing a type annotation."""
    audit = {
        CONSENT_AUDIT.alg_env,
        CONSENT_AUDIT.private_key_env,
        CONSENT_AUDIT.kid_env,
        CONSENT_AUDIT.public_keys_env,
    }
    tokens = {
        CONSENT_TOKENS.alg_env,
        CONSENT_TOKENS.private_key_env,
        CONSENT_TOKENS.kid_env,
        CONSENT_TOKENS.public_keys_env,
    }
    assert audit.isdisjoint(tokens)


def test_the_chain_module_never_reaches_for_the_token_minting_key():
    """Parsed, not grepped. The module's own docstring explains why the key is
    NOT APP_SIGNING_KEY, so a file-wide grep would fail on the explanation and
    pass on nothing useful. What matters is whether any CODE names it."""
    src = pathlib.Path(cac.__file__).read_text()
    tree = ast.parse(src)
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)} | {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        for alias in node.names
    }
    assert "APP_SIGNING_KEY" not in names


def test_the_two_keys_produce_different_signatures(_both_namespaces_configured):
    audit = sign_payload(_HASH, hmac_key="", namespace=CONSENT_AUDIT)
    token = sign_payload(_HASH, hmac_key="", namespace=CONSENT_TOKENS)
    assert audit != token
    assert audit.startswith("ed25519.")


def test_the_token_key_cannot_sign_something_the_audit_verifier_accepts(
    _both_namespaces_configured,
):
    """The property in one sentence: minting authority is not ledger authority."""
    forged = sign_payload(_HASH, hmac_key="", namespace=CONSENT_TOKENS)
    assert not cac._signature_is_valid(_HASH, forged)


# --------------------------------------------------------------------------- #
# 2. Verification with the public key
# --------------------------------------------------------------------------- #


def test_a_verifier_holding_only_the_public_key_can_check_the_chain(monkeypatch):
    """An auditor must be able to verify while holding nothing that could write.
    Under the old recompute-compare this test was not expressible."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    monkeypatch.setenv(CONSENT_AUDIT.alg_env, "ed25519")
    monkeypatch.setenv(CONSENT_AUDIT.private_key_env, _AUDIT_SEED)
    monkeypatch.setenv(CONSENT_AUDIT.kid_env, "audit-test")
    token_signing.reset_caches()
    signature = cac._sign(_HASH)

    public = (
        Ed25519PrivateKey.from_private_bytes(base64.b64decode(_AUDIT_SEED))
        .public_key()
        .public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    )
    # Now drop the private key entirely and hand the verifier only public material.
    monkeypatch.delenv(CONSENT_AUDIT.private_key_env)
    monkeypatch.setenv(
        CONSENT_AUDIT.public_keys_env,
        '{"audit-test": "%s"}' % base64.b64encode(public).decode("ascii"),
    )
    token_signing.reset_caches()

    assert cac._signature_is_valid(_HASH, signature)
    # ...and that verifier cannot write.
    with pytest.raises(cac.AuditSigningKeyMissing):
        cac._sign(_HASH)
    token_signing.reset_caches()


# --------------------------------------------------------------------------- #
# 3. No downgrade
# --------------------------------------------------------------------------- #


def test_an_hmac_signature_is_refused_even_when_it_is_arithmetically_correct(
    _both_namespaces_configured,
):
    """THE downgrade. Accepting an untagged signature means a holder of the old
    symmetric key can mint a NEW row that verifies, so the separation would be
    real for old rows and imaginary for the ones an attacker cares about."""
    legacy = hmac_signature(_HASH, "whatever-the-old-key-was")
    assert not cac._signature_is_valid(_HASH, legacy)
    # The same signature IS accepted by a namespace that has not gone strict,
    # which is what makes this a property of the audit chain and not of the
    # signer it borrows.
    assert verify_payload(_HASH, legacy, hmac_key="whatever-the-old-key-was")


def test_a_malformed_tag_is_refused_rather_than_falling_through(
    _both_namespaces_configured,
):
    assert not cac._signature_is_valid(_HASH, "ed25519.")
    assert not cac._signature_is_valid(_HASH, "ed25519.unknown-kid.AAAA")


def test_the_chain_refuses_to_sign_rather_than_borrowing_a_key_it_can_find(monkeypatch):
    """LOUD, not silent. A chain that quietly degraded to whatever key was in the
    process would look identical to a properly separated one, which is exactly
    how it came to be signed with the token-minting key for months."""
    monkeypatch.setenv(CONSENT_AUDIT.alg_env, "hmac")
    monkeypatch.delenv(CONSENT_AUDIT.private_key_env, raising=False)
    token_signing.reset_caches()
    with pytest.raises(cac.AuditSigningKeyMissing) as exc:
        cac._sign(_HASH)
    # The message must name the missing secret; an operator reading a log line
    # should not have to read this file to know what to set.
    assert CONSENT_AUDIT.private_key_env in str(exc.value)


def test_a_verifier_only_process_reports_the_chains_own_error(monkeypatch):
    """Configured asymmetric with no key is still a ledger outage, and must not
    land in the generic branch beside a dropped connection: one is "retry later",
    the other is "nothing has been recorded since you deployed"."""
    monkeypatch.setenv(CONSENT_AUDIT.alg_env, "ed25519")
    monkeypatch.delenv(CONSENT_AUDIT.private_key_env, raising=False)
    token_signing.reset_caches()
    with pytest.raises(cac.AuditSigningKeyMissing):
        cac._sign(_HASH)


# --------------------------------------------------------------------------- #
# The two ledgers
# --------------------------------------------------------------------------- #


def test_a_receipt_cannot_be_moved_between_ledgers_without_breaking_its_hash():
    """The discriminator is INSIDE the hash. A `ledger` column that is merely
    beside the hash could be edited to relabel an internal operation as a consent
    event, and the chain would still verify."""
    common = dict(
        subject_id="s",
        seq=1,
        event_type="OPERATION_PERFORMED",
        agent_id="agent_kai",
        scope="vault.owner",
        request_id=None,
        token_id="t",  # noqa: S106
        audit_event_id=None,
        issued_at_ms=1,
        metadata={},
    )
    assert cac._canonical_payload(ledger=cac.LEDGER_CONSENT, **common) != cac._canonical_payload(
        ledger=cac.LEDGER_INTERNAL, **common
    )


def test_internal_events_are_written_into_the_chain():
    """The gap this closed: `insert_internal_event` never reached the chain, so
    the largest class of actions the system takes had no receipt at all. Asserted
    against the source because the write path needs a database."""
    src = (
        pathlib.Path(cac.__file__).resolve().parents[1] / "services" / "consent_db.py"
    ).read_text()
    tree = ast.parse(src)
    fn = next(
        n
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        and n.name == "insert_internal_event"
    )
    body = ast.get_source_segment(src, fn)
    assert "append_consent_receipt_safe" in body
    assert "LEDGER_INTERNAL" in body
    # The fallback path physically writes into `consent_audit`, so those rows must
    # be covered by the chain that claims to cover that table.
    assert "LEDGER_CONSENT if landed_in_primary_ledger" in body


def test_the_chain_has_a_verification_surface_somebody_can_actually_reach():
    """`verify_chain` shipped reachable from nothing: no route, no worker, no
    script. A tamper-evident ledger nobody can verify proves exactly as much as
    no ledger, and looks healthier while doing it."""
    from api.routes.consent import router

    paths = {r.path for r in router.routes}
    assert "/api/consent/receipts/verify" in paths


def test_the_verification_route_answers_only_for_the_authenticated_owner():
    """The subject must not be a parameter. The chain records what was done to
    ONE person's permissions, so a uid in the query string would turn an
    integrity check into a way to enumerate other people's ledgers."""
    import inspect

    from api.routes.consent import verify_consent_receipt_chain

    params = inspect.signature(verify_consent_receipt_chain).parameters
    assert "firebase_uid" in params
    assert not {"user_id", "uid", "subject_id"} & set(params)
