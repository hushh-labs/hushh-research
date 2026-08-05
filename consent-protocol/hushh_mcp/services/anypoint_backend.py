"""Anypoint compute backend — primary target for general / mass-market deployments.

Implements the ``ComputeBackend`` contract for MuleSoft Anypoint so the SAME
interchangeable interface can target Anypoint as well as GCP (ARCHITECTURE.md §5).
Per the founder direction (2026-07), the primary target is chosen **per workload
class**: **Anypoint is primary for general / mass-market deployments** — primary
because Hushh holds **pre-purchased Titanium capacity** (already paid for -> best
cost at 1B scale), operated by the dedicated MuleSoft team on CloudHub 2.0 /
Runtime Fabric; it hosts the per-user pod AND carries the enterprise lane (consent
events, syncs, and data-correction requests). Its FedRAMP posture is **Moderate**
(MuleSoft Government Cloud). **GCP is primary for the FedRAMP-High / government /
regulated tier** (FedRAMP High + validated / live-wired). Because the seam is
backend-neutral, this per-workload routing is a configuration choice, not an
architecture change.

Auth mirrors the existing outbound OmniGateway CRM connector (Connected-App OAuth
``client_credentials``): ``ANYPOINT_PROVISION_CLIENT_ID`` / ``_SECRET`` /
``_BASE_URL`` / ``ANYPOINT_ENV_ID``. Deployment is via the AMC Application Manager
API (CloudHub 2.0 / Runtime Fabric), optionally pinned to a ``Private Space``
(``ANYPOINT_PRIVATE_SPACE_ID``) for network isolation.

**Inert by default.** Plan/dry-run mode renders the deployable Mule descriptor +
the routing handle but makes **no live Anypoint call**. Live execution is gated
behind ``HUSSH_ANYPOINT_BACKEND_LIVE`` + credentials and the written MuleSoft API
confirmation, and raises ``NotImplementedError`` until wired. No secret is baked
into the rendered artifact.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
    BACKEND_ANYPOINT,
    TIER_LOGICAL,
    BackendHandle,
    BackendStatus,
    PodSpec,
)

logger = logging.getLogger(__name__)

# Same stable Hushh A2A address as every other backend (Layer A indirection):
# the agent's address never changes when its host does.
A2A_ADDRESS_BASE = "https://a2a.hushh.ai/u"

_NAME_SAFE = re.compile(r"[^a-z0-9-]+")


def _app_name(hushh_id: str) -> str:
    """A CloudHub-safe Mule application name (lowercase, hyphens, <=42 chars)."""
    slug = _NAME_SAFE.sub("-", str(hushh_id or "").lower()).strip("-")
    return f"one-pod-{slug}"[:42].rstrip("-")


class AnypointBackend:
    """Provision a user's agent app on Anypoint (AMC Application Manager API).
    Plan-mode by default; live execution is credential + confirmation gated."""

    backend_id = BACKEND_ANYPOINT

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        env_id: Optional[str] = None,
        private_space_id: Optional[str] = None,
        replicas: int = 1,
        vcores: str = "0.1",
        live: Optional[bool] = None,
    ) -> None:
        self._base_url = base_url if base_url is not None else _env("ANYPOINT_PROVISION_BASE_URL")
        self._env_id = env_id if env_id is not None else _env("ANYPOINT_ENV_ID")
        # Private Space pins the CloudHub 2.0 app to an isolated network (per-user
        # isolation for the consent + zero-knowledge posture). Optional: unset ->
        # the descriptor omits it and the environment default applies.
        self._private_space_id = (
            private_space_id if private_space_id is not None else _env("ANYPOINT_PRIVATE_SPACE_ID")
        )
        self._replicas = replicas
        self._vcores = vcores
        # Live is OFF unless explicitly enabled AND credentials + MuleSoft API
        # confirmation exist (verbal capacity claim is not a contract).
        self._live = bool(live) if live is not None else _flag("HUSSH_ANYPOINT_BACKEND_LIVE")

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        """The deployable AMC Application Manager descriptor for this user's app.

        A CloudHub 2.0 deployment body: private endpoint, per-pod identity
        properties (never secrets), pinned replicas/vCores. Exact AMC schema is
        validated against MuleSoft at live-enablement; the shape here is the
        deploy contract we mirror from the OmniGateway connector.
        """
        name = _app_name(spec.hushh_id)
        deployment_settings: dict[str, Any] = {
            "http": {"inbound": {"publicUrl": "", "internal": True}},
            "runtimeVersion": spec.runtime_version or "",
        }
        # Pin to a Private Space for per-user network isolation when configured.
        if self._private_space_id:
            deployment_settings["privateSpaceId"] = self._private_space_id

        # The SAME image runs here as on Cloud Run, so it reads the SAME names. These
        # are the capability slots `test_compute_backend_parity.py` holds every
        # platform to; a slot that is absent is not "unconfigured", it is a pod that
        # cannot do its job on this platform.
        properties: dict[str, str] = {
            "HUSSH_ID": spec.hushh_id,
            "HUSSH_SPACE_ID": spec.space_id or "",
            "HUSSH_REGION": spec.region or "",
            "HUSSH_RUNTIME_VERSION": spec.runtime_version or "",
            "HUSSH_PROMPT_VERSION": spec.prompt_version or "",
            # The pod's ONE data-plane door. It holds no database credential, so
            # everything it needs travels pod -> hub -> Postgres through this URL.
            "HUSSH_HUB_BASE_URL": _env("HUSSH_HUB_BASE_URL") or "",
            # A pod exists only because the feature was enabled to provision it, and
            # the route it mounts 404s without this.
            "PERSONAL_AGENT_ENABLED": "1",
            # The consent-token VERIFYING keys (Ed25519, public half only). This is
            # what lets a pod check a token at its own door while holding nothing
            # that could forge one.
            "CONSENT_ED25519_PUBLIC_KEYS": _env("CONSENT_ED25519_PUBLIC_KEYS") or "",
        }
        # Model access on CloudHub is BYOK -- the user's own AI connection, exactly
        # the path Gemini BYOK already takes today. There is no Vertex here and no
        # ambient Google identity to borrow, so this renders FALSE deliberately:
        # the runtime provider factory reads this name, and it must not attempt
        # managed Vertex ADC on a platform that has none.
        #
        # No project, no location, and above all NO KEY. A BYOK key is turn-bounded
        # -- it arrives with the request and is isolated from backend ADC and
        # environment keys by construction (`runtime_providers/factory.py`) -- so a
        # credential in this artifact would be both wrong and a leak. On this
        # platform the capability is satisfied at RUNTIME, not at deploy time,
        # which is why the slot is a mode declaration and never a credential.
        properties["GOOGLE_GENAI_USE_VERTEXAI"] = "false"

        # APP_SIGNING_KEY arrives BY REFERENCE, never as a value -- with HMAC the
        # power to verify is the power to forge, so a rendered key would put a
        # universal forger in the deploy artifact. Mule resolves `${secure::...}`
        # from the environment's secure properties; the placeholder is the
        # reference, and it is only emitted when a secret is actually configured
        # (mirroring the Cloud Run secretKeyRef mount).
        secure_properties: dict[str, str] = {}
        if _env("HUSSH_POD_SIGNING_KEY_SECRET"):
            secure_properties["APP_SIGNING_KEY"] = "${secure::hussh.pod.signing.key}"

        return {
            "name": name,
            "target": {
                "provider": "MC",
                "targetId": self._env_id or "",
                "deploymentSettings": deployment_settings,
            },
            "application": {
                "desiredState": "STARTED",
                "configuration": {
                    "mule.agent.application.properties.service": {
                        # Identity, pins + capability slots; no secret VALUE in the
                        # artifact -- signing material is a reference only.
                        "properties": properties,
                        "secureProperties": secure_properties,
                    }
                },
                "vCores": self._vcores,
            },
            "replicas": self._replicas,
            "labels": ["hussh-one-pod", f"tier:{spec.tier}"],
        }

    async def provision(self, spec: PodSpec) -> BackendHandle:
        config = self.render_deploy_config(spec)
        name = str(config["name"])
        route = f"{A2A_ADDRESS_BASE}/{spec.hushh_id}"
        metadata = {
            "envId": self._env_id,
            "app": name,
            "target": "cloudhub-2",
            "tier": spec.tier,
            "replicas": self._replicas,
            "vCores": self._vcores,
        }
        if self._live:
            return await self._execute(spec, config)
        logger.info("anypoint_backend.plan app=%s tier=%s", name, spec.tier)
        return BackendHandle(
            external_agent_id=name,
            a2a_route=route,
            status="planned",
            backend=self.backend_id,
            backend_metadata=metadata,
            attestation_ref=None,  # Anypoint has no Confidential-Space equivalent
        )

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            raise NotImplementedError("anypoint_backend live deprovision is not wired yet")
        logger.info("anypoint_backend.plan_deprovision app=%s", external_agent_id)
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        if self._live:
            raise NotImplementedError("anypoint_backend live status is not wired yet")
        return BackendStatus(
            external_agent_id=(external_agent_id or None), status="planned", healthy=True
        )

    async def health(self) -> bool:
        return True

    async def _execute(self, spec: PodSpec, config: dict[str, Any]) -> BackendHandle:
        """Live AMC Application Manager provisioning. GATED: needs Connected-App
        credentials, the written MuleSoft API/capacity confirmation, and founder
        sign-off, so it is not wired here."""
        raise NotImplementedError(
            "anypoint_backend live provisioning (AMC Application Manager API) is not "
            "wired yet; it needs Connected-App credentials, the written MuleSoft API + "
            "1B-capacity confirmation, and founder sign-off (ROADMAP.md M7)."
        )


def _env(name: str) -> Optional[str]:
    value = (os.getenv(name) or "").strip()
    return value or None


def _flag(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}


__all__ = ["AnypointBackend", "TIER_LOGICAL", "A2A_ADDRESS_BASE"]
