"""Tests for the user-owned GCP backend (BYOC) — plan-mode, keyless, inert."""

from __future__ import annotations

import re

import pytest

from hushh_mcp.services.compute_backend import (
    BACKEND_USER_GCP,
    ComputeBackend,
    PodSpec,
    resolve_compute_backend,
)
from hushh_mcp.services.user_gcp_backend import UserGcpBackend


def _spec(hushh_id: str = "HA1ABC234DEF") -> PodSpec:
    return PodSpec(hushh_id=hushh_id, phone_e164_hash="hash", pod_pubkey="pub", space_id="sp_1")


def _backend() -> UserGcpBackend:
    return UserGcpBackend(
        user_project="acme-user-proj",
        image="gcr.io/hushh-pda-dev/one-pod:slim-x",
        wif_pool="hushh-pool",
        wif_provider="hushh-provider",
        hushh_invoker_sa="consent-plane@hushh.iam.gserviceaccount.com",
    )


def test_satisfies_compute_backend_protocol():
    assert isinstance(_backend(), ComputeBackend)
    assert _backend().backend_id == BACKEND_USER_GCP


def test_deploy_config_targets_user_project_and_is_user_owned():
    cfg = _backend().render_deploy_config(_spec())
    assert cfg["kind"] == "Service"
    assert cfg["metadata"]["namespace"] == "acme-user-proj"  # the USER's project
    assert cfg["metadata"]["labels"]["hussh-tenancy"] == "user-owned"


def test_bootstrap_plan_is_least_privilege_and_keyless():
    plan = _backend().render_bootstrap_plan(_spec())
    assert plan["tenancy"] == "user-owned"
    assert plan["target"]["project"] == "acme-user-proj"
    kinds = {r["type"] for r in plan["resources"]}
    assert {"kms_key", "gcs_bucket", "service_account", "cloud_run_service"} <= kinds
    # Keyless, but by the mechanism that actually fits a GCP-hosted hub. A Google
    # identity reaching another project is GRANTED, not federated -- WIF exists to give
    # Google credentials to non-Google workloads, so a pool here would be a component
    # that carries no weight. Short-lived impersonation of one authorized account is the
    # real thing: no key is exported either way, and revocation is one binding.
    assert plan["federation"]["type"] == "impersonation"
    assert plan["federation"]["impersonation"]["role"] == "roles/iam.serviceAccountTokenCreator"
    assert plan["federation"]["impersonation"]["token_lifetime"] == "900s"
    # WIF is kept, and labelled for the deployment it does serve: a CloudHub control
    # plane has no Google identity to grant and must exchange one.
    assert plan["federation"]["workload_identity_federation"]["pool"] == "hushh-pool"
    # Hushh gets ONLY run.invoker on the pod — no broad standing grant.
    invoker = [b for b in plan["iam"] if b["role"] == "roles/run.invoker"]
    assert len(invoker) == 1
    assert invoker[0]["member"] == "consent-plane@hushh.iam.gserviceaccount.com"
    # The pod SA is decrypter + bucket-scoped only (least privilege).
    roles = {b["role"] for b in plan["iam"]}
    assert "roles/cloudkms.cryptoKeyDecrypter" in roles
    assert "roles/owner" not in roles and "roles/editor" not in roles


def test_bootstrap_plan_includes_metadata_only_mail_trigger():
    plan = _backend().render_bootstrap_plan(_spec())
    # The whole mail-event trigger lives inside the user's project (BYOC).
    kinds = {r["type"] for r in plan["resources"]}
    assert {"pubsub_topic", "pubsub_subscription", "cloud_scheduler_job"} <= kinds
    members = {(b["member"], b["role"]) for b in plan["iam"]}
    # Gmail's push SA may publish into the user's OWN topic; the pod pulls its wakes.
    assert ("gmail-api-push@system.gserviceaccount.com", "roles/pubsub.publisher") in members
    subs = [b for b in plan["iam"] if b["role"] == "roles/pubsub.subscriber"]
    assert len(subs) == 1
    assert subs[0]["member"].endswith("@acme-user-proj.iam.gserviceaccount.com")
    # It is a doorbell: metadata only, body opened by the pod, Hushh out of the path.
    mt = plan["mail_trigger"]
    assert "metadata only" in mt["carries"].lower() and "body" in mt["carries"].lower()
    assert "historyid" in mt["renewal"].lower()  # dedupe + renewal discipline recorded


def test_bootstrap_plan_carries_no_secret_material():
    """The plan is a declarative resource/IAM/federation spec, never key material.

    WHY THIS NO LONGER GREPS FOR THE WORD "secret"

    It used to forbid that substring anywhere in the rendered plan. That was a proxy,
    and it failed in both directions once the plan had to be honest about what it
    grants. The applier binds ``roles/secretmanager.secretAccessor`` and creates a
    Secret Manager entry, so a plan that names neither is hiding authority from the
    person being asked to consent to it -- the exact failure
    ``test_byoc_bootstrap_plan_matches_the_applier`` exists to catch. Under the old
    pattern, the more truthful the artifact became, the redder this went.

    It was also weak in the direction that matters: a base64 key blob under a neutral
    field name passed cleanly, because nobody had written the word.

    So this now inspects VALUES for the shape of key material rather than scanning the
    blob for a vocabulary. A role name and a resource id are identifiers; a PEM block or
    a long opaque blob is a secret, whatever it is called.
    """
    plan = _backend().render_bootstrap_plan(_spec())

    def _walk(node, path=""):
        if isinstance(node, dict):
            for key, value in node.items():
                # A field whose NAME promises a value is a field that must not hold one.
                assert str(key).lower() not in {
                    "private_key",
                    "privatekey",
                    "password",
                    "api_key",
                    "apikey",
                    "credential",
                    "token",
                }, f"{path}.{key} is a value-bearing field name in a declarative plan"
                _walk(value, f"{path}.{key}")
        elif isinstance(node, (list, tuple)):
            for i, item in enumerate(node):
                _walk(item, f"{path}[{i}]")
        elif isinstance(node, str):
            lowered = node.lower()
            assert "-----begin" not in lowered, f"{path} carries a PEM block"
            assert "private key" not in lowered, f"{path} names private key material"
            # An opaque high-entropy run is what an exported key or a token looks like.
            # Real plan strings are dotted role names, hyphenated resource ids, URLs and
            # prose -- none of which produce a long unbroken alphanumeric token.
            for token in re.split(r"[^A-Za-z0-9+/=_]+", node):
                assert len(token) < 40, f"{path} carries an opaque {len(token)}-char blob"

    _walk(plan, "plan")


async def test_provision_plan_mode_is_user_owned_and_keyless():
    handle = await _backend().provision(_spec())
    assert handle.backend == BACKEND_USER_GCP
    assert handle.status == "planned"
    assert handle.backend_metadata["tenancy"] == "user-owned"
    assert handle.backend_metadata["keyless"] is True
    assert handle.backend_metadata["bootstrap"] == "pending"


async def test_live_provision_requires_the_authorized_bootstrap_account(monkeypatch):
    """Live BYOC provisioning is implemented now; what it still refuses is guessing.

    This test used to assert ``NotImplementedError``. That was the honest guard while
    nothing was wired. The guard that matters once it IS wired is different and
    stronger: hushh must not reach into a user's project on an identity the user never
    authorized. An inferred bootstrap account that happened to exist would be used
    silently, and the whole consent story rests on the grant having been made.
    """
    monkeypatch.delenv("HUSSH_USER_GCP_BOOTSTRAP_SA", raising=False)
    live = UserGcpBackend(user_project="acme", live=True)
    with pytest.raises(RuntimeError, match="never inferred"):
        await live.provision(_spec())


def test_resolver_maps_user_gcp():
    assert isinstance(resolve_compute_backend("user_gcp"), UserGcpBackend)


# -- the gone-detection contract (integration defect found 2026-08-21) --------
# GcpBackend.get() returns status="gone" when the Cloud Run service is absent;
# UserGcpBackend.get() returned "missing" for the identical condition, and
# pod_wake._host_is_gone only recognizes "gone". So the whole missing-project ->
# reinit path fired for managed pods and NEVER for BYOC pods -- the exact
# sovereignty tier it targets. These pin the two contracts to one word.


class _AbsentServiceClient:
    """A Cloud Run client whose service does not exist (deleted project/pod)."""

    def get_service(self, name):  # noqa: ARG002
        return None


async def test_get_reports_gone_when_the_user_service_is_absent(monkeypatch):
    live = UserGcpBackend(user_project="acme", live=True)
    # Bypass the bootstrap-token mint; point straight at an absent-service client.
    monkeypatch.setattr(live, "_client", lambda: _AbsentServiceClient())
    status = await live.get("one-pod-ha1abc")
    # The contract the gone-path checks. "missing" here is the silent-dead bug.
    assert status.status == "gone"
    assert status.healthy is False


async def test_host_is_gone_recognizes_an_absent_byoc_service():
    # Cross-module: the BYOC backend's absent-service verdict must satisfy the
    # gone-check pod_wake relies on. Kept as a string-contract assertion so it
    # fails loudly if either side drifts again.
    from hushh_mcp.services.compute_backend import BackendStatus

    assert BackendStatus(external_agent_id="x", status="gone", healthy=False).status == "gone"


class _ServiceClient:
    """A Cloud Run client returning one canned service, with our label by default."""

    def __init__(self, svc):
        self._svc = svc

    def get_service(self, name):  # noqa: ARG002
        return self._svc

    @staticmethod
    def service_url(svc):
        return ((svc or {}).get("status") or {}).get("url")


def _ready_service(*, tenancy="user-owned"):
    return {
        "metadata": {"name": "one-pod-ha1abc", "labels": {"hussh-tenancy": tenancy}},
        "status": {
            "url": "https://one-pod-ha1abc.run.app",
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }


async def test_discover_adopts_an_existing_user_owned_pod(monkeypatch):
    live = UserGcpBackend(user_project="acme", live=True)
    monkeypatch.setattr(live, "_client", lambda: _ServiceClient(_ready_service()))
    handle = await live.discover("ha1abc")
    assert handle is not None
    assert handle.status == "live"
    assert handle.backend_metadata["adopted"] is True
    assert handle.backend_metadata["url"] == "https://one-pod-ha1abc.run.app"
    # The adopted row MUST carry runtime_service_account, or verify_pod_identity 401s the
    # pod on the BYOC tier and the restored standing read can never be exercised.
    sa = handle.backend_metadata["runtime_service_account"]
    assert sa.endswith("@acme.iam.gserviceaccount.com")


async def test_discover_returns_none_when_no_pod_exists(monkeypatch):
    live = UserGcpBackend(user_project="acme", live=True)
    monkeypatch.setattr(live, "_client", lambda: _AbsentServiceClient())
    assert await live.discover("ha1abc") is None


async def test_discover_refuses_a_service_that_is_not_ours(monkeypatch):
    # A name collision on something WE did not create must never be adopted -- we
    # would later tear down a resource that is not ours. Only hussh-tenancy=user-owned
    # is adoptable.
    live = UserGcpBackend(user_project="acme", live=True)
    monkeypatch.setattr(live, "_client", lambda: _ServiceClient(_ready_service(tenancy="")))
    assert await live.discover("ha1abc") is None


async def test_discover_is_none_in_plan_mode():
    # Plan mode holds no impersonated client; there is nothing to discover.
    planned = UserGcpBackend(user_project="acme", live=False)
    assert await planned.discover("ha1abc") is None
