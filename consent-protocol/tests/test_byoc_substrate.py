"""The BYOC bootstrap must be CALLED, and what hushh keeps must be a receipt.

TWO DEFECTS, ONE FILE

**The call.** `UserGcpBootstrap` was a complete applier -- ordered calls, LRO polling,
secret seeding, IAM binding merge, bucket-ownership checks, dependency-aware per-step
results -- with zero callers outside tests. The only mention of it in production code
was a docstring saying live provisioning depends on it. That missing call is why BYO GCP
could not be reached: `UserGcpBackend.provision` is live-wired and gated on
`HUSSH_USER_GCP_LIVE` **plus** a completed bootstrap nothing ran. So the first assertion
here is about the CALL, not the applier.

**The record.** Terraform state records resource ATTRIBUTES verbatim -- which is exactly
why secrets land in it. For a project hushh does not own, holding that file is the
inverse of the BYOC promise. hushh keeps identifiers instead. The tests below assert
that boundary directly, because it is the kind of property that erodes one convenient
field at a time: someone adds the bucket's location "just for diagnostics", then the
key's rotation period, and the receipt has quietly become a state file.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.runtime_settings import get_core_security_settings
from hushh_mcp.services.byoc_substrate import (
    RECEIPT_VERSION,
    HushhFederatedSubstrate,
    NoSubstrateRequired,
    SubstrateReceipt,
    plan_digest,
    resolve_substrate_ensurer,
    resource_ids,
)
from hushh_mcp.services.compute_backend import BACKEND_USER_GCP, BackendHandle, PodSpec
from hushh_mcp.services.personal_agent_provisioning_service import (
    PersonalAgentProvisioningService,
    SubstrateNotReadyError,
    user_safe_failure_reason,
)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """Same shape as test_personal_agent_provisioning_service's fixture.

    The kill-switch is checked before anything else in `provision`, so without this
    every orchestration test below fails on the flag rather than on what it asserts.
    """
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    get_core_security_settings.cache_clear()
    yield
    get_core_security_settings.cache_clear()


_PLAN = {
    "tenancy": "user-owned",
    "target": {"project": "user-proj", "region": "us-central1"},
    "resources": [
        {"type": "kms_key", "id": "one-pod-abc-key", "purpose": "per-user CMEK"},
        {"type": "gcs_bucket", "id": "one-pod-abc-blobs", "encryption": "cmek:one-pod-abc-key"},
        {"type": "service_account", "id": "one-pod-abc@user-proj.iam.gserviceaccount.com"},
    ],
}


# -- the record boundary ---------------------------------------------------------------


def test_the_receipt_records_identifiers_and_never_attributes():
    """The line between a receipt and a state file, asserted rather than intended."""
    receipt = SubstrateReceipt(
        applied=True,
        tenant_ref="user-proj/us-central1",
        resource_ids=resource_ids(_PLAN),
        plan_digest=plan_digest(_PLAN),
        grant_ref="grant-1",
    )
    serialized = json.dumps(receipt.as_record())

    assert "one-pod-abc-key" in serialized, "the receipt must name what exists"
    # Attributes from the same plan must NOT survive into the record. `purpose` and
    # `encryption` are harmless in themselves; they are the thin end of the wedge that
    # turns a receipt into a mirror of someone else's project.
    for attribute in ("per-user CMEK", "cmek:one-pod-abc-key", "user-owned"):
        assert attribute not in serialized, (
            f"resource attribute {attribute!r} reached the persisted receipt. Only "
            "identifiers, the plan digest and the grant may be kept -- that boundary is "
            "the whole reason hushh does not hold Terraform state for a customer project."
        )
    assert receipt.as_record()["version"] == RECEIPT_VERSION


def test_the_plan_digest_tracks_resources_not_prose():
    """A digest that moves when a caption moves is a drift signal people learn to ignore."""
    reworded = json.loads(json.dumps(_PLAN))
    reworded["resources"][0]["purpose"] = "completely different wording"
    assert plan_digest(reworded) == plan_digest(_PLAN)

    renamed = json.loads(json.dumps(_PLAN))
    renamed["resources"][0]["id"] = "one-pod-abc-key-v2"
    assert plan_digest(renamed) != plan_digest(_PLAN), (
        "a renamed resource must change the digest, or the receipt cannot detect that "
        "what exists is no longer what the plan describes"
    )


# -- resolution ------------------------------------------------------------------------


def test_only_byoc_resolves_to_a_real_ensurer():
    for target in (None, "", "gcp", "anypoint"):
        spec = PodSpec(hushh_id="h", phone_e164_hash="p", pod_pubkey="k", deployment_target=target)
        assert isinstance(resolve_substrate_ensurer(spec), NoSubstrateRequired)

    # A well-formed BYOC spec carries the tenant it is for. It did not have to before,
    # when the destination was a process-wide env var -- which is exactly why two people
    # resolved to one project. The coordinates are now part of what makes the spec valid.
    byoc = PodSpec(
        hushh_id="h",
        phone_e164_hash="p",
        pod_pubkey="k",
        deployment_target=BACKEND_USER_GCP,
        user_cloud_project="their-own-project",
    )
    assert isinstance(resolve_substrate_ensurer(byoc), HushhFederatedSubstrate)


def test_creating_resources_in_someone_elses_cloud_is_opt_in(monkeypatch):
    monkeypatch.delenv("HUSSH_USER_GCP_SUBSTRATE_APPLY", raising=False)
    byoc = PodSpec(
        hushh_id="h",
        phone_e164_hash="p",
        pod_pubkey="k",
        deployment_target=BACKEND_USER_GCP,
        user_cloud_project="their-own-project",
    )
    assert resolve_substrate_ensurer(byoc)._dry_run is True, (
        "substrate apply defaulted ON. Creating a KMS key, a CMEK bucket and IAM in a "
        "customer's project must never be the default."
    )


def test_a_dry_run_reports_that_it_created_nothing():
    class _Bootstrap:
        def __init__(self, **_kwargs): ...
        def apply(self, plan, *, dry_run=True):
            return {"dryRun": True, "project": "user-proj", "steps": [{"step": "kms"}]}

    ensurer = HushhFederatedSubstrate(
        project="user-proj",
        plan_renderer=lambda _s: _PLAN,
        bootstrap_factory=_Bootstrap,
        dry_run=True,
    )
    receipt = asyncio.run(ensurer.ensure(object()))
    assert receipt.applied is False, "a plan must never read as a result"
    # The identifiers are still returned: knowing what WOULD be created is the point.
    assert receipt.resource_ids == resource_ids(_PLAN)


def test_a_revoked_grant_reads_as_the_users_remedy_not_a_hushh_outage():
    def _refuse(**_kwargs):
        raise RuntimeError("caller does not have permission to impersonate")

    ensurer = HushhFederatedSubstrate(
        project="user-proj",
        plan_renderer=lambda _s: _PLAN,
        token_minter=_refuse,
        dry_run=False,
    )
    receipt = asyncio.run(ensurer.ensure(object()))
    assert receipt.applied is False
    assert "revoked" in receipt.detail or "missing" in receipt.detail


# -- THE call --------------------------------------------------------------------------


class _RecordingSubstrate:
    ensurer_id = "recording"

    def __init__(self, applied=True, steps=None):
        self.applied, self.steps, self.calls = applied, steps or [], []

    async def ensure(self, spec, *, grant_ref=""):
        self.calls.append(getattr(spec, "hushh_id", ""))
        return SubstrateReceipt(
            self.applied, "user-proj/us-central1", resource_ids=["r1"], steps=self.steps
        )


class _RecordingBackend:
    backend_id = "recording"

    def __init__(self):
        self.provisioned = []

    async def provision(self, spec):
        self.provisioned.append(spec.hushh_id)
        return BackendHandle(external_agent_id="svc", backend="recording", status="live")

    async def deprovision(self, external_agent_id): ...
    async def get(self, external_agent_id): ...
    def render_deploy_config(self, spec):
        return {}

    async def health(self):
        return True


class _FakeRegistry:
    """Same surface as test_personal_agent_provisioning_service's FakeRegistry.

    `tombstone_exists` is load-bearing: `provision` consults it through
    `_next_free_generation` to handle a recycled phone number, and a fake without it
    falls through to the real repo and dies on a missing DB credential -- an error that
    looks nothing like the thing being tested.
    """

    def __init__(self):
        self.rows: list[dict] = []
        self.tombstones: list[dict] = []

    async def upsert(self, **fields):
        self.rows.append(fields)

    async def get(self, user_id):
        return self.rows[-1] if self.rows else None

    async def tombstone(self, **kw):
        self.tombstones.append(kw)

    async def delete(self, user_id): ...

    async def tombstone_exists(self, hushh_id):
        return any((t.get("hushh_id") or "") == hushh_id for t in self.tombstones)

    async def count_active_pods(self, *, exclude_user_id=None):
        return 0


class _FakeGrant:
    async def issue_standing_pkm_read(self, user_id, ledger=None):
        return {"expiresAt": None}


@pytest.mark.asyncio
async def test_the_orchestrator_actually_calls_the_bootstrap():
    """THE assertion. The applier was correct and never ran; this is the call."""
    substrate, backend = _RecordingSubstrate(), _RecordingBackend()
    service = PersonalAgentProvisioningService(
        registry=_FakeRegistry(), grant=_FakeGrant(), backend=backend, substrate=substrate
    )
    await service.provision(user_id="u1", phone_e164="+15550100")
    assert substrate.calls, (
        "the provisioning path never called the substrate ensurer. An applier being "
        "correct is not the same as an applier running -- that gap is the entire reason "
        "BYO GCP was unreachable."
    )


@pytest.mark.asyncio
async def test_no_pod_is_built_on_substrate_that_failed():
    substrate = _RecordingSubstrate(
        applied=False, steps=[{"step": "kms_key", "ok": False, "detail": "permission denied"}]
    )
    backend = _RecordingBackend()
    service = PersonalAgentProvisioningService(
        registry=_FakeRegistry(), grant=_FakeGrant(), backend=backend, substrate=substrate
    )
    with pytest.raises(SubstrateNotReadyError) as caught:
        await service.provision(user_id="u1", phone_e164="+15550100")

    assert not backend.provisioned, (
        "a pod was built on infrastructure that did not apply -- it would boot into a "
        "project with nowhere to write and no key to write with"
    )
    assert "kms_key" in str(caught.value), "the FIRST failing step must be named"


@pytest.mark.asyncio
async def test_the_receipt_reaches_the_registry_row():
    """Without this the teardown inventory does not exist and nothing can clean up."""
    registry = _FakeRegistry()
    service = PersonalAgentProvisioningService(
        registry=registry,
        grant=_FakeGrant(),
        backend=_RecordingBackend(),
        substrate=_RecordingSubstrate(),
    )
    await service.provision(user_id="u1", phone_e164="+15550100")

    with_metadata = [
        r for r in registry.rows if (r.get("backend_metadata") or {}).get("substrateReceipt")
    ]
    assert with_metadata, "the substrate receipt never reached the row"
    assert with_metadata[-1]["backend_metadata"]["substrateReceipt"]["resourceIds"] == ["r1"]


@pytest.mark.asyncio
async def test_a_non_byoc_person_pays_nothing_and_still_provisions():
    """The no-op path must not become a second way to fail."""
    backend = _RecordingBackend()
    service = PersonalAgentProvisioningService(
        registry=_FakeRegistry(),
        grant=_FakeGrant(),
        backend=backend,
        substrate=NoSubstrateRequired(),
    )
    await service.provision(user_id="u1", phone_e164="+15550100")
    assert backend.provisioned, "a managed-tier pod was blocked by substrate it never needed"


def test_substrate_failure_is_temporary_not_invalid_details():
    """A revoked or incomplete grant is not the person mistyping something."""
    assert user_safe_failure_reason(SubstrateNotReadyError("x")) == "temporary_issue"
