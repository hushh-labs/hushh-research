"""Hermetic tests for personal-agent provision and teardown orchestration.

No DB, no network: the registry and the grant are injected fakes. Verifies the
kill-switch gate, that provisioning derives the HusshID and phone hash, validates
the pod public key, mints the standing read, and records the mapping, and that
teardown preserves retained resources until erasure is verified.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services import personal_agent_identity_service as ident
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.personal_agent_provisioning_service import (
    FEED_EVENT_FAILED,
    PersonalAgentProvisioningService,
    user_safe_failure_reason,
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


async def test_tombstone_rejection_prevents_provider_and_grant_side_effects():
    import asyncpg

    registry, grant = FakeRegistry(), FakeGrant()
    registry.upsert = AsyncMock(side_effect=asyncpg.CheckViolationError("account deleted"))
    backend, substrate = Mock(), Mock()
    service = PersonalAgentProvisioningService(
        registry=registry, grant=grant, backend=backend, substrate=substrate
    )
    pod = _pod_key()
    with pytest.raises(asyncpg.CheckViolationError):
        await service.provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64=pod.public_key_b64,
            pod_key_id=pod.key_id,
        )
    assert backend.mock_calls == []
    assert substrate.mock_calls == []
    assert grant.calls == []
    assert grant.revokes == []


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


async def test_deprovision_refuses_retained_resources_even_with_revoke_false(monkeypatch):
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )

    def refuse(self, uid):
        assert uid == _UID
        raise PersonalAgentDeprovisioningRequiredError("retained resources")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        await svc.deprovision(user_id=_UID, revoke=False)
    assert grant.revokes == []
    assert registry.deleted == []
    assert registry.tombstones == []
    assert _UID in registry.rows


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


async def test_deprovision_refusal_preserves_registry_and_tombstones(monkeypatch):
    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )

    def refuse(self, uid):
        assert uid == _UID
        raise PersonalAgentDeprovisioningRequiredError("retained resources")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        await svc.deprovision(user_id=_UID, revoke=False)
    assert grant.revokes == []
    assert registry.deleted == []
    assert registry.tombstones == []
    assert _UID in registry.rows


async def test_deprovision_missing_row_is_idempotent(monkeypatch):
    svc = _svc()
    from hushh_mcp.services.account_service import AccountService

    observed = []
    monkeypatch.setattr(
        AccountService,
        "assert_personal_agent_external_resources_absent",
        lambda self, uid: observed.append(uid),
    )
    result = await svc.deprovision(user_id="never_provisioned")
    assert observed == ["never_provisioned"]
    assert result["status"] == "unprovisioned"
    assert result["noOp"] is True
    assert result["standingReadRevoked"] is False


async def test_deprovision_refusal_never_attempts_revocation(monkeypatch):
    # Revocation cannot run before erasure preflight succeeds.
    registry, grant = FakeRegistry(), FakeGrant(revoke_raises=True)
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)
    pod = _pod_key()
    await svc.provision(
        user_id=_UID,
        phone_e164=_PHONE,
        pod_public_key_b64=pod.public_key_b64,
        pod_key_id=pod.key_id,
    )

    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )

    def refuse(self, uid):
        assert uid == _UID
        raise PersonalAgentDeprovisioningRequiredError("retained resources")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        await svc.deprovision(user_id=_UID, revoke=False)
    assert grant.revokes == []
    assert registry.deleted == []
    assert registry.tombstones == []
    assert _UID in registry.rows


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


# --- Orphan-address persistence (delete-order V2 hardening) ----------------------
# A host that could not be torn down must stay NAMEABLE after the registry row is
# gone, so a later reclaim sweep can find and delete the billing service. The
# tombstone carries the address only when there is a real orphan.


class _RaisingBackend:
    backend_id = "gcp"

    async def deprovision(self, external_agent_id):
        raise RuntimeError("cannot reach the host's project")

    async def get(self, external_agent_id):
        return None

    def render_deploy_config(self, spec):
        return {}

    async def health(self):
        return True


async def test_deprovision_refusal_preserves_unreachable_host_coordinates(monkeypatch):
    registry, grant = FakeRegistry(), FakeGrant()
    registry.rows[_UID] = {
        "hushh_id": "ha1_orphan",
        "external_agent_id": "one-pod-orphan",
        "user_cloud_project": "cust-proj-1",
        "user_cloud_region": "us-central1",
    }
    svc = PersonalAgentProvisioningService(
        registry=registry, grant=grant, backend=_RaisingBackend()
    )

    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )

    def refuse(self, uid):
        assert uid == _UID
        raise PersonalAgentDeprovisioningRequiredError("retained resources")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        await svc.deprovision(user_id=_UID, revoke=False)
    assert grant.revokes == []
    assert registry.deleted == []
    assert registry.tombstones == []
    assert _UID in registry.rows


async def test_deprovision_refuses_ambiguous_missing_host_metadata(monkeypatch):
    registry, grant = FakeRegistry(), FakeGrant()
    # Missing external_agent_id alone cannot prove there is nothing to erase.
    registry.rows[_UID] = {"hushh_id": "ha1_clean", "external_agent_id": None}
    svc = PersonalAgentProvisioningService(registry=registry, grant=grant)

    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )

    def refuse(self, uid):
        assert uid == _UID
        raise PersonalAgentDeprovisioningRequiredError("retained resources")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        await svc.deprovision(user_id=_UID, revoke=False)
    assert grant.revokes == []
    assert registry.deleted == []
    assert registry.tombstones == []
    assert _UID in registry.rows


# --- Boot-failure classification (graceful degradation) ---------------------------
# The platform's own verdict that a pod's revision failed to start is a different
# truth from a slow boot or a typo, and it gets its own closed-vocabulary reason so
# the feed can say so without ever carrying the exception's text.


async def test_a_pod_boot_failure_records_failed_with_its_own_reason(monkeypatch):
    from hushh_mcp.services.compute_backend import PodBootFailedError

    events: list[dict] = []

    async def _capture(**kw):
        events.append(kw)

    monkeypatch.setattr(
        "hushh_mcp.services.personal_agent_provisioning_service."
        "record_provisioning_feed_event_safe",
        _capture,
    )

    boom = PodBootFailedError("pod one-pod-x failed to start: exec format error")

    class _BootFailingBackend:
        backend_id = "gcp"

        async def provision(self, spec):  # noqa: ARG002
            raise boom

        async def deprovision(self, external_agent_id):
            return None

        async def get(self, external_agent_id):
            return None

        def render_deploy_config(self, spec):
            return {}

        async def health(self):
            return True

    registry, grant = FakeRegistry(), FakeGrant()
    svc = PersonalAgentProvisioningService(
        registry=registry, grant=grant, backend=_BootFailingBackend()
    )
    pod = _pod_key()

    with pytest.raises(PodBootFailedError) as excinfo:
        await svc.provision(
            user_id=_UID,
            phone_e164=_PHONE,
            pod_public_key_b64=pod.public_key_b64,
            pod_key_id=pod.key_id,
        )

    # Re-raised UNCHANGED -- the feed is a projection, never an error handler.
    assert excinfo.value is boom
    # The row lands at 'provisioning_failed', legible to the sweep and the owner.
    assert [u["status"] for u in registry.upserts][-1] == "provisioning_failed"
    # And the feed line carries the boot failure's OWN reason, not 'temporary_issue'.
    failed = [e for e in events if e["event_type"] == FEED_EVENT_FAILED]
    assert len(failed) == 1
    assert failed[0]["reason"] == "pod_boot_failed"


def test_user_safe_failure_reason_vocabulary():
    from hushh_mcp.services.compute_backend import PodBootFailedError

    # The new branch, and the two pre-existing mappings it must not disturb. The
    # literals matter: these are the wire values the webapp renderer branches on.
    assert user_safe_failure_reason(PodBootFailedError("platform verdict")) == "pod_boot_failed"
    assert user_safe_failure_reason(ValueError("bad input")) == "invalid_details"
    assert user_safe_failure_reason(RuntimeError("transient")) == "temporary_issue"
