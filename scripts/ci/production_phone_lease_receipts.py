"""Typed immutable cold-lease receipt decoding; no mutation or health authority."""

from __future__ import annotations

import json
import re

import production_phone_receipt as phone
import release_artifact_receipts as receipts

retention = receipts.retention


def _require(condition, reason):
    if not condition:
        raise retention.UnsafeState(
            f"Cold health lease reconciliation required: {reason}"
        )


def artifact(repository, attempt, result, api, timestamp, *, job, upload, name):
    lane = {"deploy_job": job, "upload_step": upload}
    started, ended = receipts._upload_window(
        result, attempt, attempt["run_attempt"], lane, timestamp
    )
    inventory = api(repository, f"runs/{attempt['id']}/artifacts?per_page=100")
    rows = inventory.get("artifacts")
    _require(
        isinstance(rows, list)
        and len(rows) <= 100
        and inventory.get("total_count") == len(rows)
        and all(isinstance(row, dict) for row in rows),
        "lease artifact inventory is incomplete",
    )
    matches = [row for row in rows if row.get("name") == name]
    _require(
        len(matches) == 1 and matches[0].get("expired") is False,
        "lease artifact is missing, expired or ambiguous",
    )
    created = receipts._artifact_created(matches[0], attempt, timestamp)
    _require(
        started.timestamp() - 5 <= created.timestamp() <= ended.timestamp() + 30,
        "lease publication is not attempt-bound",
    )
    return matches[0]


def validate(lease, attempt, *, pending=False):
    origin = {"run_id": str(attempt["id"]), "run_attempt": attempt["run_attempt"]}
    _require(
        type(lease.get("schema_version")) is int
        and lease["schema_version"] == 1
        and lease.get("kind") == "phone-cold-health-lease"
        and lease.get("project") == "hushh-pda"
        and lease.get("region") == "us-central1"
        and lease.get("service") == "consent-protocol"
        and lease.get("origin") == origin
        and type(lease["origin"].get("run_attempt")) is int
        and lease.get("workflow_sha") == attempt["head_sha"]
        and lease.get("tag") == f"phone-rollback-{attempt['id']}"
        and re.fullmatch(r"[0-9a-f]{40}", str(lease.get("source", "")))
        and re.fullmatch(
            r"gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}",
            str(lease.get("image", "")),
        )
        and lease.get("status") == ("pending" if pending else "retired")
        and "pending_mutation" in lease
        and lease["pending_mutation"] == ("stage_cold" if pending else None)
        and isinstance(lease.get("service_uid"), str)
        and 0 < len(lease["service_uid"]) <= 256
        and all(
            re.fullmatch(r"[0-9a-f]{64}", str(lease.get(key, "")))
            for key in ("controls", "iam")
        )
        and traffic(lease)
        and (
            (pending and "revision" not in lease)
            or (
                not pending
                and "revision" in lease
                and (
                    lease["revision"] is None
                    or re.fullmatch(
                        r"consent-protocol-[a-z0-9-]+", str(lease["revision"])
                    )
                )
            )
        ),
        "lease retirement is invalid or unresolved",
    )


def traffic(lease):
    serving, traffic = lease.get("serving"), lease.get("traffic")
    if not (
        isinstance(serving, list)
        and len(serving) == 1
        and isinstance(serving[0], list)
        and len(serving[0]) == 2
        and re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(serving[0][0]))
        and type(serving[0][1]) is int
        and serving[0][1] == 100
        and isinstance(traffic, list)
        and len(traffic) == 2
        and isinstance(traffic[0], list)
        and len(traffic[0]) <= 100
        and isinstance(traffic[1], str)
        and len(traffic[1]) <= 65536
    ):
        return False
    try:
        desired = json.loads(traffic[1], object_pairs_hook=phone._unique_object)
    except (TypeError, ValueError):
        return False
    return (
        isinstance(desired, list)
        and len(desired) <= 100
        and all(
            isinstance(row, dict) and row.get("tag") != lease["tag"] for row in desired
        )
        and all(
            isinstance(row, list)
            and len(row) == 3
            and re.fullmatch(r"consent-protocol-[a-z0-9-]+", str(row[0]))
            and type(row[1]) is int
            and 0 <= row[1] <= 100
            and isinstance(row[2], str)
            and len(row[2]) <= 63
            and row[2] != lease["tag"]
            for row in traffic[0]
        )
        and sorted([row[0], row[1]] for row in traffic[0] if row[1]) == serving
    )


def intent(
    repository,
    attempt,
    jobs,
    steps,
    *,
    job,
    begin,
    upload,
    deploy,
    api,
    timestamp,
    run_command,
    timeout,
):
    _require(
        all(
            steps.get(name, {}).get("status") == "completed"
            and steps[name].get("conclusion") == "success"
            for name in (begin, upload)
        ),
        "durable initial intent was not published",
    )
    selected = artifact(
        repository,
        attempt,
        jobs,
        api,
        timestamp,
        job=job,
        upload=upload,
        name=f"prod-phone-health-intent-{attempt['id']}-{attempt['run_attempt']}",
    )
    archive = receipts.immutable_archive(
        repository, selected, run_command=run_command, timeout=timeout
    )
    lease = phone._document(archive, "initial-lease.json")
    validate(lease, attempt, pending=True)
    producer = lease.get("producer")
    _require(
        isinstance(producer, dict)
        and producer.get("cloud_build_tag")
        == f"phone-cold-{attempt['id']}-{attempt['run_attempt']}"
        and producer.get("fallback_source") == lease["source"]
        and re.fullmatch(r"[0-9a-f]{40}", str(producer.get("primary_source", ""))),
        "initial producer identity is invalid",
    )
    uploaded, submitted = (
        timestamp(steps[upload].get("completed_at")),
        timestamp(steps.get(deploy, {}).get("started_at")),
    )
    _require(
        uploaded is not None and submitted is not None and uploaded <= submitted,
        "initial intent did not precede submission",
    )
    return {
        "lease": lease,
        "identity": {
            **lease["origin"],
            "workflow_sha": lease["workflow_sha"],
            "artifact_id": selected["id"],
            "artifact_digest": selected["digest"],
            "published_at": selected["created_at"],
        },
        "attempt": attempt,
        "submission": steps[deploy],
    }


def bind_final(final, original):
    validate(final, original["attempt"])
    baseline = original["lease"]
    _require(
        all(
            final.get(key) == value
            for key, value in baseline.items()
            if key not in {"status", "pending_mutation"}
        ),
        "final lease differs from its immutable intent",
    )
