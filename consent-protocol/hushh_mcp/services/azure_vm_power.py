"""Bounded VM power control behind the existing ARM authority and receipts.

This provider port does not provision, grant permissions, claim an owner wake,
or report application readiness. Its caller must hold the durable owner operation
before dispatch and reconcile any uncertain receipt before permitting a retry.
The customer VM offer remains unavailable until that lifecycle is composed.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal

from hushh_mcp.services.azure_agent_observation import assigned_identity
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_arm_mutations import ArmMutationJournal
from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation

_API = API_VERSIONS["virtual_machines"]
_POWER = frozenset(
    {
        "starting",
        "running",
        "stopping",
        "stopped",
        "deallocating",
        "deallocated",
        "unknown",
    }
)


class AzureVmPowerRefused(RuntimeError):
    """Stable metadata only; provider bodies and credentials never enter a receipt."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class AzureVmPowerTarget:
    installation: AzureVmInstallation
    identity_resource_id: str
    principal_id: str
    location: str
    # Tags are frozen by the owner operation, not copied from a fresh provider GET.
    binding_tags: Mapping[str, str] = field(repr=False)

    def __post_init__(self) -> None:
        resource = self.installation.resource_id
        group = resource[: resource.casefold().index("/providers/")]
        prefix = group + "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/"
        if (
            not self.identity_resource_id.casefold().startswith(prefix.casefold())
            or "/" in self.identity_resource_id[len(prefix) :]
            or not self.identity_resource_id[len(prefix) :]
            or not self.principal_id
            or not self.location
            or not self.binding_tags
            or any(not key or not value for key, value in self.binding_tags.items())
        ):
            raise AzureVmPowerRefused("VM_POWER_TARGET_INVALID")
        expected = {
            "husshPod": self.installation.hushh_id,
            "husshPodGeneration": self.installation.generation,
            "husshPodImage": self.installation.image_digest,
        }
        if any(self.binding_tags.get(key) != value for key, value in expected.items()):
            raise AzureVmPowerRefused("VM_POWER_INSTALLATION_BINDING_REQUIRED")
        # A caller mutating its original mapping cannot change admitted terms.
        object.__setattr__(self, "binding_tags", MappingProxyType(dict(self.binding_tags)))

    def require_current(self, body: dict) -> None:
        expected = self.installation
        principal, client = assigned_identity(body, self.identity_resource_id)
        properties, tags = body.get("properties"), body.get("tags")
        if (
            not isinstance(properties, dict)
            or not isinstance(tags, dict)
            or str(body.get("id", "")).casefold() != expected.resource_id.casefold()
            or str(body.get("location", "")).casefold() != self.location.casefold()
            or str(properties.get("vmId", "")).casefold() != expected.vm_id
            or principal.casefold() != self.principal_id.casefold()
            or client.casefold() != expected.client_id
            or any(tags.get(key) != value for key, value in self.binding_tags.items())
        ):
            raise AzureVmPowerRefused("VM_POWER_IDENTITY_CHANGED")


@dataclass(frozen=True)
class AzureVmPowerReceipt:
    resource_id: str
    vm_id: str
    power_state: str
    mutation_submitted: bool
    application_ready: Literal[False] = False


class AzureVmPower:
    """Blocking provider operations; invoke off the application event loop.

    No operation ever replays a POST after a timeout. Running/stopped/deallocated
    describe provider billing states only. The ordinary signed pod admission and
    recovery checks remain necessary before serving owner work.
    """

    def __init__(
        self,
        *,
        target: AzureVmPowerTarget,
        arm: ArmClient,
        journal: ArmMutationJournal,
        require_operation: Callable[[], None],
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._target, self._guard = target, require_operation
        self._clock, self._sleep = clock, sleep
        self._arm = arm.with_mutations(journal)

    def observe(self) -> str:
        return self._observe(self._arm)

    def _observe(self, arm: ArmClient) -> str:
        self._guard()
        resource = self._target.installation.resource_id
        self._target.require_current(arm.get(resource, api_version=_API))
        body = arm.get(resource + "/instanceView", api_version=_API)
        values = body.get("statuses")
        if not isinstance(values, list):
            raise AzureVmPowerRefused("VM_POWER_OBSERVATION_INVALID")
        states: list[str] = [
            item["code"].removeprefix("PowerState/")
            for item in values
            if isinstance(item, dict)
            and isinstance(item.get("code"), str)
            and item["code"].startswith("PowerState/")
        ]
        if len(states) != 1 or states[0] not in _POWER:
            raise AzureVmPowerRefused("VM_POWER_OBSERVATION_INVALID")
        # Reject a replacement or revoked operation across the separate reads.
        self._target.require_current(arm.get(resource, api_version=_API))
        self._guard()
        return states[0]

    def close(self) -> None:
        """Close this operation's transport after polling or an uncertain outcome."""
        self._arm.close()

    def __enter__(self) -> AzureVmPower:
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def start(self, *, timeout_seconds: int = 120) -> AzureVmPowerReceipt:
        return self._transition(
            "start",
            desired="running",
            eligible=frozenset({"stopped", "deallocated"}),
            pending=frozenset({"starting"}),
            timeout_seconds=timeout_seconds,
        )

    def deallocate(
        self, *, require_drained: Callable[[], None], timeout_seconds: int = 120
    ) -> AzureVmPowerReceipt:
        # The owner lifecycle verifies its authenticated idle receipt. A boolean
        # supplied by a browser, model or provider status is never that authority.
        return self._transition(
            "deallocate",
            desired="deallocated",
            eligible=frozenset({"running", "stopped"}),
            pending=frozenset({"deallocating"}),
            timeout_seconds=timeout_seconds,
            require_drained=require_drained,
        )

    def _transition(
        self,
        action: str,
        *,
        desired: str,
        eligible: frozenset[str],
        pending: frozenset[str],
        timeout_seconds: int,
        require_drained: Callable[[], None] = lambda: None,
    ) -> AzureVmPowerReceipt:
        if type(timeout_seconds) is not int or not 1 <= timeout_seconds <= 300:
            raise AzureVmPowerRefused("VM_POWER_DEADLINE_INVALID")
        deadline = self._clock() + timeout_seconds

        def remaining() -> float:
            value = deadline - self._clock()
            if value <= 0:
                raise AzureVmPowerRefused("VM_POWER_OUTCOME_UNCONFIRMED")
            return value

        client = self._arm.with_request_budget(remaining)
        try:
            return self._dispatch_and_observe(
                client, action, desired, eligible, pending, remaining, require_drained
            )
        finally:
            client.close()

    def _dispatch_and_observe(
        self,
        client: ArmClient,
        action: str,
        desired: str,
        eligible: frozenset[str],
        pending: frozenset[str],
        remaining: Callable[[], float],
        require_drained: Callable[[], None],
    ) -> AzureVmPowerReceipt:
        state, submitted = self._observe(client), False
        remaining()
        if state in eligible:

            def before_write() -> None:
                self._guard()
                self._target.require_current(
                    client.get(self._target.installation.resource_id, api_version=_API)
                )
                self._guard()
                # Keep the authenticated admission fence held until dispatch.
                # A provider GET must not separate the final drain check from POST.
                require_drained()
                self._guard()
                remaining()

            response = client.with_write_guard(before_write).request(
                "POST",
                self._target.installation.resource_id + "/" + action,
                api_version=_API,
                op="vm_" + action,
            )
            submitted = True
        elif state != desired and state not in pending:
            raise AzureVmPowerRefused("VM_POWER_TRANSITION_PENDING")
        while state != desired:
            self._sleep(min(2.0, remaining()))
            state = self._observe(client)
            remaining()
            if state not in pending | eligible | {desired}:
                raise AzureVmPowerRefused("VM_POWER_OUTCOME_UNCONFIRMED")
        if submitted:
            client.confirm_observed_mutation(response, succeeded=True)
        installation = self._target.installation
        return AzureVmPowerReceipt(installation.resource_id, installation.vm_id, state, submitted)
