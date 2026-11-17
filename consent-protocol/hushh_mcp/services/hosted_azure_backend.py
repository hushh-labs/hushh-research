# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Hussh-Hosted Microsoft Azure backend inside HushOne Inc. Umbrella Compute Cells.

Implements the standard 5-method ``ComputeBackend`` contract for ``deployment_target="azure"``
while binding pre-warmed Azure Container App skeleton slots inside the governed Dev cell
with zero-secret OIDC Workload Identity Federation, isolated per-slot Blob containers,
isolated per-slot Key Vault keys/secrets, disabled Azure voice, and non-sandbox Chromium
settings required on Container Apps hypervisor containers.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Optional

from hushh_mcp.services import azure_federation
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_container_app_renderer import (
    AgentCoordinates,
    render_container_app,
)
from hushh_mcp.services.compute_backend import (
    BACKEND_AZURE,
    TIER_DEDICATED,
    BackendHandle,
    BackendStatus,
    PodSpec,
)
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError

_DEFAULT_HUB_CALLER = "consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com"
_DEFAULT_DEV_ORIGIN = "https://dev.one.hussh.ai"
_DEFAULT_DEV_HUB_URL = "https://consent-protocol-aqahj4iyha-uc.a.run.app"
_DEFAULT_CORS_ORIGINS = (
    "https://dev.one.hushh.ai,https://dev.one.hussh.ai,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:3001,http://127.0.0.1:3001"
)


@dataclass(frozen=True)
class HostedAzureCellSlotSpec:
    """Resolved coordinate bundle for one slot inside a Hussh-Hosted Azure Umbrella Cell."""

    cell_id: str
    slot_id: str
    organization: str
    tenant_id: str
    subscription_id: str
    resource_group: str
    location: str
    environment_id: str
    registry_server: str
    image_digest: str
    controller_client_id: str
    app_name: str
    app_id: str
    fqdn: str
    identity_id: str
    identity_client_id: str
    blob_url: str
    key_vault_key: str
    signing_secret_url: str
    openai_endpoint: str
    openai_deployment: str


def _upsert_env(env: list[dict[str, Any]], updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names = {str(entry["name"]) for entry in updates}
    return [entry for entry in env if entry.get("name") not in names] + list(updates)


def _owner_hash(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


class HostedAzureBackend:
    """ComputeBackend adapter for Hussh-Hosted Azure Container Apps inside Umbrella Cells."""

    backend_id = BACKEND_AZURE

    def __init__(
        self,
        *,
        slot: HostedAzureCellSlotSpec | None = None,
        arm_client: ArmClient | None = None,
        token_provider: Callable[[], str] | None = None,
        live: bool | None = None,
    ) -> None:
        self._slot = slot
        self._arm_client = arm_client
        self._token_provider = token_provider
        self._live = bool(live) if live is not None else (deploy_lane() == "dev")

    def _require_dev_authority(self) -> HostedAzureCellSlotSpec:
        if deploy_lane() != "dev":
            raise HostedTierNotPermittedError(
                "Hussh-Hosted Azure Umbrella Cells are restricted to the dev lane"
            )
        if self._slot is None:
            raise ValueError("HostedAzureBackend requires an explicit Umbrella Cell slot")
        return self._slot

    def _client(self) -> ArmClient:
        if self._arm_client is not None:
            return self._arm_client
        slot = self._require_dev_authority()
        if self._token_provider is not None:
            return ArmClient(self._token_provider)
        client_id = (os.getenv("HUSSH_HOSTED_AZURE_CLIENT_ID") or slot.controller_client_id).strip()
        return ArmClient(
            lambda: azure_federation.app_token(slot.tenant_id, client_id=client_id).access_token
        )

    def _hub_caller_email(self) -> str:
        raw = (
            os.getenv("HUSSH_POD_HUB_CALLER_EMAILS")
            or os.getenv("HUSSH_CONSENT_PLANE_SA")
            or os.getenv("HUSSH_POD_INVOKER_MEMBER")
            or _DEFAULT_HUB_CALLER
        ).strip()
        return raw.removeprefix("serviceAccount:") or _DEFAULT_HUB_CALLER

    def _coordinates(self, slot: HostedAzureCellSlotSpec, *, incarnation: str) -> AgentCoordinates:
        return AgentCoordinates(
            location=slot.location,
            environment_id=slot.environment_id,
            identity_id=slot.identity_id,
            identity_client_id=slot.identity_client_id,
            registry_server=slot.registry_server,
            image_digest=slot.image_digest,
            blob_url=slot.blob_url,
            key_vault_key=slot.key_vault_key,
            signing_secret_url=slot.signing_secret_url,
            incarnation=incarnation,
            hub_caller_emails=self._hub_caller_email(),
            openai_endpoint=slot.openai_endpoint,
            openai_deployment=slot.openai_deployment,
            tags={
                "hussh-tenancy": "hussh-hosted",
                "hussh-environment": "dev",
                "hussh-cell-id": slot.cell_id,
                "hussh-slot-id": slot.slot_id,
            },
        )

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        slot = self._slot
        if slot is None:
            from hushh_mcp.services.pod_umbrella_cell_pool import UmbrellaCellRegistry

            cell = UmbrellaCellRegistry().azure_cell()
            first = cell.slots[0]
            slot = HostedAzureCellSlotSpec(
                cell_id=cell.cell_id,
                slot_id=first.slot_id,
                organization=cell.organization,
                tenant_id=cell.tenant_id,
                subscription_id=cell.subscription_id,
                resource_group=cell.resource_group,
                location=cell.location,
                environment_id=cell.environment_id,
                registry_server=cell.registry_server,
                image_digest=cell.image_digest,
                controller_client_id=cell.controller_client_id,
                app_name=first.app_name,
                app_id=first.app_id,
                fqdn=first.fqdn,
                identity_id=first.identity_id,
                identity_client_id=first.identity_client_id,
                blob_url=first.blob_url,
                key_vault_key=first.key_vault_key,
                signing_secret_url=first.signing_secret_url,
                openai_endpoint=cell.openai_endpoint,
                openai_deployment=cell.openai_deployment,
            )

        incarnation = (spec.expected_service_uid or "").strip() or secrets.token_hex(16)
        coords = self._coordinates(slot, incarnation=incarnation)
        body = render_container_app(spec, coords)
        body["tags"] = {
            **body.get("tags", {}),
            "hussh-pool-state": "bound_active",
            "hussh-owner-hash": _owner_hash(spec.hushh_id),
        }

        from hushh_mcp.runtime_settings import get_app_runtime_settings

        container = body["properties"]["template"]["containers"][0]
        container["env"] = _upsert_env(
            list(container.get("env") or []),
            [
                {"name": "PERSONAL_AGENT_ENABLED", "value": "1"},
                {"name": "HUSHH_DEPLOY_ENV", "value": "dev"},
                {
                    "name": "HUSSH_HUB_BASE_URL",
                    "value": (os.getenv("HUSSH_HUB_BASE_URL") or _DEFAULT_DEV_HUB_URL).strip(),
                },
                {
                    "name": "APP_FRONTEND_ORIGIN",
                    "value": (
                        get_app_runtime_settings().app_frontend_origin or _DEFAULT_DEV_ORIGIN
                    ).strip(),
                },
                {
                    "name": "CORS_ALLOWED_ORIGINS",
                    "value": (os.getenv("CORS_ALLOWED_ORIGINS") or _DEFAULT_CORS_ORIGINS).strip(),
                },
                {"name": "HUSSH_POD_TURN_ENABLED", "value": "true"},
                {"name": "HUSSH_POD_MIGRATION_ENABLED", "value": "true"},
                {"name": "POD_LOCAL_PKM_ENABLED", "value": "true"},
                {"name": "AZURE_OPENAI_VOICE_ENABLED", "value": "false"},
                {"name": "CHROMIUM_SANDBOX", "value": "false"},
                {"name": "HUSSH_POD_CELL_ID", "value": slot.cell_id},
                {"name": "HUSSH_POD_SLOT_ID", "value": slot.slot_id},
            ],
        )
        return body

    async def health(self) -> bool:
        return deploy_lane() == "dev" and bool(self._live)

    def bind_slot_to_owner_sync(
        self, spec: PodSpec, *, service_uid: str | None = None
    ) -> BackendHandle:
        """Bind a pre-warmed skeleton Container App to ``spec.hushh_id`` via one ARM PUT."""
        slot = self._require_dev_authority()
        incarnation = (service_uid or spec.expected_service_uid or "").strip() or secrets.token_hex(
            16
        )
        bound_spec = PodSpec(
            hushh_id=spec.hushh_id,
            phone_e164_hash=spec.phone_e164_hash,
            pod_pubkey=spec.pod_pubkey,
            region=slot.location,
            tier=spec.tier or TIER_DEDICATED,
            billing_space_id=spec.billing_space_id,
            runtime_version=spec.runtime_version,
            prompt_version=spec.prompt_version,
            expected_service_uid=incarnation,
            deployment_target=BACKEND_AZURE,
            model_credential_mode=spec.model_credential_mode or "byok_per_turn",
        )
        body = self.render_deploy_config(bound_spec)
        arm = self._client()
        app = arm.put(
            slot.app_id,
            api_version=API_VERSIONS["container_apps"],
            body=body,
            op="hosted_azure_bind_slot",
        )
        props = app.get("properties") or {}
        config = props.get("configuration") or {}
        ingress = config.get("ingress") or {}
        fqdn = str(ingress.get("fqdn") or slot.fqdn).strip()
        url = f"https://{fqdn}" if not fqdn.startswith("https://") else fqdn
        latest_revision = str(
            props.get("latestReadyRevisionName") or props.get("latestRevisionName") or ""
        ).strip()
        image = str(
            ((props.get("template") or {}).get("containers") or [{}])[0].get("image")
            or f"{slot.registry_server}/consent-protocol-pod@{slot.image_digest}"
        ).strip()

        return BackendHandle(
            external_agent_id=slot.app_id,
            a2a_route=url,
            status="connecting",
            backend=BACKEND_AZURE,
            backend_metadata={
                "tenancy": "hussh-hosted",
                "provider": "azure",
                "ingress": "external",
                "cellId": slot.cell_id,
                "slotId": slot.slot_id,
                "service": slot.app_name,
                "serviceUid": incarnation,
                "revision": latest_revision,
                "url": url,
                "image": image,
                "image_digest": slot.image_digest,
                "blobUrl": slot.blob_url,
                "keyVaultKey": slot.key_vault_key,
                "identityId": slot.identity_id,
                "identityClientId": slot.identity_client_id,
                "tenantId": slot.tenant_id,
                "subscriptionId": slot.subscription_id,
                "resourceGroup": slot.resource_group,
                "location": slot.location,
                "openaiEndpoint": slot.openai_endpoint,
                "openaiDeployment": slot.openai_deployment,
            },
        )

    async def provision(self, spec: PodSpec) -> BackendHandle:
        return await asyncio.to_thread(self.bind_slot_to_owner_sync, spec)

    async def get(self, external_agent_id: str) -> BackendStatus:
        if not self._live:
            return BackendStatus(
                external_agent_id=external_agent_id, status="planned", healthy=False
            )
        arm = self._client()
        try:
            app = await asyncio.to_thread(
                arm.get,
                external_agent_id,
                api_version=API_VERSIONS["container_apps"],
                op="hosted_azure_observe",
            )
        except ArmError as exc:
            if exc.kind == "not_found":
                return BackendStatus(
                    external_agent_id=external_agent_id, status="gone", healthy=False
                )
            return BackendStatus(
                external_agent_id=external_agent_id, status="unknown", healthy=False
            )
        props = app.get("properties") or {}
        prov_state = str(props.get("provisioningState") or "").strip().lower()
        ready_rev = str(props.get("latestReadyRevisionName") or "").strip()
        healthy = prov_state == "succeeded" and bool(ready_rev)
        return BackendStatus(
            external_agent_id=external_agent_id,
            status="running" if healthy else (prov_state or "provisioning"),
            healthy=healthy,
        )

    async def deprovision(self, external_agent_id: str) -> None:
        raise HostedTierNotPermittedError(
            "Hosted Azure slot reclamation requires PodSkeletonPoolService lease release"
        )

    def observe_slot_sync(self, app_id: Optional[str] = None) -> dict[str, Any]:
        slot = self._require_dev_authority()
        return self._client().get(
            app_id or slot.app_id,
            api_version=API_VERSIONS["container_apps"],
            op="hosted_azure_observe",
        )


__all__ = [
    "HostedAzureBackend",
    "HostedAzureCellSlotSpec",
]
