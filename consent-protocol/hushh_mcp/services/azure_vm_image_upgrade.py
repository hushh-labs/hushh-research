"""Execute one admitted image-only VM update, never replay an uncertain write.

The existing owner-JIT setup worker supplies the authority and retained plan.
This leaf does not provision a host or enable the customer hosting offer. Root
acknowledgement, encrypted recovery and exact-cursor release are separate proofs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable
from copy import deepcopy
from dataclasses import replace
from typing import TYPE_CHECKING

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_arm_mutations import body_commitment
from hushh_mcp.services.azure_setup_authority import AzureSetupAuthority
from hushh_mcp.services.azure_vm_host_binding import AzureVmHostBinding
from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused
from hushh_mcp.services.azure_vm_recovery import (
    verified_vm_release,
    verify_vm_drain,
    verify_vm_recovery,
)
from hushh_mcp.services.azure_vm_upgrade_plan import VmImageUpdatePlan, approved_vm_update
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.pod_upgrade_handoff import (
    PodUpgradeHandoffClient,
    PodUpgradeHandoffUnavailable,
)

if TYPE_CHECKING:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo


def _binding(row: dict, host: AzureVmHostBinding) -> dict:
    return {
        "host": host.record(),
        **{
            target: row.get(source)
            for target, source in (
                ("podKeyId", "pod_key_id"),
                ("podPublicKey", "pod_pubkey"),
                ("signingKeyId", "pod_signing_key_id"),
                ("signingPublicKey", "pod_signing_pubkey"),
            )
        },
    }


def _host_ack(
    body: dict, *, target_image: str, request_sha256: str, operation: str, previous: str
) -> dict:
    """Read only the fixed updater's bounded public receipt, never retain stdout."""
    output = body.get("properties", {}).get("output", body)
    values = output.get("value") if isinstance(output, dict) else None
    if not isinstance(values, list) or not 1 <= len(values) <= 4:
        raise RuntimeError("VM_UPDATE_HOST_ACK_UNCONFIRMED")
    receipts = []
    for item in values:
        message = item.get("message") if isinstance(item, dict) else None
        if not isinstance(message, str) or len(message.encode()) > 8192:
            raise RuntimeError("VM_UPDATE_HOST_ACK_UNCONFIRMED")
        # The VM agent may wrap stdout in its own status lines. The pinned
        # command emits exactly one JSON receipt; no arbitrary shell is accepted.
        for line in message.splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                receipts.append(value)
    if len(receipts) != 1:
        raise RuntimeError("VM_UPDATE_HOST_ACK_UNCONFIRMED")
    value = receipts[0]
    if (
        set(value)
        != {
            "version",
            "operation_id",
            "request_sha256",
            "configuration_sha256",
            "image",
            "stage",
            "application_verified",
        }
        or type(value.get("version")) is not int
        or value["version"] != 1
        or value.get("operation_id") != operation
        or value.get("request_sha256") != request_sha256
        or value.get("image") != target_image
        or value.get("stage") != "restart_requested"
        or value.get("application_verified") is not False
        or not isinstance(value.get("configuration_sha256"), str)
        or re.fullmatch(r"[a-f0-9]{64}", value["configuration_sha256"]) is None
        or value["configuration_sha256"] == previous
    ):
        raise RuntimeError("VM_UPDATE_HOST_ACK_UNCONFIRMED")
    return value


class VmImageUpgrade:
    """Blocking worker; its caller joins it before releasing setup authority."""

    def __init__(
        self,
        *,
        row: dict,
        spec: PodSpec,
        plan: VmImageUpdatePlan,
        receipt: dict,
        handoff: PodUpgradeHandoffClient,
        authority: AzureSetupAuthority,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.host, self.metadata, _ = approved_vm_update(row, spec)
        if spec.on_upgrade_ack is None:
            raise RuntimeError("VM_UPDATE_DURABLE_ACK_REQUIRED")
        self.spec, self.plan, self.receipt = spec, plan, deepcopy(receipt)
        self.client, self.authority = handoff, authority
        self.guard: Callable[[], None] | None = None
        self.clock, self.sleep, self.deadline = clock, sleep, clock() + 480
        self.operation = str(spec.upgrade_operation_id)
        self.binding = _binding(row, self.host)
        digest = plan.target_image.split("@", 1)[1]
        self.target = replace(
            self.host,
            image=plan.target_image,
            installation=self.host.installation.model_copy(update={"image_digest": digest}),
        )
        self.target_binding = _binding(row, self.target)
        self.restarted = False

    def remaining(self) -> float:
        if self.guard is None:
            raise RuntimeError("VM_UPDATE_WORKER_REQUIRED")
        self.guard()
        self.authority.assert_admitted()
        value = self.deadline - self.clock()
        if value <= 0:
            raise RuntimeError("VM_UPDATE_OUTCOME_UNCONFIRMED")
        return min(value, 60.0)

    def _check_guard(self) -> None:
        self.remaining()

    def _fresh_fence(self, arm: ArmClient) -> None:
        self.remaining()
        observed = arm.get(
            self.host.installation.resource_id,
            api_version=API_VERSIONS["virtual_machines"],
            op="vm_update_identity",
        )
        self.host.target().require_current(observed)  # tag remains old until phase three
        snapshot = self.client.recovery_snapshot()
        if not self.restarted:
            verify_vm_drain(snapshot, self.binding, self.receipt, self.operation)
        else:
            verify_vm_recovery(snapshot, self.target_binding, self.receipt, self.operation)
            status = snapshot["status"]
            if status.get("state") != "idle" or status.get("activeWork") != 0:
                raise RuntimeError("VM_UPDATE_DRAIN_UNCONFIRMED")
        self.remaining()  # I/O above cannot precede the final owner/session check.

    def _recovery(self) -> dict:
        while True:
            self.remaining()
            try:
                snapshot = self.client.recovery_snapshot()
                recovery: dict = verify_vm_recovery(
                    snapshot, self.target_binding, self.receipt, self.operation
                )
                if snapshot["status"].get("state") != "idle":
                    self.client.prepare_and_wait(
                        operation_id=self.operation,
                        incarnation=self.host.installation.generation,
                        timeout_seconds=120,
                        guard=self._check_guard,
                    )
                    recovery = verify_vm_recovery(
                        self.client.recovery_snapshot(),
                        self.target_binding,
                        self.receipt,
                        self.operation,
                    )
                return recovery
            except (PodUpgradeHandoffUnavailable, AzureVmPowerRefused):
                self.sleep(min(2.0, self.remaining()))

    def run(
        self, source: ArmClient, *, guard: Callable[[], None], advance: Callable[[str], None]
    ) -> BackendHandle:
        self.guard = guard  # run_setup_thread's joined cancellation boundary.
        arm = source.with_mutations(self.authority).with_request_budget(self.remaining)
        guarded = arm.with_write_guard(lambda: self._fresh_fence(arm))
        acknowledgement: dict | None = None
        try:
            for step in self.plan.steps():
                advance(step.stage)
                response = guarded.request(
                    step.method,
                    step.path,
                    api_version=API_VERSIONS[step.api],
                    body=step.body,
                    op=step.stage,
                    body_sha256=body_commitment(step.body),
                )
                body = (
                    guarded.wait(response, step.stage)
                    if guarded.needs_poll(response)
                    else response.body
                )
                if step.stage == "vm_image_replace":
                    acknowledgement = _host_ack(
                        body,
                        target_image=self.plan.target_image,
                        request_sha256=self.plan.host_request_sha256,
                        operation=self.operation,
                        previous=self.metadata["vmConfigurationSha256"],
                    )
                    self._acknowledge(acknowledgement)
                    self.restarted = True
                    self._recovery()
            self.target.target().require_current(
                guarded.get(
                    self.target.installation.resource_id,
                    api_version=API_VERSIONS["virtual_machines"],
                    op="vm_update_installed",
                )
            )
            if acknowledgement is None:
                raise RuntimeError("VM_UPDATE_HOST_ACK_UNCONFIRMED")
            recovery = self._recovery()
            status = self.client.release(
                operation_id=self.operation,
                incarnation=self.host.installation.generation,
                expected_idle_record=self.receipt["idleRecord"],
                guard=self._check_guard,
            )
            released = verified_vm_release(status, recovery, self.operation)
            return vm_image_handle(
                self.metadata,
                self.spec,
                self.host,
                self.target,
                acknowledgement,
                recovery,
                released,
            )
        finally:
            guarded.close()
            arm.close()

    def _acknowledge(self, host_ack: dict) -> None:
        callback = self.spec.on_upgrade_ack
        if callback is None:
            raise RuntimeError("VM_UPDATE_DURABLE_ACK_REQUIRED")
        callback(
            {
                "version": 1,
                "hostKind": "azure_vm",
                "attemptId": self.spec.upgrade_attempt_id,
                "externalAgentId": self.host.installation.resource_id,
                "service": self.host.installation.resource_id,
                "serviceUid": self.host.installation.generation,
                "image": self.target.image,
                "vmHostAck": host_ack,
                "idleReceipt": self.receipt,
            }
        )


def vm_image_handle(
    metadata: dict,
    spec: PodSpec,
    host: AzureVmHostBinding,
    target: AzureVmHostBinding,
    ack: dict,
    recovery: dict,
    released: dict,
) -> BackendHandle:
    return BackendHandle(
        external_agent_id=host.installation.resource_id,
        backend="user_azure",
        status="live",
        backend_metadata={
            **{
                key: deepcopy(value)
                for key, value in metadata.items()
                if key
                not in {"upgradeLease", "upgradeApproval", "upgradeAcknowledgement", "vmPower"}
            },
            "upgraded": True,
            "image": target.image,
            "image_digest": target.installation.image_digest,
            "vmHost": target.record(),
            "source_image": spec.upgrade_target_image,
            "previous_image": host.image,
            "vmConfigurationSha256": ack["configuration_sha256"],
            "vmUpdateVerification": {
                "operationId": spec.upgrade_operation_id,
                "attemptId": spec.upgrade_attempt_id,
                "host": ack,
                "recovery": recovery,
                "released": released,
                **(
                    {"previousPower": deepcopy(metadata["vmPower"])}
                    if "vmPower" in metadata
                    else {}
                ),
            },
        },
    )


def observe_vm_image_update(
    *,
    row: dict,
    spec: PodSpec,
    intent: dict,
    receipt: dict,
    source: ArmClient,
    handoff: PodUpgradeHandoffClient,
    guard: Callable[[], None],
    advance: Callable[[str], None],
) -> BackendHandle | None:
    """Recover only a settled replacement's sealed release, without any POST."""
    host, metadata, _ = approved_vm_update(row, spec, allow_unresolved=True)
    target_image = (
        host.image.split("@", 1)[0] + "@" + str(spec.upgrade_target_image).split("@", 1)[1]
    )
    target = replace(
        host,
        image=target_image,
        installation=host.installation.model_copy(
            update={"image_digest": target_image.split("@", 1)[1]}
        ),
    )
    ack = _host_ack(
        {"value": [{"message": json.dumps(receipt.get("vmHostAck"))}]},
        target_image=target_image,
        request_sha256=intent["hostRequestSha256"],
        operation=str(spec.upgrade_operation_id),
        previous=metadata["vmConfigurationSha256"],
    )
    deadline = time.monotonic() + 45

    def remaining() -> float:
        guard()
        value = deadline - time.monotonic()
        if value <= 0:
            raise RuntimeError("VM_UPDATE_OBSERVATION_UNCONFIRMED")
        return min(value, 20.0)

    arm = source.with_request_budget(remaining)
    try:
        target.target().require_current(
            arm.get(
                host.installation.resource_id,
                api_version=API_VERSIONS["virtual_machines"],
                op="vm_update_recovery_identity",
            )
        )
        snapshot = handoff.recovery_snapshot()
        recovery = verify_vm_recovery(
            snapshot, _binding(row, target), receipt["idleReceipt"], str(spec.upgrade_operation_id)
        )
        released = verified_vm_release(snapshot["status"], recovery, str(spec.upgrade_operation_id))
        target.target().require_current(
            arm.get(
                host.installation.resource_id,
                api_version=API_VERSIONS["virtual_machines"],
                op="vm_update_recovery_final_identity",
            )
        )
        remaining()
        return vm_image_handle(metadata, spec, host, target, ack, recovery, released)
    except (PodUpgradeHandoffUnavailable, AzureVmPowerRefused):
        return None  # A live/released verdict is required; no implicit release or replay.
    finally:
        arm.close()


async def release_unattempted_vm_update(
    *,
    registry: PersonalAgentRegistryRepo,
    owner: str,
    job: str,
    spec: PodSpec,
    binding: dict,
    handoff: PodUpgradeHandoffClient,
    receipt: dict,
) -> bool:
    """Restore old-agent admission only after an atomic no-dispatch block.

    The lease remains repairable and blocked. Any unknown provider request,
    active worker, erasure or replacement refuses release. No update is installed.
    """
    from hushh_mcp.services.azure_setup_worker import run_setup_thread

    loop = asyncio.get_running_loop()

    async def blocked() -> dict | None:
        value = await registry.block_unattempted_vm_upgrade(
            owner=owner,
            job=job,
            operation=str(spec.upgrade_operation_id),
            attempt=str(spec.upgrade_attempt_id),
            binding=binding,
        )
        return dict(value) if isinstance(value, dict) else None

    try:
        row = await blocked()
        if row is None:
            return False
        host, _, _ = approved_vm_update(row, spec, allow_unresolved=True)

        def guard() -> None:
            if asyncio.run_coroutine_threadsafe(blocked(), loop).result(30) is None:
                raise RuntimeError("VM_UPDATE_NO_DISPATCH_UNCONFIRMED")

        def release(*, guard: Callable[[], None], advance: Callable[[str], None]) -> bool:
            guard()
            verify_vm_drain(
                handoff.recovery_snapshot(),
                _binding(row, host),
                receipt,
                str(spec.upgrade_operation_id),
            )
            result = handoff.release(
                operation_id=str(spec.upgrade_operation_id),
                incarnation=host.installation.generation,
                expected_idle_record=receipt["idleRecord"],
                guard=guard,
            )
            return result.get("state") == "accepting"

        return await run_setup_thread(release, advance=lambda _: None, guard=guard)
    except Exception as exc:
        logging.getLogger(__name__).warning(
            "vm_update.unattempted_release_unconfirmed errorType=%s", type(exc).__name__
        )
        return False


async def apply_vm_image_update(
    *,
    row: dict,
    spec: PodSpec,
    plan: VmImageUpdatePlan,
    receipt: dict,
    handoff: PodUpgradeHandoffClient,
    token: str,
) -> BackendHandle:
    from hushh_mcp.services.azure_hosted_authority import upgrade_authority
    from hushh_mcp.services.azure_setup_worker import run_setup_thread

    async with upgrade_authority(spec, vm_plan=plan) as authority:
        worker = VmImageUpgrade(
            row=row,
            spec=spec,
            plan=plan,
            receipt=receipt,
            handoff=handoff,
            authority=authority,
        )

        def run(*, guard: Callable[[], None], advance: Callable[[str], None]) -> BackendHandle:
            source = ArmClient(token, throttle_retries=0, transient_retries=0)
            try:
                return worker.run(source, guard=guard, advance=advance)
            finally:
                source.close()

        return await run_setup_thread(run, advance=lambda _: None, guard=authority.assert_admitted)
