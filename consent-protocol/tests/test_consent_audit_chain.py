"""Hermetic tests for the tamper-evident consent-audit receipt chain (AU-9/AU-10).

No DB, no network: the crypto + chain-verification logic is exercised directly,
and the flag-gated, fail-safe mirror hook is tested with an injected fake.
"""

from __future__ import annotations

from hushh_mcp.services import consent_audit_chain_service as cac
from hushh_mcp.services.consent_audit_chain_service import (
    ConsentAuditChainService,
    append_consent_receipt_safe,
)

_SUBJECT = "owner_uid_abc"


def _receipt(seq, prev_hash, **overrides):
    """Build a valid receipt row dict linked to ``prev_hash`` using the module crypto."""
    fields = {
        "event_type": "GRANTED",
        "issued_at_ms": 1000 + seq,
        "agent_id": "agent_kai",
        "scope": "vault.read.finance",
        "request_id": "req1",
        "token_id": "tok1",
        "audit_event_id": None,
        "metadata": {},
    }
    fields.update(overrides)
    payload = cac._canonical_payload(subject_id=_SUBJECT, seq=seq, **fields)
    h = cac._chain_hash(prev_hash, payload)
    return {
        "subject_id": _SUBJECT,
        "seq": seq,
        **fields,
        "prev_hash": prev_hash,
        "hash": h,
        "signature": cac._sign(h),
    }


def _valid_chain(n=3):
    receipts = []
    prev = cac.GENESIS_HASH
    for i in range(1, n + 1):
        r = _receipt(i, prev)
        receipts.append(r)
        prev = r["hash"]
    return receipts


def test_hash_and_sign_are_deterministic():
    payload = cac._canonical_payload(
        subject_id=_SUBJECT,
        seq=1,
        event_type="GRANTED",
        agent_id="a",
        scope="s",
        request_id="r",
        token_id="t",  # noqa: S106
        audit_event_id=None,
        issued_at_ms=1,
        metadata={},
    )
    h1 = cac._chain_hash(cac.GENESIS_HASH, payload)
    h2 = cac._chain_hash(cac.GENESIS_HASH, payload)
    assert h1 == h2
    assert len(h1) == 64
    assert cac._sign(h1) == cac._sign(h1)


def test_verify_ok_for_valid_chain():
    out = ConsentAuditChainService.verify_receipts(_SUBJECT, _valid_chain(3))
    assert out["ok"] is True
    assert out["count"] == 3


def test_verify_detects_tampered_payload():
    receipts = _valid_chain(3)
    # Silently widen a granted scope on receipt 2 without recomputing its hash.
    receipts[1]["scope"] = "vault.read.EVERYTHING"
    out = ConsentAuditChainService.verify_receipts(_SUBJECT, receipts)
    assert out["ok"] is False
    assert out["broken_at_seq"] == 2
    assert out["reason"] == "hash_mismatch"


def test_verify_detects_dropped_receipt():
    receipts = _valid_chain(3)
    del receipts[1]  # drop seq 2 -> sequence jumps 1, 3
    out = ConsentAuditChainService.verify_receipts(_SUBJECT, receipts)
    assert out["ok"] is False
    assert out["reason"] == "seq_gap"


def test_verify_detects_reorder_prev_hash_break():
    receipts = _valid_chain(3)
    receipts[1]["prev_hash"] = cac.GENESIS_HASH  # break the back-link
    out = ConsentAuditChainService.verify_receipts(_SUBJECT, receipts)
    assert out["ok"] is False
    assert out["broken_at_seq"] == 2
    assert out["reason"] == "prev_hash_mismatch"


def test_verify_detects_forged_signature():
    receipts = _valid_chain(2)
    receipts[1]["signature"] = "0" * 64
    out = ConsentAuditChainService.verify_receipts(_SUBJECT, receipts)
    assert out["ok"] is False
    assert out["reason"] == "signature_mismatch"


class _FakeChain:
    def __init__(self):
        self.appends: list[dict] = []

    async def append(self, **kwargs):
        self.appends.append(kwargs)
        return {"id": len(self.appends), "seq": len(self.appends), "hash": "x"}


class _FailingChain:
    async def append(self, **kwargs):
        raise RuntimeError("db down")


async def test_mirror_is_noop_when_flag_off(monkeypatch):
    monkeypatch.delenv("CONSENT_AUDIT_CHAIN_ENABLED", raising=False)

    def _must_not_be_called():
        raise AssertionError("chain getter must not be called when the flag is off")

    monkeypatch.setattr(cac, "get_consent_audit_chain_service", _must_not_be_called)
    # Must not raise, must not touch the chain.
    await append_consent_receipt_safe(subject_id=_SUBJECT, event_type="GRANTED", issued_at_ms=1)


async def test_mirror_appends_when_flag_on(monkeypatch):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "1")
    fake = _FakeChain()
    monkeypatch.setattr(cac, "get_consent_audit_chain_service", lambda: fake)
    await append_consent_receipt_safe(
        subject_id=_SUBJECT,
        event_type="REVOKED",
        issued_at_ms=5,
        agent_id="agent_kai",
        scope="vault.read",
        request_id="r9",
        token_id="t9",  # noqa: S106
        audit_event_id=42,
        metadata={"k": "v"},
    )
    assert len(fake.appends) == 1
    assert fake.appends[0]["event_type"] == "REVOKED"
    assert fake.appends[0]["audit_event_id"] == 42


async def test_mirror_is_fail_safe_when_chain_raises(monkeypatch):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "1")
    monkeypatch.setattr(cac, "get_consent_audit_chain_service", lambda: _FailingChain())
    # The chain append raises internally; the safe wrapper must swallow it.
    await append_consent_receipt_safe(subject_id=_SUBJECT, event_type="GRANTED", issued_at_ms=7)


async def test_mirror_skips_empty_subject(monkeypatch):
    monkeypatch.setenv("CONSENT_AUDIT_CHAIN_ENABLED", "1")

    def _must_not_be_called():
        raise AssertionError("chain getter must not be called for an empty subject")

    monkeypatch.setattr(cac, "get_consent_audit_chain_service", _must_not_be_called)
    await append_consent_receipt_safe(subject_id="", event_type="GRANTED", issued_at_ms=1)
