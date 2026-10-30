"""Authenticated VM key-erasure checkpoint; no cloud deletion or standing revoke.

The existing account-erasure reservation owns approval and durable confirmation.
This port only fences the exact running VM and calls that reservation's callback.
The owner-authorized teardown worker remains responsible for every ARM effect.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from hushh_mcp.services.azure_agent_setup import binding_is_valid
from hushh_mcp.services.azure_setup_plan import NONCE_TAG
from hushh_mcp.services.azure_vm_observation import verified_vm

if TYPE_CHECKING:
    from hushh_mcp.services.compute_backend import PodSpec
    from hushh_mcp.services.user_azure_vm_backend import UserAzureVmBackend


def _target(backend: UserAzureVmBackend, spec: PodSpec) -> dict[str, str]:
    backend._host.require_spec(spec)
    nonce = spec.expected_setup_nonce
    if not isinstance(nonce, str) or re.fullmatch(r"[a-f0-9]{16}", nonce) is None:
        raise RuntimeError("VM_ERASURE_SETUP_BINDING_REQUIRED")
    source = backend._observer()
    arm = source.with_request_budget(lambda: 15.0)
    try:
        body = verified_vm(backend._host, arm, op="vm_erasure")
        tags = body.get("tags")
        if (
            not isinstance(tags, dict)
            or not binding_is_valid(tags, spec.hushh_id)
            or tags.get(NONCE_TAG) != nonce
        ):
            raise RuntimeError("VM_ERASURE_SETUP_BINDING_CHANGED")
        installation = backend._host.installation
        return {
            "service": installation.resource_id,
            "serviceUid": installation.generation,
            "revision": installation.generation,
            "podUrl": backend._host.url,
        }
    finally:
        arm.close()
        source.close()


async def observe(backend: UserAzureVmBackend, spec: PodSpec) -> dict[str, str]:
    from hushh_mcp.services.azure_setup_worker import run_setup_thread

    target: dict[str, str] = await run_setup_thread(
        lambda *, guard, advance: _target(backend, spec), advance=lambda _: None
    )
    return target


async def checkpoint(
    backend: UserAzureVmBackend,
    spec: PodSpec,
    *,
    crypto_erase: Callable[[dict[str, str]], Awaitable[dict]],
) -> None:
    # The common owner-access path has already observed the target, then checked
    # its reserved row. Fence again immediately before the callback dispatch.
    await observe(backend, spec)
    receipt = await crypto_erase({"setupNonce": str(spec.expected_setup_nonce)})
    if (
        not isinstance(receipt, dict)
        or receipt.get("erased") is not True
        or receipt.get("hushhId") != spec.hushh_id
        or receipt.get("serviceUid") != spec.expected_service_uid
    ):
        raise RuntimeError("VM_ERASURE_CHECKPOINT_UNCONFIRMED")
