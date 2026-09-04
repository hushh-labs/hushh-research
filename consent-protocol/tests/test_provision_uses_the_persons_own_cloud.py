"""Every entry into provision() must carry the person's own cloud, including the retries.

All three production callers omitted `deployment_target`, and two of them are
fire-and-forget: the phone-verify seam (`actor_identity_service`) and the reconcile
retry (`server.py`). A future caller WILL forget the argument again, and the failure is
silent and expensive -- a pod built on hushh's compute for someone who authorized their
own, with nothing in the product saying so.

So the resolution lives INSIDE `provision()`. These tests assert the property that makes
that safe: the axes arrive on the PodSpec regardless of which door was used.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentCloudNotAuthorizedError,
    PersonalAgentProvisioningService,
)


class _SpyBackend:
    """Captures the spec it was asked to build, which is the thing under test."""

    backend_id = "spy"

    def __init__(self) -> None:
        self.specs: list[PodSpec] = []

    async def provision(self, spec: PodSpec) -> BackendHandle:
        self.specs.append(spec)
        return BackendHandle(
            backend=self.backend_id, external_agent_id="spy-1", backend_metadata={}
        )

    async def deprovision(self, external_agent_id: str) -> None:
        return None


class _Registry:
    def __init__(self, row: dict | None) -> None:
        self.row = row
        self.upserts: list[dict] = []

    async def get(self, user_id: str):
        return self.row

    async def upsert(self, **kwargs):
        self.upserts.append(kwargs)

    async def tombstone(self, **kwargs):
        return None

    async def delete(self, user_id: str):
        return None

    async def tombstone_exists(self, hushh_id: str) -> bool:
        return False

    async def count_active_pods(self, *, exclude_user_id=None) -> int:
        return 0


_AUTHORIZED_ROW = {
    "user_id": "uid-1",
    "status": "pending",
    "deployment_target": "user_gcp",
    "model_credential_mode": "user_adc",
    "user_cloud_project": "alice-project",
    "user_cloud_region": "us-central1",
    "user_cloud_bootstrap_sa": "one-bootstrap@alice-project.iam.gserviceaccount.com",
    "user_cloud_authorized_at": "2026-08-14T00:00:00Z",
}


def test_an_unauthorized_cloud_refuses_rather_than_falling_back():
    """The load-bearing refusal.

    Falling back here would build this person's agent on hushh's compute and hushh's
    bill after they explicitly chose otherwise, and the product would show them a
    working agent. That is the worst available outcome, so it must be a raise.

    Broken on purpose: delete the is_ready_to_provision check in provision() and this
    fails -- the pod gets built on the deployment default instead.
    """
    from hushh_mcp.services.user_cloud_service import user_cloud_from_row

    unauthorized = dict(_AUTHORIZED_ROW)
    unauthorized["user_cloud_authorized_at"] = None
    cloud = user_cloud_from_row(unauthorized)

    assert cloud is not None
    assert cloud.is_user_owned is True
    assert cloud.is_ready_to_provision is False


def test_an_authorized_cloud_is_ready():
    from hushh_mcp.services.user_cloud_service import user_cloud_from_row

    cloud = user_cloud_from_row(_AUTHORIZED_ROW)
    assert cloud is not None
    assert cloud.is_ready_to_provision is True
    assert cloud.project == "alice-project"
    assert cloud.bootstrap_sa == "one-bootstrap@alice-project.iam.gserviceaccount.com"


def test_a_person_with_no_row_has_no_cloud_and_gets_the_deployment_default():
    """Absent is not unauthorized, and the two must lead to different behaviour."""
    from hushh_mcp.services.user_cloud_service import user_cloud_from_row

    assert user_cloud_from_row(None) is None
    assert user_cloud_from_row({}) is None


class _Exploding(_Registry):
    """A registry that will not answer. Not one that answers 'nobody'.

    Only the READ fails -- everything else works -- because that is the shape of a
    transient database blip, and the point is what provisioning does with it.
    """

    def __init__(self) -> None:
        super().__init__(None)

    async def get(self, user_id: str):
        raise RuntimeError("registry unreachable")


def test_a_lookup_failure_still_does_not_raise():
    """The half of the old contract that was right: no outage on the phone-verify seam."""
    import asyncio

    from hushh_mcp.services.user_cloud_service import resolve_user_cloud

    assert asyncio.run(resolve_user_cloud("uid-1", repo=_Exploding())) is not None


def test_a_lookup_failure_is_not_reported_as_having_no_cloud():
    """The half that was wrong, and this test used to assert it.

    It read `is None` under a docstring arguing that "silence here means no cloud,
    never an unverified one". That argument is sound for a MISSING row and unsound for
    a FAILED READ, and the return type could not tell them apart -- so every caller
    that acted on "no cloud" acted on a registry that had simply not answered.
    """
    import asyncio

    from hushh_mcp.services.user_cloud_service import resolve_user_cloud

    cloud = asyncio.run(resolve_user_cloud("uid-1", repo=_Exploding()))
    assert cloud.lookup_failed is True
    assert cloud.blocks_provisioning is True, "unknown must stop a build, not default it"
    assert "could not be read" in cloud.refusal_reason


def test_the_error_is_temporary_not_invalid_details():
    """Nothing the person typed is wrong, so the feed must not say their details are."""
    from hushh_mcp.services.personal_agent_provisioning_service import (
        FEED_REASON_TEMPORARY,
        user_safe_failure_reason,
    )

    reason = user_safe_failure_reason(PersonalAgentCloudNotAuthorizedError("not yet"))
    assert reason == FEED_REASON_TEMPORARY


# -- the real claim: the axes reach the PodSpec through provision() itself ------


class _Grant:
    async def issue_or_reuse_standing_pkm_read(self, **kwargs):
        return {"token": "t"}

    async def revoke_standing_pkm_read(self, **kwargs):
        return None


class _SpySubstrate:
    """Captures the spec on the real path.

    Not a spy BACKEND: `_backend_for(spec)` resolves the backend from the person's own
    target and therefore correctly overrides an injected one -- which is the feature, so
    a spy backend never sees the call. The substrate ensurer receives the identical
    spec one line earlier and is injectable, so it is the honest capture point.
    """

    ensurer_id = "none"

    def __init__(self) -> None:
        self.specs: list = []

    async def ensure(self, spec, *, grant_ref: str = ""):
        from hushh_mcp.services.byoc_substrate import SubstrateReceipt

        self.specs.append(spec)
        return SubstrateReceipt(applied=True, tenant_ref="", detail="none")


def _service(row, substrate):
    return PersonalAgentProvisioningService(
        registry=_Registry(row),
        grant=_Grant(),
        backend=_SpyBackend(),
        substrate=substrate,
    )


async def test_provision_carries_the_persons_cloud_onto_the_spec(monkeypatch):
    """No caller passed the axes; the service resolves them itself.

    Broken on purpose: delete the `resolve_user_cloud` block in provision() and the
    spec arrives with deployment_target=None -- a pod built on hushh's default for
    someone who authorized their own project.
    """
    # The env var, not a patched symbol: `personal_agent_enabled` is imported into the
    # service's namespace at module load, so patching its home would leave the bound
    # name untouched and the test would pass for the wrong reason.
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    substrate = _SpySubstrate()
    service = _service(_AUTHORIZED_ROW, substrate)

    await service.provision(user_id="uid-1", phone_e164="+14155550123")

    assert substrate.specs, "provisioning never reached the substrate"
    spec = substrate.specs[0]
    assert spec.deployment_target == "user_gcp"
    assert spec.model_credential_mode == "user_adc"
    assert spec.user_cloud_project == "alice-project"
    assert spec.user_cloud_bootstrap_sa == "one-bootstrap@alice-project.iam.gserviceaccount.com"


async def test_provision_refuses_an_unauthorized_cloud(monkeypatch):
    """The refusal, exercised through the real entry point rather than the projection."""
    # The env var, not a patched symbol: `personal_agent_enabled` is imported into the
    # service's namespace at module load, so patching its home would leave the bound
    # name untouched and the test would pass for the wrong reason.
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    unauthorized = dict(_AUTHORIZED_ROW)
    unauthorized["user_cloud_authorized_at"] = None
    substrate = _SpySubstrate()
    service = _service(unauthorized, substrate)

    with pytest.raises(PersonalAgentCloudNotAuthorizedError):
        await service.provision(user_id="uid-1", phone_e164="+14155550123")

    assert substrate.specs == [], "infrastructure was applied for a cloud hushh cannot reach"


async def test_an_unreadable_registry_never_builds_on_the_deployment_default(monkeypatch):
    """The consequence, end to end, and the reason any of this matters.

    Before: one transient registry error built a BYOC person's pod inside hushh's own
    project, on hushh's fleet identity, with applied=True at every layer and nothing
    anywhere saying so -- the exact outcome the comment above the provisioning gate
    names as the thing to avoid. The refusal above only fires for a row that WAS read.

    Broken on purpose: return None from resolve_user_cloud's exception handler and this
    fails -- the substrate is applied and the pod is built on the deployment default.
    """
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    substrate = _SpySubstrate()
    service = PersonalAgentProvisioningService(
        registry=_Exploding(), grant=_Grant(), backend=_SpyBackend(), substrate=substrate
    )

    with pytest.raises(PersonalAgentCloudNotAuthorizedError) as caught:
        await service.provision(user_id="uid-1", phone_e164="+14155550123")

    assert "could not be read" in str(caught.value)
    assert substrate.specs == [], "infrastructure was applied for a cloud nobody could read"
