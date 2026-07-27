"""Hermetic tests for the pod-access audit guard (owner-verified read + receipt).

Verifies the fail-closed ownership gate in front of the per-user pod's standing
read: an allow only when the caller is the provisioned owner reading with the pod
agent id and a read scope; a deny (with a DENIED receipt) on every mismatch —
wrong agent id, wrong scope, no/half-provisioned registry row, or a HusshID that
belongs to a different owner. No DB, no network: registry + ledger are injected.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.personal_agent_grant_service import (
    PERSONAL_AGENT_ID,
    PersonalAgentDisabledError,
)
from hushh_mcp.services.pod_access_audit import (
    ACTION_ALLOWED,
    ACTION_DENIED,
    PodAccessAuditService,
    PodAccessDenied,
)

_UID = "owner_uid_123"
_HUSHH = "e2eowner01"


class FakeLedger:
    def __init__(self):
        self.events: list[dict] = []

    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        return len(self.events)


class FakeRegistry:
    def __init__(self, row):
        self._row = row

    async def get(self, user_id):
        return self._row


def _provisioned_row(user_id=_UID, hushh_id=_HUSHH, status="provisioned"):
    return {"user_id": user_id, "hushh_id": hushh_id, "status": status}


@pytest.fixture(autouse=True)
def _flag_on(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    yield


async def test_disabled_flag_refuses(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=FakeLedger())
    with pytest.raises(PersonalAgentDisabledError):
        await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read")


async def test_missing_user_rejected():
    svc = PodAccessAuditService(registry=FakeRegistry(None), ledger=FakeLedger())
    with pytest.raises(ValueError):
        await svc.authorize_owner_read(user_id="", agent_id=PERSONAL_AGENT_ID, scope="pkm.read")


async def test_owner_read_allowed_and_receipted():
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    out = await svc.authorize_owner_read(
        user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read", hushh_id=_HUSHH
    )
    assert out["authorized"] is True and out["hushhId"] == _HUSHH
    assert len(ledger.events) == 1
    ev = ledger.events[0]
    assert ev["action"] == ACTION_ALLOWED
    assert ev["agent_id"] == PERSONAL_AGENT_ID
    assert ev["user_id"] == _UID
    assert ev["metadata"]["decision"] == "allow"
    assert ev["metadata"]["audit_kind"] == "personal_agent_pod_access"


async def test_owner_read_allowed_without_explicit_hushh_id():
    # hushh_id is optional; when omitted it is resolved (and receipted) from the row.
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    out = await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="attr.identity.email")
    assert out["authorized"] is True and out["hushhId"] == _HUSHH
    assert ledger.events[0]["metadata"]["hushh_id"] == _HUSHH


async def test_wrong_agent_id_denied_with_receipt():
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    with pytest.raises(PodAccessDenied):
        await svc.authorize_owner_read(user_id=_UID, agent_id="agent_kai", scope="pkm.read")
    assert ledger.events[0]["action"] == ACTION_DENIED
    assert "agent_id_not_pod" in ledger.events[0]["metadata"]["reasons"]


async def test_non_read_scope_denied():
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    with pytest.raises(PodAccessDenied):
        await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="vault.owner")
    assert "scope_not_read" in ledger.events[0]["metadata"]["reasons"]


async def test_no_registry_row_denied():
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(None), ledger=ledger)
    with pytest.raises(PodAccessDenied):
        await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read")
    assert "no_registry_row" in ledger.events[0]["metadata"]["reasons"]


async def test_not_provisioned_denied():
    ledger = FakeLedger()
    svc = PodAccessAuditService(
        registry=FakeRegistry(_provisioned_row(status="provisioning")), ledger=ledger
    )
    with pytest.raises(PodAccessDenied):
        await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read")
    assert "pod_not_provisioned" in ledger.events[0]["metadata"]["reasons"]


async def test_hushh_id_mismatch_denied():
    # A valid token for this owner cannot be redirected to read a different HusshID.
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    with pytest.raises(PodAccessDenied):
        await svc.authorize_owner_read(
            user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read", hushh_id="someoneelse99"
        )
    assert "hushh_id_mismatch" in ledger.events[0]["metadata"]["reasons"]


async def test_receipt_failure_does_not_flip_allow():
    # The receipt is best-effort: a ledger error is swallowed, the allow still stands.
    class BoomLedger:
        async def insert_event(self, **kwargs):
            raise RuntimeError("ledger down")

    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=BoomLedger())
    out = await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read")
    assert out["authorized"] is True


async def test_registry_read_failure_fails_closed_and_audited():
    # A DB blip on the registry read must DENY (fail-closed) AND write a receipt —
    # never a silent, unaudited failure.
    class BoomRegistry:
        async def get(self, user_id):
            raise RuntimeError("registry down")

    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=BoomRegistry(), ledger=ledger)
    with pytest.raises(PodAccessDenied):
        await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="pkm.read")
    assert ledger.events and ledger.events[0]["action"] == ACTION_DENIED
    assert "registry_unavailable" in ledger.events[0]["metadata"]["reasons"]


async def test_agent_id_whitespace_normalized_still_allows():
    # Incidental whitespace on the agent id must not deny a legitimate owner
    # (normalization never *grants* — the exact-match check still holds otherwise).
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    out = await svc.authorize_owner_read(
        user_id=_UID, agent_id=f"  {PERSONAL_AGENT_ID}  ", scope="pkm.read"
    )
    assert out["authorized"] is True


async def test_scope_case_insensitive_read():
    # An upper/mixed-case read scope is still a read scope.
    ledger = FakeLedger()
    svc = PodAccessAuditService(registry=FakeRegistry(_provisioned_row()), ledger=ledger)
    out = await svc.authorize_owner_read(user_id=_UID, agent_id=PERSONAL_AGENT_ID, scope="PKM.READ")
    assert out["authorized"] is True
