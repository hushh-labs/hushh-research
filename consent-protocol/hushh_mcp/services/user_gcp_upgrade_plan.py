"""Admission and immutable image/configuration planning for owner-project upgrades."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.gcp_upgrade_observation import deployed_image_digest
from hushh_mcp.services.pod_files.hosted_upgrade import handoff_options
from hushh_mcp.services.pod_files.managed_worker import upgrade_thread
from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient

if TYPE_CHECKING:
    from hushh_mcp.services.pod_browser.capability_update import GcpBrowserCapabilityPlan
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan

logger = logging.getLogger(__name__)


class _Backend(Protocol):
    backend_id: str
    _tenancy: str
    _user_project: str | None
    _user_region: str
    _bootstrap_sa: str | None
    _image: str | None

    def _client(self) -> GcpRunClient: ...

    def _private_service_name(self, spec: PodSpec) -> str: ...

    def _pod_service_account(self, spec: PodSpec) -> str: ...

    def _ensure_pod_image(self, spec: PodSpec, recorded_digest: str | None = None) -> str: ...

    def render_deploy_config(
        self, spec: PodSpec, *, image_digest: str | None = None
    ) -> dict[str, Any]: ...

    def _gmail_notification_blocker(self, spec: PodSpec) -> str | None: ...

    def _apply_gmail_runtime_env(
        self, config: dict[str, Any], spec: PodSpec, url: str
    ) -> dict[str, Any]: ...

    def _user_pod_image_ref(self, spec: PodSpec, image_digest: str | None) -> str: ...

    async def _configure_gmail_delivery(
        self,
        client: GcpRunClient,
        spec: PodSpec,
        *,
        service: dict[str, Any],
        expected_uid: str,
        allow_runtime_replace: bool = True,
    ) -> tuple[dict[str, Any], dict[str, Any]]: ...


@dataclass
class _UpgradeState:
    backend: _Backend
    spec: PodSpec
    name: str
    route: str
    expected_uid: str
    client: GcpRunClient
    existing: dict[str, Any]
    connector_environment: dict[str, Any]
    connector_repair: bool
    files_capability: FilesCapabilityPlan | None
    browser_capability: GcpBrowserCapabilityPlan | None
    previous_digest: str | None
    handoff: PodUpgradeHandoffClient | None = None
    handoff_incarnation: str | None = None
    replacement_submitted: bool = False
    predecessor: dict[str, Any] | None = None


@dataclass
class _UpgradePlan:
    approved_ref: str
    recorded_digest: str | None
    image_digest: str
    config: dict[str, Any]
    notification_inventory: dict[str, Any] | None
    notification_changed: bool
    changed: bool


async def _prepare_state(backend: _Backend, spec: PodSpec, name: str, route: str) -> _UpgradeState:
    expected_uid = spec.expected_service_uid
    if not isinstance(expected_uid, str) or not expected_uid.strip():
        raise RuntimeError("pod incarnation unverified; recovery required before upgrade")
    client = await upgrade_thread(spec, backend._client)
    existing = await upgrade_thread(spec, client.get_service, name)
    if existing is None:
        raise RuntimeError(
            f"cannot upgrade {name}: no pod service exists in the person's project; "
            "provision (or adopt) it instead"
        )
    GcpRunClient.require_service_uid(existing, expected_uid)
    from hushh_mcp.services.pod_connector_configuration import capture_gcp_connector_repair

    connector_environment, connector_repair = capture_gcp_connector_repair(
        existing, spec.upgrade_operation_id
    )
    from hushh_mcp.services.pod_files.capability_update import approved_upgrade_plan

    files_capability = approved_upgrade_plan(
        spec, existing, project=backend._user_project, bootstrap_sa=backend._bootstrap_sa
    )
    _require_files_callbacks(spec, files_capability)
    from hushh_mcp.services.pod_browser.capability_update import approved_upgrade_browser_plan

    browser_capability = approved_upgrade_browser_plan(
        spec, existing, project=backend._user_project, bootstrap_sa=backend._bootstrap_sa
    )
    if browser_capability is not None:
        from hushh_mcp.services.pod_browser.delivery import require_gcp_delivery

        await upgrade_thread(spec, require_gcp_delivery, client, browser_capability)
    from hushh_mcp.services.hosted_update_configuration import require_update_observation

    require_update_observation(existing, spec, runtime=backend._pod_service_account(spec))
    return _UpgradeState(
        backend=backend,
        spec=spec,
        name=name,
        route=route,
        expected_uid=expected_uid,
        client=client,
        existing=existing,
        connector_environment=connector_environment,
        connector_repair=connector_repair,
        files_capability=files_capability,
        browser_capability=browser_capability,
        previous_digest=deployed_image_digest(existing),
    )


def _require_files_callbacks(spec: PodSpec, capability: FilesCapabilityPlan | None) -> None:
    if (
        capability is not None
        and spec.hosted_files_executor is not None
        and not all(
            callable(callback)
            for callback in (
                spec.on_hosted_files_replacement_intent,
                spec.on_hosted_files_provider_settled,
                spec.on_upgrade_ack,
            )
        )
    ):
        raise RuntimeError(
            "Managed Files replacement requires durable intent and terminal callbacks"
        )


async def _prepare_handoff(state: _UpgradeState) -> None:
    spec = state.spec
    if not spec.upgrade_operation_id:
        return
    from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient, service_incarnation

    pod_url = GcpRunClient.service_url(state.existing)
    state.handoff_incarnation = service_incarnation(state.existing)
    if not pod_url or not state.handoff_incarnation:
        raise RuntimeError("pod upgrade handoff capability is unavailable")
    state.handoff = PodUpgradeHandoffClient(url=pod_url, hushh_id=spec.hushh_id)
    try:
        idle_receipt = await upgrade_thread(
            spec,
            state.handoff.prepare_and_wait,
            operation_id=spec.upgrade_operation_id,
            incarnation=state.handoff_incarnation,
            **handoff_options(spec),
        )
        if spec.on_upgrade_idle is not None:
            await upgrade_thread(spec, spec.on_upgrade_idle, idle_receipt)
    except Exception:
        try:
            await upgrade_thread(
                spec,
                state.handoff.release,
                operation_id=spec.upgrade_operation_id,
                incarnation=state.handoff_incarnation,
                **handoff_options(spec),
            )
        except Exception:
            logger.info("user_gcp_backend.handoff_release_after_prepare_failed", exc_info=True)
        raise


async def _resolve_image_plan(state: _UpgradeState) -> _UpgradePlan:
    backend, spec = state.backend, state.spec
    approved_ref = str(spec.upgrade_target_image or "").strip()
    recorded_digest = approved_ref.rsplit("@", 1)[-1] if "@" in approved_ref else None
    if approved_ref and (not recorded_digest or not recorded_digest.startswith("sha256:")):
        raise RuntimeError("approved upgrade image is not an immutable digest")
    if spec.hosted_files_executor is not None and not recorded_digest:
        raise RuntimeError("approved upgrade image is not an immutable digest")
    image_digest = await upgrade_thread(spec, backend._ensure_pod_image, spec, recorded_digest)
    if recorded_digest is not None and image_digest != recorded_digest:
        raise RuntimeError("copied pod image digest differs from the approved source")
    config = backend.render_deploy_config(spec, image_digest=image_digest)
    existing_url = GcpRunClient.service_url(state.existing)
    notification_inventory = None
    if backend._gmail_notification_blocker(spec) is None:
        if not existing_url:
            raise RuntimeError("Gmail notifications require the existing verified pod URL")
        notification_inventory = backend._apply_gmail_runtime_env(config, spec, existing_url)
    return _UpgradePlan(
        approved_ref=approved_ref,
        recorded_digest=recorded_digest,
        image_digest=image_digest,
        config=config,
        notification_inventory=notification_inventory,
        notification_changed=False,
        changed=False,
    )


async def _apply_upgrade_configuration(state: _UpgradeState, plan: _UpgradePlan) -> None:
    backend, spec = state.backend, state.spec
    before_env = {
        item.get("name"): item.get("value")
        for item in state.existing.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [{}])[0]
        .get("env", [])
    }
    plan.notification_changed = plan.notification_inventory is not None and any(
        before_env.get(key) != value
        for key, value in plan.notification_inventory["runtimeEnv"].items()
    )
    from hushh_mcp.services.pod_upgrade_configuration import preserve_image_upgrade_configuration

    preserve_image_upgrade_configuration(
        state.existing, plan.config, connector_environment=state.connector_environment
    )
    if state.browser_capability is not None:
        from hushh_mcp.services.pod_browser.delivery import require_gcp_delivery

        await upgrade_thread(spec, require_gcp_delivery, state.client, state.browser_capability)
        state.browser_capability.apply_configuration(
            state.existing, plan.config, spec.browser_qualification
        )
    if state.files_capability is not None:
        from hushh_mcp.services.pod_files.capability_bootstrap import apply_upgrade_configuration

        await upgrade_thread(
            spec,
            apply_upgrade_configuration,
            state.files_capability,
            state.client,
            spec,
            state.existing,
            plan.config,
            bootstrap_sa=backend._bootstrap_sa,
            service_name=state.name,
        )
    plan.changed = (
        plan.image_digest != state.previous_digest
        or state.files_capability is not None
        or state.browser_capability is not None
        or plan.notification_changed
        or state.connector_repair
    )


async def _build_plan(state: _UpgradeState) -> _UpgradePlan:
    plan = await _resolve_image_plan(state)
    await _apply_upgrade_configuration(state, plan)
    return plan
