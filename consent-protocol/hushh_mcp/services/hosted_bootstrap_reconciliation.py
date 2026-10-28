"""Operator readback for a failed deterministic bucket create, in its original journal.

A failed 503 response does not establish whether creation occurred. Only a fresh
404 on the frozen name permits the same-name retry. Existing, inaccessible or
uncertain resources stay blocked; this adapter never creates or deletes them.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from hushh_mcp.services.hosted_operator_identity import VerifiedOperator
from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


def _bucket(reservation: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    try:
        assignment = reservation["hostedAdmission"]["assignment"]
        checkpoint = reservation["evidence"]["reserved"]["hostedCheckpoint"]
        contract = assignment["bootstrapContract"]
        results = checkpoint["completed"]
        if (
            reservation["phase"] != "reserved"
            or checkpoint["phase"] != "observed"
            or checkpoint["step"] != "cmek_bucket"
            or len(results) < 2
            or results[-1] != {"step": "cmek_bucket", "status": 503, "ok": False}
            or any(result.get("ok") is not True for result in results[:-1])
            or contract["steps"][: len(results)] != [result["step"] for result in results]
        ):
            raise ValueError
        buckets = [r["id"] for r in contract["plan"]["resources"] if r["type"] == "gcs_bucket"]
        if len(buckets) != 1 or not isinstance(buckets[0], str) or not buckets[0]:
            raise ValueError
        return buckets[0], deepcopy(checkpoint)
    except (KeyError, TypeError, IndexError, ValueError):
        raise ProvisionReconciliationRequired("Not an eligible failed bucket create") from None


async def reconcile_failed_bucket_absence(
    journal: HostedPodJournal,
    reservation: dict[str, Any],
    *,
    operator: VerifiedOperator,
    session: Any,
) -> bool:
    """Observe outside SQL, then compare the exact failed checkpoint under its lock."""
    reservation = deepcopy(reservation)
    bucket, checkpoint = _bucket(reservation)
    admission = reservation["hostedAdmission"]
    assignment = admission["assignment"]
    project = reservation["evidence"]["reserved"]["projectObservation"]
    if operator.principal != assignment["preparationContract"]["operatorPrincipal"]:
        raise ProvisionReconciliationRequired("Bucket inspection operator differs")

    async def current() -> None:
        if not await journal.current(
            purpose="bootstrap",
            owner_id=reservation["ownerId"],
            attempt_id=reservation["attemptId"],
            admission=admission,
            project_observation=project,
        ):
            raise ProvisionReconciliationRequired("Bucket inspection authority changed")

    await current()

    def observe() -> dict[str, Any]:
        headers = {"Authorization": "Bearer " + operator.token}
        response = session.get(
            "https://cloudresourcemanager.googleapis.com/v1/projects/" + assignment["project"],
            headers=headers,
            timeout=20,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise ProvisionReconciliationRequired("Bucket project identity unavailable")
        identity = response.json()
        if {
            key: identity.get(key) for key in ("projectId", "projectNumber", "lifecycleState")
        } != project:
            raise ProvisionReconciliationRequired("Bucket project identity differs")
        response = session.get(
            "https://storage.googleapis.com/storage/v1/b/" + quote(bucket, safe=""),
            headers=headers,
            timeout=20,
            allow_redirects=False,
        )
        if response.status_code != 404:
            raise ProvisionReconciliationRequired("Bucket is present, inaccessible or uncertain")
        return {
            "version": 1,
            "actor": operator.principal,
            "sourceRevision": admission["sourceRevision"],
            "imageDigest": admission["imageDigest"],
            "projectIdentity": project,
            "bucketName": bucket,
            "method": "GET",
            "httpStatus": 404,
            "status": "observed_absent",
            "observedAt": datetime.now(timezone.utc).isoformat(),
        }

    observation = await asyncio.to_thread(observe)
    await current()
    return await journal.reconcile_bucket_absence(
        owner_id=reservation["ownerId"],
        attempt_id=reservation["attemptId"],
        checkpoint=checkpoint,
        observation=observation,
    )
