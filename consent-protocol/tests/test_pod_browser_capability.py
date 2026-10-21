"""Browser configuration authority; provider effects are synthetic and bounded."""

import base64
import json
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.pod_browser.capability_update import plan_from_observation
from hushh_mcp.services.pod_update_identity import approved_browser_plan, release_identity
from tests.helpers.pod_browser_capability import (
    browser_capability_fixture,
    browser_registry_fixture,
)
from tests.test_pod_image_upgrade_path import service_env as service_env


def test_browser_plan_has_distinct_approval_and_cannot_change_owner_identity_or_readback():
    row, image, existing, qualification, _ = browser_capability_fixture()
    plan = plan_from_observation(row, image, existing, qualification)
    digest = plan.digest
    approved = {
        "version": 2,
        "capability": "browser",
        "ownerId": row["user_id"],
        "hushhId": row["hushh_id"],
        "podIncarnation": plan.serviceUid,
        "targetImage": image,
        "browserPlan": plan.model_dump(mode="json"),
        "browserPlanDigest": digest,
    }
    assert approved_browser_plan(approved).digest == digest
    assert release_identity(
        plan.hushhId, plan.serviceUid, image, browser_digest=digest
    ) != release_identity(plan.hushhId, plan.serviceUid, image, capability_digest=digest)
    for change in ({"user_id": "other"}, {"pod_key_id": "rotated"}, {"placement_epoch": 1}):
        with pytest.raises(ValueError, match="owner or pod"):
            plan.require_owner({**row, **change}, image)
    for change in (
        {"version": 1},
        {"capabilityPlanDigest": "f" * 64},
        {"browserPlanDigest": "f" * 64},
    ):
        with pytest.raises(ValueError):
            approved_browser_plan({**approved, **change})
    installed = deepcopy(existing)
    env = installed["spec"]["template"]["spec"]["containers"][0]["env"]
    env.append({"name": "HUSSH_BROWSER_QUALIFICATION_JSON", "value": json.dumps(qualification)})
    plan.apply_configuration(existing, installed, qualification)
    plan.require_installed(installed)
    stale_traffic = deepcopy(installed)
    stale_traffic["status"]["traffic"][0]["revisionName"] = plan.service + "-older"
    with pytest.raises(ValueError, match="serving revision"):
        plan.require_installed(stale_traffic)
    actual = installed["spec"]["template"]["spec"]["containers"][0]
    actual["env"] = [item for item in actual["env"] if item["name"] != "HUSSH_BROWSER_POLICY_JSON"]
    with pytest.raises(ValueError, match="installed configuration"):
        plan.require_installed(installed)


async def test_browser_same_image_approval_drains_replaces_once_and_verifies_policy(monkeypatch):
    import hashlib

    from hushh_mcp.services import pod_upgrade_handoff
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.user_gcp_backend import UserGcpBackend
    from tests.test_pod_image_upgrade_path import FakeRun

    row, image, existing, qualification, _ = browser_capability_fixture()
    plan = plan_from_observation(row, image, existing, qualification)
    spec = PodSpec(
        hushh_id=plan.hushhId,
        phone_e164_hash="opaque",
        pod_pubkey="public",
        expected_service_uid=plan.serviceUid,
        upgrade_operation_id="op_" + "a" * 32,
        upgrade_attempt_id="b" * 64,
        upgrade_target_image=image,
        browser_upgrade_plan=plan.model_dump(mode="json"),
        browser_qualification=qualification,
    )
    backend = UserGcpBackend(
        user_project=plan.project,
        user_region=plan.region,
        bootstrap_sa=plan.bootstrapAccount,
        image=image,
        live=True,
    )
    run = FakeRun(plan.service)
    run.services[plan.service] = deepcopy(existing)

    def serving(name, **kwargs):
        assert kwargs["expected_uid"] == plan.serviceUid
        observed = deepcopy(run.services[name])
        observed["status"] = deepcopy(existing["status"])
        return True, observed

    run.wait_ready = serving
    backend._client = lambda: run
    backend._ensure_pod_image = Mock(return_value=image.rsplit("@", 1)[1])
    events = []
    monkeypatch.setattr(
        pod_upgrade_handoff,
        "PodUpgradeHandoffClient",
        lambda **_: SimpleNamespace(
            prepare_and_wait=lambda **_: events.append("idle") or {}, release=Mock()
        ),
    )
    handle = await backend.upgrade(spec)
    assert events == ["idle"] and len(run.replaced) == 1 and not run.created
    assert handle.backend_metadata["browserCapability"] == {
        "planDigest": plan.digest,
        "status": "configured",
    }
    observed = run.services[plan.service]
    plan.require_installed(observed)
    assert (
        observed["spec"]["template"]["spec"]["containers"][0]["resources"]
        == existing["spec"]["template"]["spec"]["containers"][0]["resources"]
    )
    # Read-only recovery discovers the exact attempt; it never calls replace again.
    from hushh_mcp.services.pod_browser.update_recovery import discover_replacement

    lease = "retained-lease"
    spec = replace(spec, upgrade_attempt_id=hashlib.sha256(lease.encode()).hexdigest())
    observed["spec"]["template"]["metadata"]["annotations"]["hussh/restart-nonce"] = (
        spec.upgrade_attempt_id
    )
    row["backend_metadata"]["upgradeApproval"] = {"releaseId": "same-approved-release"}
    recovered = await discover_replacement(row=row, spec=spec, backend=backend, lease=lease)
    assert recovered is not None and recovered["targetImage"] == image and len(run.replaced) == 1


async def test_owner_browser_review_uses_real_registry_key_cas_and_one_operation(monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from api.routes.one import personal_agent as route
    from hushh_mcp.services.pod_browser import update_offer

    row, image, existing, _, release = browser_capability_fixture()
    with browser_registry_fixture(monkeypatch, row) as (server, repo, parked):
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
        monkeypatch.setenv("HUSSH_POD_BROWSER_ENABLED", "true")
        monkeypatch.setenv("HUSSH_ONE_POD_IMAGE", image)
        monkeypatch.setenv(
            "HUSSH_ONE_POD_RELEASE_B64", base64.b64encode(json.dumps(release).encode()).decode()
        )
        monkeypatch.setattr(route, "_require_enabled", lambda: None)
        monkeypatch.setattr(route, "PersonalAgentRegistryRepo", lambda: repo)
        monkeypatch.setattr(
            update_offer,
            "resolve_compute_backend_for_spec",
            lambda _: SimpleNamespace(inspect_pod_configuration=AsyncMock(return_value=existing)),
        )
        app = FastAPI()
        app.include_router(route.router)
        app.dependency_overrides[route.require_firebase_auth] = lambda: row["user_id"]
        async with AsyncClient(transport=ASGITransport(app=app), base_url="https://hub") as browser:
            path = "/api/one/personal-agent/update"
            assert (await browser.post(path + "/browser-plan")).status_code == 409
            server.apply_file(parked / "969_gcp_browser_update_admission.sql")
            monkeypatch.delenv("HUSSH_POD_BROWSER_ENABLED")
            assert (await browser.post(path + "/browser-plan")).status_code == 409
            monkeypatch.setenv("HUSSH_POD_BROWSER_ENABLED", "true")
            offered = await browser.post(path + "/browser-plan")
            assert offered.status_code == 200, offered.text
            offer = offered.json()
            body = {
                "releaseId": offer["releaseId"],
                "browserPlanDigest": offer["browserPlanDigest"],
                "idempotencyKey": "synthetic-click",
            }
            original = repo.record_upgrade_approval

            async def rotate_before_write(**kwargs):
                server.execute(
                    "UPDATE personal_agent_registry SET pod_key_id='rotated' WHERE user_id=%s",
                    (row["user_id"],),
                )
                return await original(**kwargs)

            monkeypatch.setattr(repo, "record_upgrade_approval", rotate_before_write)
            assert (await browser.post(path + "/approve", json=body)).status_code == 409
            assert (await repo.get(row["user_id"]))["backend_metadata"].get(
                "upgradeApproval"
            ) is None
            server.execute(
                "UPDATE personal_agent_registry SET pod_key_id=%s WHERE user_id=%s",
                (row["pod_key_id"], row["user_id"]),
            )
            monkeypatch.setattr(repo, "record_upgrade_approval", original)
            first = await browser.post(path + "/approve", json=body)
            assert first.status_code == 200, first.text
            assert (await browser.post(path + "/approve", json=body)).json() == first.json()
            changed = {**body, "browserPlanDigest": "f" * 64}
            assert (await browser.post(path + "/approve", json=changed)).status_code == 409
            saved = (await repo.get(row["user_id"]))["backend_metadata"]["upgradeApproval"]
            assert saved["version"] == 2 and saved["operationId"] == first.json()["operationId"]
            assert server.execute(
                "SELECT public.valid_gcp_browser_update_approval(to_jsonb(r),backend_metadata->'upgradeApproval') FROM personal_agent_registry r WHERE user_id=%s",
                (row["user_id"],),
            ) == [(True,)]


async def test_held_browser_without_ack_recovers_saved_target_without_new_mutation(
    monkeypatch, service_env
):
    import hashlib

    from hushh_mcp.services.pod_browser import update_offer
    from tests.test_pod_image_upgrade_path import FakeRegistry

    pas, _ = service_env
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    row, image, observed, qualification, release = browser_capability_fixture()
    plan = plan_from_observation(row, image, observed, qualification)
    row["backend_metadata"].update(
        upgradeLease="retained-browser-lease",
        upgradeApproval={
            "version": 2,
            "capability": "browser",
            "status": "updating",
            "ownerId": row["user_id"],
            "hushhId": plan.hushhId,
            "podIncarnation": plan.serviceUid,
            "targetImage": image,
            "releaseId": release_identity(
                plan.hushhId, plan.serviceUid, image, browser_digest=plan.digest
            ),
            "operationId": "op_browser_recovery",
            "idempotencyKey": "retained-click",
            "browserPlan": plan.model_dump(mode="json"),
            "browserPlanDigest": plan.digest,
            "releaseMetadata": release,
        },
    )
    plan.apply_configuration(observed, observed, qualification)
    template = observed["spec"]["template"]
    template["spec"]["containers"][0]["env"].append(
        {
            "name": "HUSSH_BROWSER_QUALIFICATION_JSON",
            "value": json.dumps(qualification),
        }
    )
    template["metadata"]["annotations"]["hussh/restart-nonce"] = hashlib.sha256(
        row["backend_metadata"]["upgradeLease"].encode()
    ).hexdigest()
    registry = FakeRegistry({row["user_id"]: row})
    backend = SimpleNamespace(
        inspect_pod_configuration=AsyncMock(return_value=observed),
        observe_upgrade=AsyncMock(return_value=None),
        upgrade=AsyncMock(side_effect=AssertionError("a held operation cannot replace again")),
    )
    service = pas.PersonalAgentProvisioningService(registry=registry, backend=backend)
    service._backend_for = lambda _: backend
    monkeypatch.setattr(update_offer, "require_browser_schema", AsyncMock())
    newer_target = image.rsplit("@", 1)[0] + "@sha256:" + "f" * 64
    assert await service.list_upgrade_candidates(current_image=newer_target) == [row]
    result = await service.upgrade_pod(user_id=row["user_id"], current_image=newer_target)
    assert result["skipped"] == "in_progress"
    saved = registry.rows[row["user_id"]]["backend_metadata"]["upgradeAcknowledgement"]
    assert saved["targetImage"] == image and saved["operationId"] == "op_browser_recovery"
    spec = backend.inspect_pod_configuration.call_args.args[0]
    assert spec.browser_qualification == qualification and spec.upgrade_target_image == image
    assert not registry.claims and not backend.upgrade.called
    row["backend_metadata"]["upgradeApproval"]["browserPlanDigest"] = "f" * 64
    row["backend_metadata"].pop("upgradeAcknowledgement", None)
    assert await service.list_upgrade_candidates(current_image=newer_target) == []
