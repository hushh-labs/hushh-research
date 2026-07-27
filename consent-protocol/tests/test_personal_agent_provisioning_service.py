"""Hermetic tests for personal-agent provision and teardown orchestration.

No DB, no network: the registry and the grant are injected fakes. Verifies the
kill-switch gate, that provisioning derives the HusshID and phone hash, validates
the pod public key, mints the standing read, and records the mapping, and that
teardown writes a retained tombstone before deleting the row (idempotent).
"""

from __future__ import annotations

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import personal_agent_identity_service as ident
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
)
from hushh_mcp.services.pod_connector_keypair_service import generate_pod_keypair

_UID = "firebase_uid_test_123"
_PHONE = "+14255550133"


class FakeRegistry:
    def __init__(self):
        self.upserts: list[dict] = []
        self.tombstones: list[dict] = []
        self.deleted: list[str] = []
        self.rows: dict[str, dict] = {}

    async def upsert(self, **kw):
        self.upserts.append(kw)
        self.rows[kw["user_id"]] = {"hushh_id": kw["hushh_id"], "external_agent_id": None}

    async def get(self, user_id):
        return self.rows.get(user_id)

    async def tombstone(self, **kw):
        self.tombstones.append(kw)

    async def delete(self, user_id):
        self.deleted.append(user_id)
        self.rows.pop(user_id, None)

    async def tombstone_exists(self, hushh_id):
        return any((t.get("hushh_id") or "") == hushh_id for t in self.tombstones)

    def seed_tombstone(self, hushh_id):
        self.tombstones.append({"hushh_id": hushh_id, "status": "deprovision_requested"})


class FakeGrant:
    def __init__(self, *, revoke_raises=False, issue_raises=False, registry=None):
        self.calls: list[str] = []
        self.revokes: list[str] = []
        self._revoke_raises = revoke_raises
        self._issue_raises = issue_raises
        self._registry = registry
        # Registry statuses observed at the moment the mint is attempted, so a
        # test can assert the row was written (as 'provisioning') BEFORE minting.
        self.statuses_at_issue: list[str] | None = None

    async def issue_standing_pkm_read(self, user_id, *, ledger=None):
        if self._registry is not None:
            self.statuses_at_issue = [u["status"] for u in self._registry.upserts]
        if self._issue_raises:
            raise RuntimeError("mint failed")
        self.calls.append(user_id)
        return {
            "token": "HCT:fake",
            "expiresAt": 9_999_999_999_999,
            "scope": "pkm.read",
            "agentId": "personal_agent",
        }

    async def revoke_standing_pkm_read(self, user_id, *, ledger=None):
        if self._revoke_raises:
            raise RuntimeError("ledger down")
        self.revokes.append(user_id)
        return {"revoked": True, "scope": "pkm.read", "agentId": "personal_agent"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


def _svc():
    return PersonalAgentProvisioningService(registry=FakeRegistry(), grant=FakeGrant())


def _pod_key():
    return generate_pod_keypair().public()


async def test_disabled_flag_refuses(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    pod = _pod_key()
    with pytest.raises(PersonalAgentDisabledError):
        await _svc().provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64=pod.public_key_b64,
            pod_key_id=pod.key_id,
        )


async def test_provision_records_mapping():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()

    result = await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    assert result["status"] == "provisioned"
    assert result["hushhId"] == ident.mint_hushh_id(_PHONE)
    assert result["standingReadExpiresAt"] == 9_999_999_999_999
    assert grant.calls == [_UID]

    # Threaded: provisioning (row) -> provisioning (host handle) -> provisioned.
    assert [u["status"] for u in registry.upserts] == [
        "provisioning",
        "provisioning",
        "provisioned",
    ]
    row = registry.upserts[-1]
    assert row["hushh_id"] == ident.mint_hushh_id(_PHONE)
    assert row["phone_e164_hash"] == ident.hash_phone_e164(_PHONE)
    assert row["pod_pubkey"] == pod.public_key_b64
    assert row["status"] == "provisioned"
    # raw phone is never stored
    assert _PHONE not in str(row)


async def test_provision_writes_row_before_minting():
    registry = FakeRegistry()
    grant = FakeGrant(registry=registry)
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()

    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    # At mint time the row already existed as 'provisioning' -> no orphan window.
    assert grant.statuses_at_issue and "provisioned" not in grant.statuses_at_issue


async def test_provision_mint_failure_leaves_no_orphan():
    registry = FakeRegistry()
    grant = FakeGrant(issue_raises=True)
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()

    with pytest.raises(RuntimeError):
        await svc.provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64=pod.public_key_b64,
            pod_key_id=pod.key_id,
        )

    # The row is left visibly stuck in 'provisioning' (never flipped), and no grant
    # was ever successfully issued -> nothing to orphan.
    statuses = [u["status"] for u in registry.upserts]
    assert statuses and "provisioned" not in statuses
    assert grant.calls == []


async def test_provision_uses_generation_zero_for_fresh_phone():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    result = await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )
    assert result["hushhId"] == ident.mint_hushh_id(_PHONE, 0)


async def test_provision_rotates_generation_for_recycled_phone():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    # A prior owner of this phone was torn down: generation-0 HusshID is tombstoned.
    registry.seed_tombstone(ident.mint_hushh_id(_PHONE, 0))

    result = await svc.provision(
        user_id="firebase_uid_test_B",
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    # Rotated to generation 1 -> a fresh HusshID, never the prior owner's.
    assert result["hushhId"] == ident.mint_hushh_id(_PHONE, 1)
    assert result["hushhId"] != ident.mint_hushh_id(_PHONE, 0)


async def test_register_pending_creates_pending_row():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    result = await svc.register_pending(user_id=_UID, phone_e164=_PHONE)

    assert result["status"] == "pending"
    assert result["hushhId"] == ident.mint_hushh_id(_PHONE, 0)
    assert [u["status"] for u in registry.upserts] == ["pending"]
    row = registry.upserts[0]
    assert row["phone_e164_hash"] == ident.hash_phone_e164(_PHONE)
    assert "pod_pubkey" not in row  # no pod at pending
    assert grant.calls == []  # no standing read minted yet
    assert _PHONE not in str(row)  # raw phone never stored


async def test_register_pending_is_idempotent_and_never_downgrades():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    # An already-provisioned agent must not be rewritten back to 'pending'.
    registry.rows[_UID] = {"hushh_id": "ha1_existing", "status": "provisioned"}

    result = await svc.register_pending(user_id=_UID, phone_e164=_PHONE)

    assert result == {"hushhId": "ha1_existing", "status": "provisioned"}
    assert registry.upserts == []  # non-destructive: no write


async def test_register_pending_flag_off_raises(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "0")
    with pytest.raises(PersonalAgentDisabledError):
        await _svc().register_pending(user_id=_UID, phone_e164=_PHONE)


async def test_deprovision_revoke_false_skips_revoke():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    result = await svc.deprovision(user_id=_UID, revoke=False)

    # The cascade already fail-closed the token; no REVOKED event is written.
    assert result["standingReadRevoked"] is False
    assert grant.revokes == []
    # ... but the tombstone + registry-row delete still happen.
    assert registry.deleted == [_UID]
    assert len(registry.tombstones) == 1


async def test_provision_rejects_bad_pod_key():
    with pytest.raises(ValueError):
        await _svc().provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64="not-base64!!",
            pod_key_id="pod-1",
        )


async def test_provision_rejects_bad_phone():
    pod = _pod_key()
    with pytest.raises(ValueError):
        await _svc().provision(
            user_id=_UID,
            phone_e164="not-a-phone",
            pod_public_key_b64=pod.public_key_b64,
            pod_key_id=pod.key_id,
        )


async def test_deprovision_tombstones_then_deletes():
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    result = await svc.deprovision(user_id=_UID)

    assert result["status"] == "deprovisioned"
    assert result["hushhId"] == ident.mint_hushh_id(_PHONE)
    assert result["standingReadRevoked"] is True
    # The standing read is revoked as part of teardown (M2).
    assert grant.revokes == [_UID]
    assert len(registry.tombstones) == 1
    assert registry.tombstones[0]["status"] == "deprovision_requested"
    assert registry.tombstones[0]["hushh_id"] == ident.mint_hushh_id(_PHONE)
    assert registry.deleted == [_UID]


async def test_deprovision_missing_row_is_idempotent():
    svc = _svc()
    result = await svc.deprovision(user_id="never_provisioned")
    assert result["status"] == "deprovisioned"
    assert result["hushhId"] is None


async def test_deprovision_revoke_failure_does_not_block_teardown():
    # Best-effort: a revoke failure is surfaced but teardown still completes.
    registry, grant = FakeRegistry(), FakeGrant(revoke_raises=True)
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    result = await svc.deprovision(user_id=_UID)

    assert result["status"] == "deprovisioned"
    assert result["standingReadRevoked"] is False
    assert registry.deleted == [_UID]


async def test_provision_default_nullbackend_records_no_host_fields():
    # Default backend is NullBackend: provision records NO host fields, so the row
    # keeps its schema NULLs -- behavior identical to the pre-threading Phase-0 stamp.
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    result = await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )
    assert result["backend"] is None
    assert result["externalAgentId"] is None
    assert result["a2aRoute"] is None
    final = registry.upserts[-1]
    assert final.get("external_agent_id") is None
    assert final.get("backend") is None


async def test_provision_threads_backend_handle_into_registry():
    from hushh_mcp.services.compute_backend import BackendHandle, PodSpec

    class _FakeBackend:
        backend_id = "gcp"

        def __init__(self):
            self.provisioned: list[PodSpec] = []

        async def provision(self, spec):
            self.provisioned.append(spec)
            return BackendHandle(
                external_agent_id="one-pod-x",
                a2a_route=f"https://a2a.hushh.ai/u/{spec.hushh_id}",
                status="planned",
                backend="gcp",
                backend_metadata={"project": "p", "tier": "logical"},
            )

        async def deprovision(self, external_agent_id):
            return None

        async def get(self, external_agent_id):
            return None

        def render_deploy_config(self, spec):
            return {}

        async def health(self):
            return True

    registry, grant = FakeRegistry(), FakeGrant()
    backend = _FakeBackend()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=backend)
    pod = _pod_key()
    result = await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )
    # The selected backend was consulted with the derived HusshID + pod public key.
    assert backend.provisioned and backend.provisioned[0].hushh_id == ident.mint_hushh_id(_PHONE)
    assert backend.provisioned[0].pod_pubkey == pod.public_key_b64
    # The host handle is returned and persisted on the registry row.
    assert result["backend"] == "gcp"
    assert result["externalAgentId"] == "one-pod-x"
    assert result["a2aRoute"].startswith("https://a2a.hushh.ai/u/")
    final = registry.upserts[-1]
    assert final["external_agent_id"] == "one-pod-x"
    assert final["backend"] == "gcp"
    assert final["backend_metadata"] == {"project": "p", "tier": "logical"}
