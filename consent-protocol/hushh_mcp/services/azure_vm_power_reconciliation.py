"""Settle an original VM power dispatch with GETs; never replay an uncertain POST."""

from __future__ import annotations

import hashlib
import hmac
from urllib.parse import unquote, urlsplit

from hushh_mcp.services.azure_arm_client import ArmClient, ArmResponse, require_arm_url
from hushh_mcp.services.azure_vm_power import AzureVmPower, AzureVmPowerRefused
from hushh_mcp.services.azure_vm_power_authority import AzureVmPowerAuthority


def reconcile_power_dispatch(
    arm: ArmClient, authority: AzureVmPowerAuthority, *, action: str
) -> bool:
    """True means a previous dispatch succeeded; its desired state still needs a GET."""
    events = authority.read_from_thread()["events"]
    path = authority.target.installation.resource_id + "/" + action
    requests = [e for e in events if e["kind"] == "request" and e["path"] == path]
    if not requests:
        return False
    request = requests[-1]
    if request["purpose"] != "vm_" + action or request["apiVersion"] != "2024-03-01":
        raise AzureVmPowerRefused("VM_POWER_OPERATION_CHANGED")
    request_id = request["requestId"]
    matching = [e for e in events if e.get("requestId") == request_id]
    terminal = next((e for e in matching if e["kind"] == "terminal"), None)
    if terminal:
        if terminal["outcome"] == "not_dispatched":
            return False
        if terminal["outcome"] == "succeeded":
            return True
        raise AzureVmPowerRefused("VM_POWER_PROVIDER_REFUSED")
    ack: dict = next((e for e in matching if e["kind"] == "ack"), {})
    url, kind, digest = (
        ack.get(k) for k in ("operationUrl", "operationKind", "operationUrlSha256")
    )
    if ack.get("status") == 200 and url is None and kind is None and digest is None:
        # The pinned VM actions support synchronous 200. Verify the exact target
        # and desired state before settling this original acknowledged request.
        with AzureVmPower(
            target=authority.target,
            arm=arm,
            journal=authority,
            require_operation=authority.require_operation,
        ) as power:
            if power.observe() != ("running" if action == "start" else "deallocated"):
                raise AzureVmPowerRefused("VM_POWER_STATE_UNCONFIRMED")
        if authority.terminal(request_id, "succeeded") is not True:
            raise AzureVmPowerRefused("VM_POWER_RECEIPT_UNCONFIRMED")
        return True
    if (
        ack.get("status") not in {200, 202}
        or kind not in {"azure-asyncoperation", "location"}
        or not isinstance(url, str)
        or not isinstance(digest, str)
        or not hmac.compare_digest(hashlib.sha256(url.encode()).hexdigest(), digest)
    ):
        # No operation reference means no safe read-only reconciliation. Leave
        # the original receipt unresolved, even if instanceView says running.
        raise AzureVmPowerRefused("VM_POWER_OUTCOME_UNCONFIRMED")
    require_arm_url(url)
    subscription = authority.target.installation.resource_id.split("/")[2]
    parsed = urlsplit(url)
    if not parsed.path.startswith(f"/subscriptions/{subscription}/") or any(
        p in {".", ".."} for p in unquote(parsed.path).split("/")
    ):
        raise AzureVmPowerRefused("VM_POWER_OPERATION_CHANGED")
    original = ArmResponse(ack["status"], headers={kind: url}, mutation_id=request_id)
    authority.require_operation()
    client = arm.with_mutations(authority)
    try:
        client.wait(original, "vm_power_reconcile")
    finally:
        client.close()
    authority.require_operation()
    return True
