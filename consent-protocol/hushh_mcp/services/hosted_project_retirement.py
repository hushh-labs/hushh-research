"""Retire an admitted pilot project only after independent resource erasure.

Deleting a project is not evidence that its keys, memory or credentials were
removed. SQL must admit this stage before the operator touches billing or CRM.
"""

from __future__ import annotations

import asyncio
import threading
from copy import deepcopy
from typing import Any

from hushh_mcp.services.hosted_gcp_admission import _worker_guard
from hushh_mcp.services.hosted_model_grant_cleanup import _reservation
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.hosted_project_gcp_operator import GuardedOperatorSession
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


async def retire_managed_project(
    registry: Any, *, user_id: str, actor: str, token: str, session: Any
) -> None:
    journal = HostedPodJournal(registry._db())
    initial = await _reservation(registry, user_id)
    attempt = initial["registrySnapshot"]["backend_metadata"]["provisionAttempt"]
    assignment = attempt["hostedAdmission"]["assignment"]
    contract = assignment["preparationContract"]
    creation = attempt["evidence"]["reserved"]["hostedPreparation"]["completed"][0][
        "resourceObservation"
    ]["identity"]
    if actor != contract["operatorPrincipal"] or not token:
        raise ProvisionReconciliationRequired("Project retirement operator changed")
    base = {
        "ownerId": user_id,
        "attemptId": initial["attemptId"],
        "project": creation["projectId"],
        "projectNumber": creation["projectNumber"],
        "operatorPrincipal": actor,
    }
    admitted = {**base, "status": "admitted"}

    async def current() -> dict:
        saved = await _reservation(registry, user_id)
        if (
            saved["attemptId"] != initial["attemptId"]
            or saved["registrySnapshot"] != initial["registrySnapshot"]
            or not await journal.managed_cleanup_check(
                owner_id=user_id,
                reservation=saved,
                kind="retirement",
                stage="admission",
                receipt=admitted,
            )
        ):
            raise ProvisionReconciliationRequired("Project retirement prerequisites are incomplete")
        return saved

    async def retain(stage: str, receipt: dict) -> None:
        saved = await current()
        if not await journal.retain_managed_cleanup(
            owner_id=user_id, reservation=saved, kind="retirement", stage=stage, receipt=receipt
        ):
            raise ProvisionReconciliationRequired("Project retirement receipt refused")
        saved = await current()
        if saved.get("managedProjectRetirement", {}).get(stage) != receipt:
            raise ProvisionReconciliationRequired("Project retirement receipt readback differs")

    await retain("admission", admitted)
    saved = await current()
    if "deletion" in saved.get("managedProjectRetirement", {}):
        return
    client = GuardedOperatorSession(
        session, _worker_guard(current, asyncio.get_running_loop(), threading.get_ident())
    )
    identity, billing, deleted = await asyncio.to_thread(
        _retire, client, token, creation, contract["billingAccount"]
    )
    if deleted:
        await retain("acknowledgement", {**base, "status": "acknowledged"})
    await retain(
        "deletion",
        {
            **base,
            "status": "retirement_pending_provider_purge",
            "projectIdentity": identity,
            "billingObservation": billing,
        },
    )


def _retire(
    client: Any, token: str, creation: dict, billing_account: str
) -> tuple[dict, dict, bool]:
    from hushh_mcp.services.byoc_oauth_authorizer import _check

    project = creation["projectId"]
    headers = {"Authorization": "Bearer " + token}
    resource = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project}"
    billing_url = f"https://cloudbilling.googleapis.com/v1/projects/{project}/billingInfo"

    def observe() -> dict:
        value = _check(
            client.get(resource, headers=headers, timeout=20), "observe pilot retirement identity"
        )
        identity = {key: value.get(key) for key in creation}
        if identity.get("lifecycleState") not in {"ACTIVE", "DELETE_REQUESTED"} or {
            key: value for key, value in identity.items() if key != "lifecycleState"
        } != {key: value for key, value in creation.items() if key != "lifecycleState"}:
            raise ProvisionReconciliationRequired(
                "Pilot project incarnation changed before retirement"
            )
        return identity

    identity = observe()
    billing = _check(
        client.get(billing_url, headers=headers, timeout=20), "observe pilot project billing"
    )
    if billing.get("billingAccountName", "") not in {"", billing_account}:
        raise ProvisionReconciliationRequired("Pilot project funding authority changed")
    if billing.get("billingAccountName"):
        _check(
            client.put(billing_url, headers=headers, json={"billingAccountName": ""}, timeout=20),
            "disable pilot project billing",
        )
    billing = _check(
        client.get(billing_url, headers=headers, timeout=20),
        "verify pilot project billing disabled",
    )
    observation = {
        "projectId": project,
        "billingAccountName": billing.get("billingAccountName", ""),
        "billingEnabled": billing.get("billingEnabled"),
    }
    if observation != {"projectId": project, "billingAccountName": "", "billingEnabled": False}:
        raise ProvisionReconciliationRequired("Pilot project billing disablement is unconfirmed")
    deleted = False
    if identity["lifecycleState"] == "ACTIVE":
        _check(
            client.request("DELETE", resource, headers=headers, timeout=20),
            "request pilot project retirement",
        )
        deleted = True
    identity = observe()
    if identity["lifecycleState"] != "DELETE_REQUESTED":
        raise ProvisionReconciliationRequired("Pilot project retirement is not yet observed")
    return deepcopy(identity), observation, deleted
