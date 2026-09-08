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
from tests.personal_agent_registry_fake import ProvisionAdmissionFake

_UID = "firebase_uid_test_123"
_PHONE = "+14255550133"


class FakeRegistry(ProvisionAdmissionFake):
    def __init__(self):
        self.upserts: list[dict] = []
        self.tombstones: list[dict] = []
        self.deleted: list[str] = []
        self.rows: dict[str, dict] = {}

    async def upsert(self, **kw):
        self.upserts.append(kw)
        row = self.rows.setdefault(kw["user_id"], {"external_agent_id": None})
        row.update({k: v for k, v in kw.items() if v is not None})

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

    assert registry.upserts[0]["status"] == "provisioning"
    assert registry.upserts[-1]["status"] == "provisioned"
    row = registry.rows[_UID]
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
    registry.reserve_erasure = AsyncMock()
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        await svc.deprovision(user_id=_UID, revoke=False)
    registry.reserve_erasure.assert_awaited_once_with(user_id=_UID)
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
    assert final["backend_metadata"]["project"] == "p"
    assert final["backend_metadata"]["tier"] == "logical"
    assert final["backend_metadata"]["provisionAttempt"]["phase"] == "provisioned"


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
    assert [u["status"] for u in registry.upserts][-1] == "suspended"
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


@pytest.mark.parametrize(
    "refusal",
    [
        None,
        "foreign_owner",
        "held_upgrade",
        "changed_reservation",
        "old_generation",
        "changed_image",
        "adopted_engine",
    ],
)
async def test_deprovision_fences_only_the_reserved_observed_owner(monkeypatch, refusal):
    from types import SimpleNamespace

    from hushh_mcp.services import pod_migration_transport
    from hushh_mcp.services.account_service import (
        AccountService,
        PersonalAgentDeprovisioningRequiredError,
    )

    registry, grant = FakeRegistry(), FakeGrant()
    initial_image = "registry.example/pod@sha256:" + "a" * 64
    snapshot = {
        "user_id": _UID,
        "hushh_id": "ha1_owner",
        "status": "provisioned",
        "backend": "fake",
        "external_agent_id": "pod-one",
        "backend_metadata": {"serviceUid": "uid-one", "url": "https://pod-one.run.app"},
    }
    reservation = {
        "version": 1,
        "phase": "reserved",
        "ownerId": _UID,
        "hushhId": "ha1_owner",
        "attemptId": "attempt-one",
        "registrySnapshot": snapshot,
    }
    creation_target = {
        "backend": "fake",
        "project": "synthetic-project",
        "region": "us-central1",
        "service": "pod-one",
    }
    snapshot["backend_metadata"]["provisionAttempt"] = {
        "version": 1,
        "ownerId": _UID,
        "phase": "provisioned",
        "evidence": {
            "host_requested": {
                "creationAcknowledgement": {
                    **creation_target,
                    "serviceUid": "uid-one",
                    "initialGeneration": 1,
                    "initialImage": initial_image,
                }
            }
        },
    }
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    registry.reserve_erasure = AsyncMock(return_value=reservation)

    async def observe(spec):
        assert spec.expected_service_uid == "uid-one"
        if refusal == "changed_reservation":
            registry.rows[_UID]["backend_metadata"] = {}
        return {
            "service": "pod-one",
            "serviceUid": "uid-one",
            "podUrl": "https://pod-one.run.app",
            "revision": "pod-one-00001",
        }

    backend = SimpleNamespace(
        backend_id="fake",
        observe_erasure_target=AsyncMock(side_effect=observe),
        provision_target_for=lambda spec: creation_target,
        observe_erasure_runtime=AsyncMock(
            return_value={
                "service": "pod-one",
                "serviceUid": "uid-one",
                "podUrl": "https://pod-one.run.app",
                "revision": "pod-one-00001",
                "generation": 1,
                "image": initial_image,
            }
        ),
    )
    if refusal == "foreign_owner":
        reservation["ownerId"] = "foreign"
    if refusal == "held_upgrade":
        snapshot["backend_metadata"]["upgradeLease"] = "unresolved"
    if refusal == "old_generation":
        backend.observe_erasure_runtime.return_value["generation"] = 2
    if refusal == "changed_image":
        backend.observe_erasure_runtime.return_value["image"] = (
            "registry.example/pod@sha256:" + "b" * 64
        )

    def refuse(*args):
        raise PersonalAgentDeprovisioningRequiredError("retained resources")

    monkeypatch.setattr(AccountService, "assert_personal_agent_external_resources_absent", refuse)
    fence = Mock()
    monkeypatch.setattr(pod_migration_transport, "fence_for_erasure", fence)
    binding = Mock(
        side_effect=lambda **kw: {
            **kw["payload"],
            "memoryBinding": {
                "engineId": "91",
                "creationProvenance": None if refusal == "adopted_engine" else {"version": 1},
            },
        }
    )
    monkeypatch.setattr(pod_migration_transport, "observe_memory_for_erasure", binding)

    async def retain(*, user_id, reservation, receipt):
        registry.rows[user_id]["backend_metadata"]["erasure"] = {
            **reservation,
            "memoryBinding": receipt,
        }
        return True

    registry.retain_erasure_memory_binding = AsyncMock(side_effect=retain)
    service = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=backend)
    if refusal is None:
        qualified = await service._fence_reserved_erasure(user_id=_UID, reservation=reservation)
        assert qualified["runtime"]["image"] == initial_image
    elif refusal in {"old_generation", "changed_image", "adopted_engine"}:
        with pytest.raises(RuntimeError, match="erasure runtime"):
            await service._fence_reserved_erasure(user_id=_UID, reservation=reservation)
    else:
        with pytest.raises(PersonalAgentDeprovisioningRequiredError):
            await service.deprovision(user_id=_UID)
    if refusal in {"foreign_owner", "held_upgrade", "changed_reservation"}:
        fence.assert_not_called()
        binding.assert_not_called()
        registry.retain_erasure_memory_binding.assert_not_called()
    else:
        fence.assert_called_once_with(
            pod_url="https://pod-one.run.app",
            payload={
                "hushhId": "ha1_owner",
                "attemptId": "attempt-one",
                "service": "pod-one",
                "serviceUid": "uid-one",
                "revision": "pod-one-00001",
            },
        )
        registry.retain_erasure_memory_binding.assert_awaited_once()
        saved = registry.rows[_UID]["backend_metadata"]["erasure"]
        assert saved["memoryBinding"]["attemptId"] == reservation["attemptId"]
        assert saved["memoryBinding"]["revision"] == "pod-one-00001"
    assert registry.deleted == [] and grant.revokes == []


@pytest.mark.parametrize("failure", [None, "owner", "guard", "pending", "receipt", "readback"])
async def test_provider_erasure_requires_admission_and_durable_completion(monkeypatch, failure):
    from hushh_mcp.services import pod_migration_transport

    registry, grant = FakeRegistry(), FakeGrant()
    payload = dict(
        hushhId="ha1_owner",
        attemptId="attempt-one",
        service="pod-one",
        serviceUid="uid-one",
        revision="pod-one-00001",
        memoryBinding={"engineId": "91"},
    )
    reservation = {
        "ownerId": "foreign" if failure == "owner" else _UID,
        "attemptId": "attempt-one",
        "memoryBinding": payload,
    }
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    registry.retain_erasure_memory_binding = AsyncMock(return_value=failure != "guard")
    completion = {"status": "provider_deleted", **payload}
    provider = Mock(return_value=completion)
    if failure == "pending":
        provider.side_effect = RuntimeError("pending")
    monkeypatch.setattr(pod_migration_transport, "reconcile_memory_for_erasure", provider)

    async def retain(*, user_id, reservation, receipt):
        if failure == "receipt":
            return False
        if failure != "readback":
            registry.rows[user_id]["backend_metadata"]["erasure"] = {
                **reservation,
                "memoryDeletion": receipt,
            }
        return True

    registry.retain_erasure_memory_deletion = AsyncMock(side_effect=retain)
    service = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=object())
    qualified = {**payload, "runtime": {"podUrl": "https://pod-one.run.app"}}
    if failure:
        with pytest.raises(RuntimeError):
            await service._erase_reserved_memory(user_id=_UID, qualified=qualified)
    else:
        await service._erase_reserved_memory(user_id=_UID, qualified=qualified)
        assert registry.rows[_UID]["backend_metadata"]["erasure"]["memoryDeletion"] == completion
    assert provider.call_count == (0 if failure in {"owner", "guard"} else 1)
    assert registry.deleted == [] and grant.revokes == []


@pytest.mark.parametrize("state", ["new", "acknowledged", "uncertain", "foreign", "timeout"])
async def test_compute_erasure_resumes_only_acknowledged_work_and_retains_owner(monkeypatch, state):
    import asyncio

    registry, grant = FakeRegistry(), FakeGrant()
    receipt = {
        "serviceName": "projects/p/locations/r/services/pod-one",
        "serviceUid": "uid-one",
        "etag": "v1",
        "generation": 1,
        "image": "repo/pod@sha256:" + "a" * 64,
    }
    ack = {**receipt, "operationName": "projects/p/locations/r/operations/delete-one"}
    reservation = {
        "ownerId": "foreign" if state == "foreign" else _UID,
        "attemptId": "attempt-one",
        "memoryDeletion": {"status": "provider_deleted"},
        "registrySnapshot": {
            "user_id": _UID,
            "hushh_id": "ha1_owner",
            "backend": "gcp",
            "backend_metadata": {"serviceUid": "uid-one"},
        },
    }
    if state in {"acknowledged", "uncertain"}:
        reservation["computeAdmission"] = receipt
    if state == "acknowledged":
        reservation["computeAcknowledgement"] = ack
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    events = []
    release_retention = asyncio.Event()
    late_futures = []
    if state == "timeout":
        real_submit = asyncio.run_coroutine_threadsafe

        class ExpiredWait:
            def result(self, *, timeout):
                assert timeout == 30
                raise TimeoutError("synthetic callback deadline")

        def submit(coroutine, loop):
            late_futures.append(real_submit(coroutine, loop))
            return ExpiredWait()

        monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", submit)

    async def retain(*, user_id, reservation, stage, receipt):
        events.append(stage)
        if state == "timeout":
            await release_retention.wait()
        saved = registry.rows[user_id]["backend_metadata"]["erasure"]
        if stage in saved:
            return stage != "computeAdmission" and saved[stage] == receipt
        assert saved == reservation
        registry.rows[user_id]["backend_metadata"]["erasure"] = {**saved, stage: receipt}
        return True

    async def erase(spec, *, operation_name, before_submit, on_acknowledged):
        assert spec.expected_service_uid == "uid-one"
        if operation_name:
            assert operation_name == ack["operationName"]
            events.append("resume")
        else:
            assert await asyncio.to_thread(before_submit, receipt)
            events.append("delete")
            assert await asyncio.to_thread(on_acknowledged, ack)

    registry.retain_erasure_compute_receipt = AsyncMock(side_effect=retain)
    backend = Mock(backend_id="gcp", erase_compute=AsyncMock(side_effect=erase))
    service = PersonalAgentProvisioningService(registry=registry, grant=grant, backend=backend)
    monkeypatch.setattr(service, "_backend_for", lambda spec: backend)
    if state == "timeout":
        with pytest.raises(TimeoutError):
            await service._erase_reserved_compute(user_id=_UID)
        release_retention.set()
        for future in late_futures:
            await asyncio.wrap_future(future)
        assert events == ["computeAdmission"]
        assert "computeAcknowledgement" not in registry.rows[_UID]["backend_metadata"]["erasure"]
        with pytest.raises(RuntimeError, match="acknowledgement unresolved"):
            await service._erase_reserved_compute(user_id=_UID)
        assert backend.erase_compute.await_count == 1
    elif state in {"uncertain", "foreign"}:
        with pytest.raises(RuntimeError):
            await service._erase_reserved_compute(user_id=_UID)
        backend.erase_compute.assert_not_called()
        assert not events
    else:
        await service._erase_reserved_compute(user_id=_UID)
        assert events == (
            ["computeAcknowledgement", "resume", "computeDeletion"]
            if state == "acknowledged"
            else ["computeAdmission", "delete", "computeAcknowledgement", "computeDeletion"]
        )
        assert registry.rows[_UID]["backend_metadata"]["erasure"]["computeDeletion"] == {
            **ack,
            "status": "compute_deleted",
        }
    assert registry.deleted == [] and grant.revokes == []


@pytest.mark.parametrize("case", ["retained", "foreign", "unavailable", "changed_attempt"])
async def test_erasure_inventory_requires_owner_bound_retention_and_readback(case):
    service = _svc()
    registry = service._registry
    inventory = {
        "version": "byoc.substrate.receipt.v1",
        "plannedResources": [{"type": "artifact_repository", "id": "shared"}],
    }
    reservation = {
        "ownerId": "foreign" if case == "foreign" else _UID,
        "attemptId": "erase-one",
        "computeDeletion": {"status": "compute_deleted"},
        "registrySnapshot": {"user_id": _UID, "backend_metadata": {"substrateReceipt": inventory}},
    }
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}

    async def retain(*, user_id, reservation):
        assert user_id == _UID
        if case == "unavailable":
            return False
        registry.rows[_UID]["backend_metadata"]["erasure"] = {
            **reservation,
            "substrateInventory": inventory,
            "attemptId": "replacement" if case == "changed_attempt" else "erase-one",
        }
        return True

    registry.retain_erasure_substrate_inventory = AsyncMock(side_effect=retain)
    if case == "retained":
        await service._retain_reserved_substrate_inventory(user_id=_UID)
        assert registry.rows[_UID]["backend_metadata"]["erasure"]["substrateInventory"] == inventory
    else:
        with pytest.raises(RuntimeError, match="inventory"):
            await service._retain_reserved_substrate_inventory(user_id=_UID)
    if case == "foreign":
        registry.retain_erasure_substrate_inventory.assert_not_awaited()
    assert registry.rows[_UID]["status"] == "suspended"
    assert registry.deleted == []


@pytest.mark.parametrize(
    "case",
    ["retained", "foreign", "admission_refused", "readback_changed", "outcome_refused", "retry"],
)
async def test_writer_revocation_requires_owner_admission_and_outcome_readback(monkeypatch, case):
    from hushh_mcp.services.byoc_substrate_teardown import SubstrateDeleteError

    service = _svc()
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    adapter = UserGcpBackend(
        live=True,
        user_project="synthetic-project",
        bootstrap_sa="bootstrap@synthetic-project.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(service, "_reserved_cleanup_backend", lambda snapshot: adapter)

    registry = service._registry
    email = "runtime@synthetic-project.iam.gserviceaccount.com"
    identity = {
        "name": f"projects/synthetic-project/serviceAccounts/{email}",
        "email": email,
        "projectId": "synthetic-project",
        "uniqueId": "123456789",
    }
    reservation = {
        "ownerId": "foreign" if case == "foreign" else _UID,
        "attemptId": "erase-one",
        "computeDeletion": {"status": "compute_deleted"},
        "registrySnapshot": {
            "user_id": _UID,
            "user_cloud_project": "synthetic-project",
            "user_cloud_bootstrap_sa": "bootstrap@synthetic-project.iam.gserviceaccount.com",
            "backend_metadata": {"runtime_service_account": email},
        },
        "substrateInventory": {
            "resourceObservations": [
                {
                    "type": "service_account",
                    "id": email,
                    "disposition": "created",
                    "identity": identity,
                }
            ]
        },
    }
    if case == "retry":
        reservation["writerAdmission"] = {"status": "admitted"}
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    events = []

    async def retain(*, user_id, reservation, stage, receipt):
        assert user_id == _UID
        events.append(stage)
        if (case == "admission_refused" and stage == "writerAdmission") or (
            case == "outcome_refused" and stage == "writerDisabled"
        ):
            return False
        saved = {**reservation, stage: receipt}
        if case == "readback_changed":
            saved["attemptId"] = "replacement"
        registry.rows[_UID]["backend_metadata"]["erasure"] = saved
        return True

    def revoke(**kwargs):
        assert kwargs["identity"] == identity
        if not kwargs["admitted"]:
            if not kwargs["before_disable"]({"runtimeIdentity": identity}):
                raise SubstrateDeleteError("admission refused")
            events.append("disable")
        else:
            events.append("observe")
        return {"runtimeIdentity": identity, "status": "disabled"}

    token = Mock(return_value="synthetic")
    provider = Mock(side_effect=revoke)
    registry.retain_erasure_writer_receipt = AsyncMock(side_effect=retain)
    monkeypatch.setattr(
        "hushh_mcp.runtime_settings.personal_agent_substrate_teardown_enabled", lambda: True
    )
    monkeypatch.setattr("hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token", token)
    monkeypatch.setattr(
        "hushh_mcp.services.byoc_substrate_teardown.revoke_runtime_writer", provider
    )
    if case in {"retained", "retry"}:
        await service._revoke_reserved_runtime_writer(user_id=_UID)
        assert events == (
            ["observe", "writerDisabled"]
            if case == "retry"
            else ["writerAdmission", "disable", "writerDisabled"]
        )
    else:
        with pytest.raises((RuntimeError, SubstrateDeleteError)):
            await service._revoke_reserved_runtime_writer(user_id=_UID)
    if case == "foreign":
        token.assert_not_called()
        provider.assert_not_called()
    if case in {"admission_refused", "readback_changed"}:
        assert events == ["writerAdmission"]
    assert registry.deleted == [] and registry.rows[_UID]["status"] == "suspended"


@pytest.mark.parametrize(
    "case",
    [
        "retained",
        "foreign",
        "missing_identity",
        "writer_reenabled",
        "retention_refused",
        "preflight_missing",
    ],
)
async def test_bucket_coordinator_rechecks_writer_before_final_admission(monkeypatch, case):
    import asyncio

    service = _svc()
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend

    adapter = UserGcpBackend(
        live=True,
        user_project="synthetic-project",
        bootstrap_sa="bootstrap@synthetic-project.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(service, "_reserved_cleanup_backend", lambda snapshot: adapter)

    registry = service._registry
    identity = {
        "name": "one-pod-x-blobs",
        "generation": "10",
        "projectNumber": "123",
        "timeCreated": "2026-09-01T00:00:00Z",
    }
    inventory = {
        "plannedResources": [{"type": "gcs_bucket", "id": identity["name"]}],
        "resourceObservations": []
        if case == "missing_identity"
        else [
            {
                "type": "gcs_bucket",
                "id": identity["name"],
                "disposition": "created",
                "identity": identity,
            }
        ],
    }
    reservation = {
        "ownerId": "foreign" if case == "foreign" else _UID,
        "attemptId": "erase-one",
        "registrySnapshot": {
            "user_id": _UID,
            "user_cloud_project": "synthetic-project",
            "user_cloud_bootstrap_sa": "bootstrap",
        },
        "substrateInventory": inventory,
        "writerDisabled": {"status": "disabled"},
    }
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    events = []

    async def writer(**kwargs):
        events.append("writer_recheck")
        if case == "writer_reenabled":
            raise RuntimeError("writer enabled")

    async def retain(*, user_id, reservation, stage, receipt):
        assert user_id == _UID and receipt["attemptId"] == "erase-one"
        events.append(stage)
        if case == "retention_refused":
            return False
        registry.rows[_UID]["backend_metadata"]["erasure"] = {**reservation, stage: receipt}
        return True

    def builder(**kwargs):
        async def delete(action):
            assert action["resourceObservation"]["identity"] == identity
            raw = {"bucketIdentity": identity, "metageneration": "4"}
            events.append("object_cleanup")
            for stage, status in (
                ("bucketAdmission", "admitted"),
                ("bucketAcknowledgement", "acknowledged"),
                ("bucketDeletion", "deleted"),
            ):
                if not await asyncio.to_thread(
                    kwargs["retain_bucket_receipt"], stage, {**raw, "status": status}
                ):
                    raise RuntimeError("receipt refused")
                if stage == "bucketAdmission":
                    events.append("final_delete")

        return delete

    token = Mock(return_value="synthetic")
    provider = Mock(side_effect=builder)
    registry.retain_erasure_bucket_receipt = AsyncMock(side_effect=retain)
    registry.verify_erasure_bucket_preflight = AsyncMock(return_value=case != "preflight_missing")
    monkeypatch.setattr(service, "_revoke_reserved_runtime_writer", writer)
    monkeypatch.setattr(
        "hushh_mcp.runtime_settings.personal_agent_substrate_teardown_enabled", lambda: True
    )
    monkeypatch.setattr("hushh_mcp.services.user_gcp_bootstrap.mint_bootstrap_token", token)
    monkeypatch.setattr("hushh_mcp.services.byoc_substrate_teardown.build_gcp_deleter", provider)
    if case == "retained":
        await service._erase_reserved_bucket(user_id=_UID)
        assert events == [
            "object_cleanup",
            "writer_recheck",
            "bucketAdmission",
            "final_delete",
            "bucketAcknowledgement",
            "bucketDeletion",
        ]
    else:
        with pytest.raises(RuntimeError):
            await service._erase_reserved_bucket(user_id=_UID)
        assert "final_delete" not in events
    if case in {"foreign", "missing_identity", "preflight_missing"}:
        token.assert_not_called()
        provider.assert_not_called()
    assert registry.deleted == []


@pytest.mark.parametrize("failure", [None, "preflight", "subscription_admission"])
async def test_mail_cleanup_orders_dependencies_and_stops_on_unretained_admission(
    monkeypatch, failure
):
    import asyncio

    service = _svc()
    registry = service._registry
    kinds = ["cloud_scheduler_job", "pubsub_subscription", "pubsub_topic"]
    inventory = {
        "plannedResources": [{"type": kind, "id": "mail-one"} for kind in kinds],
        "resourceObservations": [
            {"type": kind, "id": "mail-one", "disposition": "created", "identity": {"name": kind}}
            for kind in kinds
        ],
    }
    reservation = {
        "ownerId": _UID,
        "attemptId": "erase-one",
        "registrySnapshot": {"user_id": _UID},
        "substrateInventory": inventory,
        "writerDisabled": {"status": "disabled"},
    }
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    events = []

    async def retain(*, user_id, reservation, kind, stage, receipt):
        assert user_id == _UID
        events.append((kind, stage))
        if failure == "subscription_admission" and kind == "pubsub_subscription":
            return False
        mail = reservation.get("mailErasure", {})
        registry.rows[_UID]["backend_metadata"]["erasure"] = {
            **reservation,
            "mailErasure": {**mail, kind: {**mail.get(kind, {}), stage: receipt}},
        }
        return True

    async def erase(*, observation, state, retain_receipt):
        assert state == {}
        for stage, status in (
            ("admission", "admitted"),
            ("acknowledgement", "acknowledged"),
            ("deletion", "absent"),
        ):
            if not await asyncio.to_thread(
                retain_receipt, stage, {"resourceObservation": observation, "status": status}
            ):
                raise RuntimeError("retention refused")

    adapter = Mock(erase_mail_resource=AsyncMock(side_effect=erase))
    monkeypatch.setattr(service, "_reserved_cleanup_backend", lambda snapshot: adapter)
    monkeypatch.setattr(service, "_revoke_reserved_runtime_writer", AsyncMock())
    monkeypatch.setattr(
        "hushh_mcp.runtime_settings.personal_agent_substrate_teardown_enabled", lambda: True
    )
    registry.verify_erasure_mail_preflight = AsyncMock(return_value=failure != "preflight")
    registry.retain_erasure_mail_receipt = AsyncMock(side_effect=retain)
    if failure:
        with pytest.raises(RuntimeError):
            await service._erase_reserved_mail_resources(user_id=_UID)
    else:
        await service._erase_reserved_mail_resources(user_id=_UID)
        assert events == [
            (kind, stage)
            for kind in kinds
            for stage in ("admission", "acknowledgement", "deletion")
        ]
    if failure == "preflight":
        adapter.erase_mail_resource.assert_not_awaited()
    if failure == "subscription_admission":
        assert events[-1] == ("pubsub_subscription", "admission")
        assert adapter.erase_mail_resource.await_count == 2
    assert registry.deleted == []


@pytest.mark.parametrize("failure", [None, "preflight", "admission"])
async def test_kms_cleanup_binds_checkpoints_and_refuses_unretained_admission(monkeypatch, failure):
    import asyncio

    service = _svc()
    registry = service._registry
    observation = {
        "type": "kms_key",
        "id": "key-one",
        "disposition": "created",
        "identity": {"name": "synthetic-key"},
    }
    reservation = {
        "ownerId": _UID,
        "attemptId": "erase-one",
        "registrySnapshot": {"user_id": _UID},
        "substrateInventory": {
            "plannedResources": [{"type": "kms_key", "id": "key-one"}],
            "resourceObservations": [observation],
        },
    }
    registry.rows[_UID] = {"status": "suspended", "backend_metadata": {"erasure": reservation}}
    events = []

    async def retain(*, user_id, reservation, stage, receipt):
        assert user_id == receipt["ownerId"] == _UID
        assert receipt["attemptId"] == "erase-one"
        events.append(stage)
        if failure == stage:
            return False
        kms = reservation.get("kmsErasure", {})
        if stage == "inventory":
            kms = {**kms, stage: receipt}
        else:
            kms = {**kms, "versions": {"version-one": {stage: receipt}}}
        registry.rows[_UID]["backend_metadata"]["erasure"] = {**reservation, "kmsErasure": kms}
        return True

    async def erase(*, action, state, retain_receipt):
        assert action["resourceObservation"] == observation
        assert state == {}
        for stage, raw in (
            ("inventory", {"resourceObservation": observation, "versionNames": ["version-one"]}),
            (
                "admission",
                {
                    "resourceObservation": observation,
                    "versionName": "version-one",
                    "status": "admitted",
                },
            ),
        ):
            if not await asyncio.to_thread(retain_receipt, stage, raw):
                raise RuntimeError("retention refused")
        events.append("provider_destroy")

    adapter = Mock(erase_kms_material=AsyncMock(side_effect=erase))
    monkeypatch.setattr(service, "_reserved_cleanup_backend", lambda snapshot: adapter)
    monkeypatch.setattr(service, "_revoke_reserved_runtime_writer", AsyncMock())
    monkeypatch.setattr(
        "hushh_mcp.runtime_settings.personal_agent_substrate_teardown_enabled", lambda: True
    )
    registry.verify_erasure_kms_preflight = AsyncMock(return_value=failure != "preflight")
    registry.retain_erasure_kms_receipt = AsyncMock(side_effect=retain)
    if failure:
        with pytest.raises(RuntimeError):
            await service._erase_reserved_kms_material(user_id=_UID)
        assert "provider_destroy" not in events
    else:
        await service._erase_reserved_kms_material(user_id=_UID)
        assert events == ["inventory", "admission", "provider_destroy"]
    if failure == "preflight":
        adapter.erase_kms_material.assert_not_awaited()
    assert registry.deleted == []
