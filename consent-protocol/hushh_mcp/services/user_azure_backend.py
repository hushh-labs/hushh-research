"""The private agent in the person's own Azure subscription (``user_azure``).

AUTHORITY, PER OPERATION (byoc-azure.md trust matrix)
* Creating the agent happens once, inside the setup job, under the person's own
  delegated token (``azure_agent_setup``). This backend never creates on standing
  authority.
* ``provision`` therefore ATTACHES: it reads the agent the person's setup created,
  with Hussh's federated observer identity, verifies the setup binding and the agent
  identity, and returns its address. The address (FQDN) is read from ARM by Hussh,
  never taken from a browser: it is the anchor the hub later pulls the agent's
  signing key from.
* ``restart`` (heal) uses the observer's ``revisions/restart/action``.
* ``upgrade`` needs a just-in-time person token (approve + sign-in), supplied with
  ``jit_person_authority``; without one it refuses.
* ``deprovision`` refuses: Hussh holds no delete authority in the subscription.
  ``erase_owner_access`` revokes access instead and returns a receipt.

GONE IS TYPED. A missing agent is classified from what ARM still lets Hussh read:
``owner_deleted_agent`` (the environment remains), ``environment_deleted`` (Azure's
idle-environment policy, or the owner, removed the environment; storage and vault
survive, so a JIT re-create adopts them), or ``access_removed`` (the owner removed
Hussh's access or deleted the resource group). The registry-facing status stays
``gone`` so the wake and reinit paths keep one vocabulary.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterator, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_plan import (
    NONCE_TAG,
    PlanInputs,
    app_id,
    environment_id,
    group_id,
    identity_id,
    resource_group_name,
)
from hushh_mcp.services.compute_backend import (
    BACKEND_USER_AZURE,
    RESOURCE_TIER_ECONOMY,
    BackendHandle,
    BackendStatus,
    PodSpec,
)

logger = logging.getLogger(__name__)

GONE_OWNER_DELETED_AGENT = "owner_deleted_agent"
GONE_ENVIRONMENT_DELETED = "environment_deleted"
GONE_ACCESS_REMOVED = "access_removed"

_JIT_PERSON_TOKEN: ContextVar[str] = ContextVar("hussh_azure_jit_person_token", default="")


class AzureJitAuthorizationRequired(RuntimeError):
    """This operation needs the person's approval and a fresh Microsoft sign-in."""

    code = "JIT_SIGN_IN_REQUIRED"


@contextmanager
def jit_person_authority(token: str) -> Iterator[None]:
    """Make one person's delegated ARM token available to this task, and only it.

    A context variable rather than a ``PodSpec`` field: a spec carries no secrets and
    is copied and logged freely, while this token must die with the job that holds it.
    ``asyncio.to_thread`` copies the context, so worker threads see it too.
    """
    if not token:
        raise AzureJitAuthorizationRequired("an empty token is not a sign-in")
    marker = _JIT_PERSON_TOKEN.set(token)
    try:
        yield
    finally:
        _JIT_PERSON_TOKEN.reset(marker)


def current_jit_token() -> str:
    token = _JIT_PERSON_TOKEN.get()
    if not token:
        raise AzureJitAuthorizationRequired(
            "Updating an agent in your Azure subscription needs your approval and a "
            "Microsoft sign-in; Hussh cannot change it on its own."
        )
    return token


@dataclass(frozen=True)
class AzureAgentObservation:
    present: bool
    gone_reason: str = ""
    app: dict[str, Any] = field(default_factory=dict, repr=False)

    def _properties(self) -> dict[str, Any]:
        return dict(self.app.get("properties") or {})

    @property
    def tags(self) -> dict[str, str]:
        return dict(self.app.get("tags") or {})

    @property
    def fqdn(self) -> str:
        ingress = (self._properties().get("configuration") or {}).get("ingress") or {}
        return str(ingress.get("fqdn") or "")

    @property
    def ready(self) -> bool:
        props = self._properties()
        latest = str(props.get("latestRevisionName") or "")
        return (
            str(props.get("provisioningState") or "") == "Succeeded"
            and bool(latest)
            and latest == str(props.get("latestReadyRevisionName") or "")
        )

    @property
    def image(self) -> str:
        containers = ((self._properties().get("template") or {}).get("containers")) or [{}]
        return str(containers[0].get("image") or "")

    def principal(self, identity: str) -> tuple[str, str]:
        identities = (self.app.get("identity") or {}).get("userAssignedIdentities") or {}
        entry = identities.get(identity) or {}
        return str(entry.get("principalId") or ""), str(entry.get("clientId") or "")


def _read_or_forbidden(arm: ArmClient, path: str) -> tuple[Optional[dict], bool]:
    """(resource or None, forbidden). Any refusal other than 403 propagates."""
    try:
        return arm.get_or_none(
            path, api_version=API_VERSIONS["container_apps"], op="observe"
        ), False
    except ArmError as exc:
        if exc.kind != "forbidden":
            raise
        return None, True


def observe_agent(arm: ArmClient, app_path: str, environment_path: str) -> AzureAgentObservation:
    """Present, or gone with the reason ARM still lets Hussh read."""
    app, _ = _read_or_forbidden(arm, app_path)
    if app is not None:
        return AzureAgentObservation(present=True, app=app)
    environment, forbidden = _read_or_forbidden(arm, environment_path)
    if forbidden:
        return AzureAgentObservation(present=False, gone_reason=GONE_ACCESS_REMOVED)
    reason = GONE_OWNER_DELETED_AGENT if environment is not None else GONE_ENVIRONMENT_DELETED
    return AzureAgentObservation(present=False, gone_reason=reason)


def verified_handle(
    hushh_id: str, observation: AzureAgentObservation, *, placement: dict[str, str]
) -> BackendHandle:
    """The registry handle for an agent bound to THIS person, or a refusal."""
    from hushh_mcp.services.azure_agent_setup import binding_is_valid  # noqa: PLC0415
    from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE  # noqa: PLC0415
    from hushh_mcp.services.pod_release import image_digest  # noqa: PLC0415

    subscription, group = placement["subscriptionId"], placement["resourceGroup"]
    tags = observation.tags
    principal, client = observation.principal(identity_id(subscription, group))
    if (
        tags.get("hussh-tenancy") != "user-owned"
        or not binding_is_valid(tags, hushh_id)
        or not principal
        or not tags.get(INCARNATION_TAG)
    ):
        raise RuntimeError("the agent in this subscription does not read back as this person's")
    if group != resource_group_name(hushh_id):
        raise RuntimeError("the recorded resource group is not this agent's")
    agent = app_id(subscription, group)
    return BackendHandle(
        external_agent_id=agent,
        a2a_route=f"{A2A_ADDRESS_BASE}/{hushh_id}",
        status="live" if observation.ready else "deploying",
        backend=BACKEND_USER_AZURE,
        backend_metadata={
            "tenancy": "user-owned",
            **placement,
            "service": agent,
            "url": f"https://{observation.fqdn}" if observation.fqdn else "",
            "ingress": "external",
            "image": observation.image,
            "image_digest": image_digest(observation.image),
            "serviceUid": tags[INCARNATION_TAG],
            "setupNonce": tags.get(NONCE_TAG, ""),
            "runtime_principal_id": principal,
            "runtime_client_id": client,
            "keyless": True,
            "credential": "federated observer: read and restart only",
            "livenessMode": RESOURCE_TIER_ECONOMY,
        },
    )


class UserAzureBackend:
    """One person's agent in their own subscription. Constructed per person, per call."""

    backend_id = BACKEND_USER_AZURE

    def __init__(
        self,
        *,
        tenant_id: str,
        subscription_id: str,
        resource_group: str,
        location: str,
        observer: Optional[Callable[[], ArmClient]] = None,
        person: Optional[Callable[[str], ArmClient]] = None,
    ) -> None:
        self._tenant = tenant_id
        self._subscription = subscription_id
        self._group = resource_group
        self._location = location
        self._observer_factory = observer
        self._person_factory = person or (lambda token: ArmClient(token))

    # -- identity and addressing ---------------------------------------------------

    @property
    def live(self) -> bool:
        """Reads and restarts are live once the federated app is configured."""
        from hushh_mcp.services import azure_federation  # noqa: PLC0415

        try:
            azure_federation.app_client_id()
            azure_federation.broker_service_account()
        except azure_federation.AzureFederationError:
            return self._observer_factory is not None
        return True

    @property
    def app_id(self) -> str:
        return app_id(self._subscription, self._group)

    def _observer(self) -> ArmClient:
        if self._observer_factory is not None:
            return self._observer_factory()
        from hushh_mcp.services import azure_federation  # noqa: PLC0415

        return ArmClient(lambda: azure_federation.app_token(self._tenant).access_token)

    def plan_inputs(self, hushh_id: str, nonce: str) -> PlanInputs:
        return PlanInputs(
            hushh_id=hushh_id,
            tenant_id=self._tenant,
            subscription_id=self._subscription,
            location=self._location,
            resource_group=self._group,
            nonce=nonce,
        )

    def provision_target_for(self, spec: PodSpec) -> dict[str, Any]:
        return {
            "backend": self.backend_id,
            "tenantId": self._tenant,
            "subscriptionId": self._subscription,
            "resourceGroup": self._group,
            "region": self._location,
            "service": self.app_id,
        }

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        """The dry-run agent body: real names, ``${placeholders}`` for setup outputs."""
        from hushh_mcp.services.azure_agent_setup import plan_factory  # noqa: PLC0415

        plan = plan_factory(
            spec,
            source_registry="<source-registry>",
            source_repository="<source-repository>",
            incarnation="${incarnation}",
        )(self.plan_inputs(spec.hushh_id, "0" * 16))
        return dict(next(step.body for step in plan.steps if step.path == self.app_id))

    # -- observation ---------------------------------------------------------------

    def observe_sync(self) -> AzureAgentObservation:
        return observe_agent(
            self._observer(), self.app_id, environment_id(self._subscription, self._group)
        )

    async def observe(self) -> AzureAgentObservation:
        return await asyncio.to_thread(self.observe_sync)

    def verified_handle(self, hushh_id: str, observation: AzureAgentObservation) -> BackendHandle:
        """A handle for an agent that reads back as THIS person's, or a refusal."""
        return verified_handle(
            hushh_id,
            observation,
            placement={
                "tenantId": self._tenant,
                "subscriptionId": self._subscription,
                "resourceGroup": self._group,
                "region": self._location,
            },
        )

    # -- the ComputeBackend contract -----------------------------------------------

    async def provision(self, spec: PodSpec) -> BackendHandle:
        """Attach to the agent the person's setup created; never create one here."""
        observation = await self.observe()
        if not observation.present:
            raise AzureJitAuthorizationRequired(
                f"no agent to attach in the person's subscription ({observation.gone_reason}); "
                "re-creating it needs their Microsoft sign-in"
            )
        handle = self.verified_handle(spec.hushh_id, observation)
        spec.emit_stage("host_created")
        if spec.provision_attempt_id and spec.on_provision_ack is not None:
            metadata = handle.backend_metadata or {}
            await asyncio.to_thread(
                spec.on_provision_ack,
                {
                    "service": self.app_id,
                    "serviceUid": metadata["serviceUid"],
                    "project": group_id(self._subscription, self._group),
                    "region": self._location,
                    "backend": self.backend_id,
                    "image": metadata["image"],
                },
            )
        if handle.status == "live":
            spec.emit_stage("host_serving")
        return handle

    async def discover(self, hushh_id: str) -> Optional[BackendHandle]:
        """Adopt only an agent bound to this person, with its identity, pinned by digest."""
        from hushh_mcp.services.pod_release import is_immutable_image_reference  # noqa: PLC0415

        observation = await self.observe()
        if not observation.present:
            return None
        try:
            handle = self.verified_handle(hushh_id, observation)
        except RuntimeError:
            logger.warning("user_azure_backend.discover_foreign group=%s", self._group)
            return None
        if not is_immutable_image_reference(observation.image):
            return None
        metadata = {**(handle.backend_metadata or {}), "adopted": True}
        return BackendHandle(
            external_agent_id=handle.external_agent_id,
            a2a_route=handle.a2a_route,
            status=handle.status,
            backend=handle.backend,
            backend_metadata=metadata,
        )

    async def get(self, external_agent_id: str) -> BackendStatus:
        if external_agent_id and external_agent_id != self.app_id:
            raise ValueError("this agent id does not belong to the recorded subscription")
        observation = await self.observe()
        if not observation.present:
            return BackendStatus(external_agent_id=self.app_id, status="gone", healthy=False)
        return BackendStatus(
            external_agent_id=self.app_id,
            status="live" if observation.ready else "deploying",
            healthy=observation.ready,
        )

    async def gone_reason(self) -> str:
        """Why the agent is gone, or "" when it is present."""
        return (await self.observe()).gone_reason

    async def restart(self, spec: PodSpec) -> dict[str, Any]:
        """Heal: restart the latest revision, with the observer's restart action only."""

        def _restart() -> dict[str, Any]:
            observation = self.observe_sync()
            if not observation.present:
                raise AzureJitAuthorizationRequired(
                    f"no agent to restart ({observation.gone_reason})"
                )
            self.verified_handle(spec.hushh_id, observation)
            revision = str(
                (observation.app.get("properties") or {}).get("latestRevisionName") or ""
            )
            if not revision:
                raise RuntimeError("the agent has no revision to restart")
            path = f"{self.app_id}/revisions/{revision}/restart"
            self._observer().post(path, api_version=API_VERSIONS["container_apps"], op="restart")
            return {"service": self.app_id, "revision": revision, "restarted": True}

        return await asyncio.to_thread(_restart)

    async def upgrade(self, spec: PodSpec) -> BackendHandle:
        """Move the agent to the approved digest. Needs ``jit_person_authority``."""
        from hushh_mcp.services.azure_agent_upgrade import upgrade_agent  # noqa: PLC0415

        token = current_jit_token()
        return await asyncio.to_thread(upgrade_agent, self, spec, self._person_factory(token))

    async def erase_owner_access(
        self, spec: PodSpec, *, crypto_erase: Callable[[], Awaitable[dict]]
    ) -> dict[str, Any]:
        """Fence, agent crypto-erase, revoke the agent, revoke Hussh last; a receipt."""
        from hushh_mcp.services.azure_agent_erasure import erase_owner_access  # noqa: PLC0415

        observation = await self.observe()
        if not observation.present:
            raise AzureJitAuthorizationRequired(f"no agent to erase ({observation.gone_reason})")
        handle = self.verified_handle(spec.hushh_id, observation)
        nonce = str((handle.backend_metadata or {}).get("setupNonce") or "")

        async def fence() -> None:
            current = await self.observe()
            fenced = self.verified_handle(spec.hushh_id, current)
            if (fenced.backend_metadata or {}).get("serviceUid") != (
                handle.backend_metadata or {}
            ).get("serviceUid"):
                raise RuntimeError("the agent was replaced during erasure; nothing was revoked")

        return await erase_owner_access(
            inputs=self.plan_inputs(spec.hushh_id, nonce),
            observer=self._observer(),
            verify_fence=fence,
            crypto_erase=crypto_erase,
        )

    async def deprovision(self, external_agent_id: str) -> None:
        raise AzureJitAuthorizationRequired(
            "Hussh holds no delete authority in your subscription; erasure revokes its "
            "access and the receipt names what to delete"
        )

    async def health(self) -> bool:
        return True


__all__ = [
    "GONE_ACCESS_REMOVED",
    "GONE_ENVIRONMENT_DELETED",
    "GONE_OWNER_DELETED_AGENT",
    "AzureAgentObservation",
    "AzureJitAuthorizationRequired",
    "UserAzureBackend",
    "current_jit_token",
    "jit_person_authority",
    "observe_agent",
    "verified_handle",
]
