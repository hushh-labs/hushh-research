"""Operator-only bridge IAM cleanup through the retained owner erasure journal.

The hub never receives the operator credential. The caller verifies its ADC
principal before supplying this session; SQL validates every retained receipt.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any

from hushh_mcp.services.hosted_gcp_admission import _worker_guard
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_project_gcp_operator import GuardedOperatorSession
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


async def erase_managed_model_grants(
    registry: Any, *, user_id: str, actor: str, token: str, session: Any
) -> None:
    """Never remove pre-existing grants or use the hub's model identity."""
    journal = HostedPodJournal(registry._db())
    initial = await _reservation(registry, user_id)
    attempt = initial["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
    contract = attempt["hostedAdmission"]["assignment"]["preparationContract"]
    if actor != contract["operatorPrincipal"] or not token:
        raise ProvisionReconciliationRequired(
            "Managed erasure operator differs from retained authority"
        )
    completed = attempt["evidence"]["reserved"]["hostedPreparation"]["completed"]
    for kind in ("vertex", "quota"):
        matches = [result for result in completed if result["step"] == "inference_" + kind]
        if not matches:
            continue
        if len(matches) != 1:
            raise ProvisionReconciliationRequired("Managed inference provenance is ambiguous")
        result = matches[0]
        base = {
            "ownerId": user_id,
            "attemptId": initial["attemptId"],
            "provisionAttemptId": attempt["attemptId"],
            "runtimeIdentity": result["resourceObservation"]["identity"],
            "bindingObservation": result["bindingObservations"][0],
        }
        await _erase_one(registry, journal, initial, base, kind, token, session)


async def _reservation(registry: Any, user_id: str) -> dict:
    row = await registry.get(user_id)
    reservation = ((row or {}).get("backend_metadata") or {}).get("erasure") or {}
    if (
        row is None
        or row.get("status") != "suspended"
        or reservation.get("ownerId") != user_id
        or not reservation.get("attemptId")
    ):
        raise ProvisionReconciliationRequired("Managed erasure reservation unavailable")
    return deepcopy(reservation)


async def _erase_one(
    registry: Any,
    journal: HostedPodJournal,
    initial: dict,
    base: dict,
    kind: str,
    token: str,
    session: Any,
) -> None:
    owner = base["ownerId"]
    admitted = {**base, "status": "admitted"}

    async def current() -> dict:
        saved = await _reservation(registry, owner)
        if (
            saved["attemptId"] != initial["attemptId"]
            or saved["registrySnapshot"] != initial["registrySnapshot"]
            or not await journal.managed_cleanup_check(
                owner_id=owner, reservation=saved, kind=kind, stage="admission", receipt=admitted
            )
        ):
            raise ProvisionReconciliationRequired("Managed inference cleanup authority changed")
        return saved

    async def retain(stage: str, receipt: dict) -> None:
        saved = await current()
        if not await journal.retain_managed_cleanup(
            owner_id=owner, reservation=saved, kind=kind, stage=stage, receipt=receipt
        ):
            raise ProvisionReconciliationRequired("Managed inference cleanup receipt refused")
        saved = await current()
        if saved.get("managedModelGrantErasure", {}).get(kind, {}).get(stage) != receipt:
            raise ProvisionReconciliationRequired("Managed inference cleanup readback differs")

    await current()
    await retain("admission", admitted)
    saved = await current()
    state = saved.get("managedModelGrantErasure", {}).get(kind, {})
    if "deletion" in state:
        return
    import threading

    guard = _worker_guard(current, asyncio.get_running_loop(), threading.get_ident())
    client = GuardedOperatorSession(session, guard)
    removed = await asyncio.to_thread(_remove_binding, client, token, base)
    if removed:
        await retain("acknowledgement", {**base, "status": "acknowledged"})
    status = (
        "observed_absent"
        if base["bindingObservation"]["disposition"] == "added"
        else "preserved_preexisting"
    )
    await retain("deletion", {**base, "status": status})


def _remove_binding(client: Any, token: str, base: dict) -> bool:
    from hushh_mcp.services.byoc_oauth_authorizer import _check

    binding = base["bindingObservation"]
    headers = {"Authorization": "Bearer " + token}
    url = binding["policyResource"]
    if not url.startswith(
        "https://cloudresourcemanager.googleapis.com/v1/projects/"
    ) or not url.endswith(":getIamPolicy"):
        raise ProvisionReconciliationRequired("Managed inference policy resource is invalid")
    policy = _check(
        client.post(
            url, headers=headers, json={"options": {"requestedPolicyVersion": 3}}, timeout=20
        ),
        "read managed inference grants",
    )
    if binding["disposition"] == "already_present":
        return False
    if binding["disposition"] != "added" or not policy.get("etag"):
        raise ProvisionReconciliationRequired("Managed inference grant provenance is invalid")
    member = binding["member"]
    identity = base["runtimeIdentity"]
    if member != "serviceAccount:" + identity["email"]:
        raise ProvisionReconciliationRequired("Managed inference identity changed")
    targets = {member, f"deleted:serviceAccount:{identity['email']}?uid={identity['uniqueId']}"}
    changed = False
    updated = deepcopy(policy)
    for item in updated.get("bindings", []):
        if item.get("role") == binding["role"] and not item.get("condition"):
            previous = item.get("members", [])
            item["members"] = [value for value in previous if value not in targets]
            changed |= previous != item["members"]
    if changed:
        updated["bindings"] = [item for item in updated["bindings"] if item.get("members")]
        _check(
            client.post(
                url.removesuffix(":getIamPolicy") + ":setIamPolicy",
                headers=headers,
                json={"policy": updated},
                timeout=20,
            ),
            "remove managed inference grant",
        )
    observed = _check(
        client.post(
            url, headers=headers, json={"options": {"requestedPolicyVersion": 3}}, timeout=20
        ),
        "verify managed inference grant absence",
    )
    if any(
        targets.intersection(item.get("members", []))
        for item in observed.get("bindings", [])
        if item.get("role") == binding["role"]
    ):
        raise ProvisionReconciliationRequired(
            "Managed inference grant remains or changed condition"
        )
    return changed
