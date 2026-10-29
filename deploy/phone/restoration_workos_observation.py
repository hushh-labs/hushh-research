# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Preserve one authenticated direct observation of a retired restoration issuer.

This fixed original receipt predates observation reuse. It grants neither live
reader authority nor closure for another revision or a later audit event.
"""

from __future__ import annotations

import hashlib
import importlib
from datetime import datetime, timedelta, timezone
from io import BytesIO
from zipfile import ZipFile

from bootstrap_ports import REPOSITORY, _authorities

RUN = 40475676949
ATTEMPT = 2
WORKFLOW_SHA = "0c32dc1cba0e5a0a4d7a3f9c257baf32e2e4b14b"
ARTIFACT = 12720747603
DIGEST = "sha256:93b08781a8f4b318fffa1428688a2dcdcc7a299653fe0f2e0ca52f41e9e005ff"
MEMBER = "prod-restoration-workos.json"
MEMBER_DIGEST = "60a37583fb60500c575cb36f06f8ef6f8387f01b40013570dc8aea4dc3db14e7"
REVISION = "consent-protocol-00305-zuy"
CREATED = "2026-10-27T01:32:22.588801Z"


def require(value: bool) -> None:
    if not value:
        raise ValueError("workos_historical_observation_unqualified")


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None)
    return parsed.astimezone(timezone.utc)


def validate_scope(observation, inventory, source, start, until, source_anchor) -> None:
    """Keep the prior identity and audited horizon outside live inventory."""
    row = observation["row"]
    require(
        source is not None
        and row
        == {
            "revision": REVISION,
            "source": source,
            "created_at": CREATED,
            "capable": True,
            "direct_sso_false": True,
        }
        and row["capable"] is True
        and row["direct_sso_false"] is True
        and observation["history_start"] == start
        and observation["source_anchor"] == source_anchor
        and instant(start)
        <= instant(CREATED)
        <= instant(observation["history_until"])
        <= instant(until)
        and REVISION not in inventory
    )


def covers(observation, name, source, stamp, metadata) -> bool:
    if name != observation["row"]["revision"]:
        return False
    require(
        source == observation["row"]["source"]
        and stamp <= instant(observation["history_until"])
        and metadata.get("creationTimestamp") in (None, observation["row"]["created_at"])
        # The original restoration format lacks UIDs; the sealed cold snapshot
        # supplies one. Never guess an additional incarnation identity.
        and metadata.get("uid") in (None, observation.get("revision_uid"))
    )
    return True


def review(events, inventory, *, project, until, source, reviewer):
    """Use preserved evidence only after the ordinary direct-history check refuses."""
    arguments = {"project": project, "until": until, "restoration_sha": source}
    try:
        return reviewer(events, inventory, **arguments), None
    except ValueError as error:
        if (
            str(error) != "workos_historical_issuer_not_proven_closed"
            or project != "hushh-pda"
            or source is None
        ):
            raise
    observation = load(source)
    try:
        count = reviewer(events, inventory, **arguments, historical_observation=observation)
    except ValueError as error:
        if str(error) != "workos_historical_issuer_not_proven_closed":
            raise
        from operational_workos_observation import load as load_operational

        operational = load_operational(source)
        count = reviewer(
            events,
            inventory,
            **arguments,
            historical_observation=observation,
            operational_observation=operational,
        )
        observation = {**observation, "operational": operational}
    return count, observation


def receipt_provenance(observation):
    if observation is None:
        return {}
    result = {"historical_observation": {**observation["provenance"], "reused_revision_count": 1}}
    if observation.get("operational") is not None:
        result["operational_observation"] = {
            **observation["operational"]["provenance"],
            "reused_revision_count": 1,
        }
    return result


def qualify_capture(receipt, steps, created_at, artifact_created):
    require(
        len(steps) == 1
        and steps[0].get("status") == "completed"
        and steps[0].get("conclusion") == "success"
    )
    step = steps[0]
    require(
        instant(created_at) <= instant(receipt["history_until"]) <= instant(receipt["captured_at"])
        and instant(step["started_at"])
        <= instant(receipt["history_until"])
        <= instant(receipt["captured_at"])
        # GitHub step timestamps have only whole-second precision.
        < instant(step["completed_at"]) + timedelta(seconds=1)
        and instant(receipt["captured_at"]) <= instant(artifact_created)
    )


def original_row(receipt, source):
    row = {
        "revision": REVISION,
        "source": source,
        "created_at": CREATED,
        "capable": True,
        "direct_sso_false": True,
    }
    require(
        set(receipt)
        == {
            "schema_version",
            "qualification",
            "project",
            "region",
            "service",
            "captured_at",
            "scope",
            "history_start",
            "history_until",
            "source_anchor",
            "restoration_source",
            "audit_event_count",
            "audit_truncated",
            "revisions",
            "database",
            "sso_activation_qualified",
        }
        and type(receipt.get("schema_version")) is int
        and receipt["schema_version"] == 1
        and receipt.get("qualification") == "passed"
        and receipt.get("project") == "hushh-pda"
        and receipt.get("region") == "us-central1"
        and receipt.get("service") == "consent-protocol"
        and receipt.get("scope") == "workos427_closed_initial_rollout"
        and receipt.get("restoration_source") == source
        and receipt.get("audit_truncated") is False
        and receipt.get("sso_activation_qualified") is False
        and [r for r in receipt.get("revisions", []) if r.get("revision") == REVISION] == [row]
    )
    return row


def load(source: str) -> dict:
    """Authenticate the original healthy operation using existing receipt owners."""
    _authorities()
    continuation = importlib.import_module("production_restoration_continuation")
    owner = continuation.owner
    arguments = continuation.ports()
    run = continuation.fresh_run(arguments, RUN)
    require(
        run.get("id") == RUN
        and run.get("run_attempt") == ATTEMPT
        and run.get("head_sha") == WORKFLOW_SHA
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
    )
    continuation.manual(run)
    artifact, job, content, lane = continuation.archive(run, arguments)
    require(artifact.get("id") == ARTIFACT and artifact.get("digest") == DIGEST)
    release = owner.phone._document(content, "prod-release-status.json")
    require(release.get("sha") == source)
    # This verifies the unchanged original operation, source record, healthy pair,
    # exact attempt, governed actors, successful hosted gates and archive origin.
    owner.serving_reference(REPOSITORY, run, release, lane, **arguments)
    steps = [
        s
        for s in job.get("steps", [])
        if s.get("name") == "Verify restoration WorkOS remains closed"
    ]
    with ZipFile(BytesIO(content)) as archive:
        require(archive.namelist().count(MEMBER) == 1)
        require(hashlib.sha256(archive.read(MEMBER)).hexdigest() == MEMBER_DIGEST)
    receipt = owner.phone._document(content, MEMBER)
    row = original_row(receipt, source)
    qualify_capture(receipt, steps, CREATED, artifact["created_at"])
    require(continuation.fresh_run(arguments, RUN) == run)
    return {
        "row": row,
        "history_start": receipt["history_start"],
        "history_until": receipt["history_until"],
        "source_anchor": receipt["source_anchor"],
        "provenance": {
            "run_id": RUN,
            "run_attempt": ATTEMPT,
            "workflow_sha": WORKFLOW_SHA,
            "artifact_id": ARTIFACT,
            "artifact_digest": DIGEST,
            "member": MEMBER,
            "member_sha256": MEMBER_DIGEST,
            "captured_at": receipt["captured_at"],
        },
    }
