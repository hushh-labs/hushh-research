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
  ``jit_person_authority``; without one it refuses, and ``live`` is False, so the
  orchestrator turns the call away before it claims an upgrade lease.
* ``deprovision`` refuses: Hussh holds no delete authority in the subscription.
  ``erase_owner_access`` revokes access instead and returns a receipt.

GONE IS A CONFIRMED ABSENCE, never a refused read: ``azure_agent_observation``
types what ARM lets Hussh read, and the registry-facing status for a confirmed
absence stays ``gone`` so the wake and reinit paths keep one vocabulary.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, Iterator, Optional

from hushh_mcp.services.azure_agent_observation import (
    AGENT_UNREADABLE,
    GONE_ACCESS_REMOVED,
    GONE_ENVIRONMENT_DELETED,
    GONE_OWNER_DELETED_AGENT,
    AzureAgentObservation,
    AzureAgentUnreadable,
    AzureJitAuthorizationRequired,
    adoption_refusal,
    approved_image_digests,
    observe_agent,
)
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
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

_JIT_PERSON_TOKEN: ContextVar[str] = ContextVar("hussh_azure_jit_person_token", default="")


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


def _federation_configured() -> bool:
    from hushh_mcp.services import azure_federation  # noqa: PLC0415

    try:
        azure_federation.app_client_id()
        azure_federation.broker_service_account()
    except azure_federation.AzureFederationError:
        return False
    return True


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
        recorded_principal: str = "",
        recorded_digest: str = "",
    ) -> None:
        self._tenant = tenant_id
        self._subscription = subscription_id
        self._group = resource_group
        self._location = location
        self._observer_factory = observer
        self._person_factory = person or (lambda token: ArmClient(token))
        # What the registry recorded for this person's agent; adoption must match it.
        self._recorded_principal = recorded_principal.strip()
        self._recorded_digest = recorded_digest.strip()

    # -- identity and addressing ---------------------------------------------------

    @property
    def live(self) -> bool:
        """Whether THIS call may change the agent: only under the person's JIT sign-in.

        The orchestrator reads ``live`` before it claims an upgrade lease and refuses a
        backend that is not, so a call without the person's token (the upgrade sweep,
        an operator script) is turned away before anything durable is written. True on
        federation alone let the sweep claim the lease, fail on the missing token and
        keep the lease, which nothing on Azure can resolve. Reads and restarts never
        consult ``live``.
        """
        if not _JIT_PERSON_TOKEN.get():
            return False
        return self._observer_factory is not None or _federation_configured()

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
            raise observation.refusal("attach")
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
        """Adopt only this person's bound agent, on its recorded identity and an approved digest.

        The pod then proves its key (the orchestrator's key pull) before anything is
        granted. An unreadable agent raises rather than reading as nothing to adopt.
        """
        observation = await self.observe()
        if not observation.present:
            if observation.absence_confirmed:
                return None
            raise observation.refusal("adopt")
        try:
            handle = self.verified_handle(hushh_id, observation)
        except RuntimeError:
            logger.warning("user_azure_backend.discover_foreign group=%s", self._group)
            return None
        refused = adoption_refusal(
            handle.backend_metadata or {},
            recorded_principal=self._recorded_principal,
            recorded_digest=self._recorded_digest,
        )
        if refused:
            logger.warning("user_azure_backend.discover_refused reason=%s", refused)
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
        """``gone`` only on a confirmed absence; an unreadable agent raises."""
        if external_agent_id and external_agent_id != self.app_id:
            raise ValueError("this agent id does not belong to the recorded subscription")
        observation = await self.observe()
        if not observation.present:
            if not observation.absence_confirmed:
                raise observation.refusal("observe")
            return BackendStatus(external_agent_id=self.app_id, status="gone", healthy=False)
        return BackendStatus(
            external_agent_id=self.app_id,
            status="live" if observation.ready else "deploying",
            healthy=observation.ready,
        )

    async def gone_reason(self) -> str:
        """Why the agent is not present, or "" when it is. For display only."""
        return (await self.observe()).gone_reason

    async def restart(self, spec: PodSpec) -> dict[str, Any]:
        """Heal: restart the latest revision, with the observer's restart action only."""

        def _restart() -> dict[str, Any]:
            observation = self.observe_sync()
            if not observation.present:
                raise observation.refusal("restart")
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

    async def observe_erasure_target(self, spec: PodSpec) -> dict[str, str]:
        """The serving incarnation an erasure order must match (``azure_agent_erasure``)."""
        from hushh_mcp.services.azure_agent_erasure import erasure_target  # noqa: PLC0415

        return await asyncio.to_thread(erasure_target, self, spec)

    async def erase_owner_access(
        self, spec: PodSpec, *, crypto_erase: Callable[[], Awaitable[dict]]
    ) -> dict[str, Any]:
        """Fence, agent crypto-erase, revoke the agent, revoke Hussh last; a receipt."""
        from hushh_mcp.services.azure_agent_erasure import erase_through_backend  # noqa: PLC0415

        return await erase_through_backend(
            self, spec, observer=self._observer(), crypto_erase=crypto_erase
        )

    async def deprovision(self, external_agent_id: str) -> None:
        raise AzureJitAuthorizationRequired(
            "Hussh holds no delete authority in your subscription; erasure revokes its "
            "access and the receipt names what to delete"
        )

    async def health(self) -> bool:
        return True


__all__ = [
    "AGENT_UNREADABLE",
    "GONE_ACCESS_REMOVED",
    "GONE_ENVIRONMENT_DELETED",
    "GONE_OWNER_DELETED_AGENT",
    "AzureAgentObservation",
    "AzureAgentUnreadable",
    "AzureJitAuthorizationRequired",
    "UserAzureBackend",
    "adoption_refusal",
    "approved_image_digests",
    "current_jit_token",
    "jit_person_authority",
    "observe_agent",
    "verified_handle",
]
