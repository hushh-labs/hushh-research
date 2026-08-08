"""Tests for the user-owned GCP backend (BYOC) — plan-mode, keyless, inert."""

from __future__ import annotations

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
    # The plan is a declarative resource/IAM/federation spec — never key material.
    # ("private ingress" is fine; we forbid actual secret markers.)
    blob = str(_backend().render_bootstrap_plan(_spec())).lower()
    for forbidden in ("private key", "private_key", "secret", "password", "api_key", "-----begin"):
        assert forbidden not in blob


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
