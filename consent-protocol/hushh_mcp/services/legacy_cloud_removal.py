"""Forward recovery of an existing, fenced legacy GCP removal.

The original placement, approval and modern erasure receipts are never rewritten.
Native observations are adoption evidence, not historical creation or worker exit.
The operator retains provider intent before dispatch and uses this same journal
after an interruption. A missing acknowledgement never authorizes a second call.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused

VERSION = 1
CONTROL_PROJECT = "hushh-pda-dev"
PROTECTED_PROJECTS = frozenset(
    {"hushh-pda-dev", "hushh-pda-uat", "hushh-pda", "hushh-gemini-bridge"}
)
RESOURCE_TYPES = frozenset(
    {
        "cloud_run_service",
        "service_account",
        "gcs_bucket",
        "kms_key",
        "secret",
        "artifact_repository",
        "pubsub_topic",
        "pubsub_subscription",
        "cloud_scheduler_job",
        "cloud_tasks_queue",
        "reasoning_engine",
        "project_iam_policy",
        "bootstrap_access",
    }
)
TERMINAL = frozenset({"observed_absent", "deleted", "retained_shared"})


def _require(condition: bool, code: str = "CLOUD_REMOVAL_RECOVERY_UNVERIFIED") -> None:
    if not condition:
        raise AzureTeardownRefused(code)


def sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def resource_key(resource: dict) -> str:
    return f"{resource['type']}:{resource['id']}"


def validate_plan(reservation: dict, plan: dict) -> None:
    """Validate a native, explicitly reviewed plan without inferring ownership by name."""
    snapshot = reservation.get("registrySnapshot") or {}
    metadata = snapshot.get("backend_metadata") or {}
    project = snapshot.get("user_cloud_project")
    _require(
        reservation.get("version") == VERSION
        and reservation.get("phase") == "reserved"
        and snapshot.get("status") == "provisioned"
        and snapshot.get("deployment_target") == "user_gcp"
        and snapshot.get("backend") == "user_gcp"
        and snapshot.get("user_id") == reservation.get("ownerId")
        and snapshot.get("hushh_id") == reservation.get("hushhId")
        and isinstance(project, str)
        and project not in PROTECTED_PROJECTS
        and re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project) is not None
        and not metadata.get("upgradeLease")
        and set(reservation)
        <= {"version", "ownerId", "hushhId", "attemptId", "phase", "registrySnapshot"}
    )
    _require(
        isinstance(plan, dict)
        and set(plan)
        == {
            "version",
            "controlProject",
            "ownerId",
            "accountGeneration",
            "attemptId",
            "placementEpoch",
            "snapshotSha256",
            "project",
            "runtime",
            "memory",
            "resources",
            "sourceRevision",
            "actor",
            "observedAt",
            "termsVersion",
        }
    )
    _require(
        plan["version"] == VERSION
        and plan["controlProject"] == CONTROL_PROJECT
        and plan["ownerId"] == reservation["ownerId"]
        and plan["attemptId"] == reservation["attemptId"]
        and type(plan["accountGeneration"]) is int
        and plan["accountGeneration"] == 0
        and plan["placementEpoch"] == snapshot.get("placement_epoch", 0)
        and re.fullmatch(r"[0-9a-f]{64}", str(plan["snapshotSha256"])) is not None
        and re.fullmatch(r"[0-9a-f]{40}", str(plan["sourceRevision"])) is not None
        and plan["termsVersion"] == "gcp-legacy-native-removal-v1"
    )
    identity = plan["project"]
    runtime = plan["runtime"]
    memory = plan["memory"]
    _require(
        isinstance(identity, dict) and set(identity) == {"projectId", "projectNumber", "createTime"}
    )
    _require(
        identity["projectId"] == project
        and re.fullmatch(r"[1-9][0-9]{5,20}", str(identity["projectNumber"])) is not None
    )
    _require(
        isinstance(runtime, dict)
        and set(runtime)
        == {"serviceName", "serviceUid", "revision", "image", "generation", "etag", "principal"}
    )
    principal = runtime["principal"]
    _require(
        runtime["serviceName"]
        == f"projects/{project}/locations/{snapshot['user_cloud_region']}/services/{snapshot['external_agent_id']}"
        and runtime["serviceUid"] == metadata.get("serviceUid")
        and runtime["image"].endswith("@" + metadata.get("image_digest", "unverified"))
        and type(runtime["generation"]) is int
        and runtime["generation"] > 0
        and isinstance(runtime["etag"], str)
        and bool(runtime["etag"])
        and runtime["revision"].startswith(snapshot["external_agent_id"] + "-")
        and isinstance(principal, dict)
        and principal.get("projectId") == project
        and principal.get("email") == metadata.get("runtime_service_account")
        and re.fullmatch(r"[0-9]{6,30}", str(principal.get("uniqueId"))) is not None
        and principal.get("email") != snapshot.get("user_cloud_bootstrap_sa")
    )
    _validate_memory(project, memory)
    resources = plan["resources"]
    _require(isinstance(resources, list) and 1 <= len(resources) <= 128)
    keys: set[str] = set()
    for resource in resources:
        _require(
            isinstance(resource, dict) and set(resource) == {"type", "id", "identity", "authority"}
        )
        _require(resource["type"] in RESOURCE_TYPES and isinstance(resource["id"], str))
        key = resource_key(resource)
        _require(key not in keys)
        keys.add(key)
        _require(resource["authority"] in {"owner_reviewed", "observe_only", "retain_shared"})
        if resource["id"].startswith("projects/") and resource["id"].split("/")[1] != project:
            _require(resource["authority"] == "observe_only")
        if resource["authority"] == "retain_shared":
            _require(resource["type"] == "artifact_repository")
    inventory = metadata.get("substrateReceipt") or {}
    original = {(item["type"], item["id"]) for item in inventory.get("plannedResources", [])}
    _require(bool(original))
    _require(original <= {(item["type"], item["id"]) for item in resources})
    # The database additionally compares the complete effective inventory, including
    # notification and Files successors, before admitting this plan.
    _require(
        any(item["type"] == "gcs_bucket" and item["id"] == memory["bucket"] for item in resources)
    )


def _validate_memory(project: str, memory: dict) -> None:
    _require(
        isinstance(memory, dict)
        and set(memory)
        == {"bucket", "object", "generation", "sha256", "engineName", "engineCreateTime"}
    )
    _require(
        re.fullmatch(r"[1-9][0-9]*", str(memory["generation"])) is not None
        and re.fullmatch(r"[0-9a-f]{64}", str(memory["sha256"])) is not None
        and re.fullmatch(
            rf"projects/{re.escape(project)}/locations/[a-z0-9-]+/reasoningEngines/[A-Za-z0-9_-]+",
            memory["engineName"],
        )
        is not None
        and memory["object"].split("/")[-1] == "memory_bank.json"
        and bool(memory["engineCreateTime"])
    )


def resource_state(recovery: dict, key: str) -> dict:
    """Only retained acknowledgement/settlement permits progress, never elapsed time."""
    result: dict = {}
    for event in recovery.get("events", []):
        if event.get("resource") == key:
            result[event["stage"]] = deepcopy(event["receipt"])
    return result


def operator_source(recovery: dict) -> str:
    """A qualified append changes the executor source, never the approved plan."""
    return next(
        (
            event["receipt"]["sourceRevision"]
            for event in reversed(recovery["events"])
            if event["stage"] == "operator_source"
        ),
        recovery["plan"]["sourceRevision"],
    )


def recovery_view(recovery: dict, *, identity_hashes: dict | None = None) -> dict:
    plan = recovery["plan"]
    states = {
        resource_key(item): resource_state(recovery, resource_key(item))
        for item in plan["resources"]
    }
    removable = [item for item in plan["resources"] if item["authority"] != "retain_shared"]
    complete = sum(
        states[resource_key(item)].get("observation", {}).get("status")
        in {"deleted", "observed_absent"}
        for item in removable
    )
    events = recovery.get("events", [])
    started = max(
        (i for i, event in enumerate(events) if event.get("stage") == "executor_started"),
        default=-1,
    )
    failure = next(
        (event for event in reversed(events[started + 1 :]) if event.get("stage") == "attention"),
        None,
    )
    exited = next(
        (
            event
            for event in reversed(events[started + 1 :])
            if event.get("stage") == "executor_exit"
        ),
        None,
    )
    if failure is None and exited and exited["receipt"]["outcome"] != "returned":
        failure = {"receipt": {"code": "CLOUD_REMOVAL_RECOVERY_INTERRUPTED"}}
    pending = any("intent" in state and "observation" not in state for state in states.values())
    approved = any(event.get("stage") == "approval" for event in events)
    approval_current = any(
        event.get("stage") == "approval"
        and datetime.fromisoformat(event["recordedAt"].replace("Z", "+00:00"))
        > datetime.now(timezone.utc) - timedelta(minutes=10)
        for event in events
    )
    # This is a native recheck boundary, never evidence that erasure finished.
    waiting = [
        item
        for item in plan["resources"]
        if states[resource_key(item)].get("observation", {}).get("status") == "waiting_for_provider"
    ]
    eligible = []
    for item in waiting:
        observation = states[resource_key(item)]["observation"]
        coverage = observation.get("coverage", {})
        value = coverage.get("nextEligibleAt")
        if (
            not identity_hashes
            or observation.get("identitySha256") != identity_hashes.get(resource_key(item))
            or coverage.get("providerRetention") is not True
            or coverage.get("inventoryComplete") is not True
            or not isinstance(value, str)
            or not value.endswith("Z")
        ):
            break
        try:
            instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            break
        eligible.append((instant, value))
    return {
        "operationId": plan["attemptId"],
        "provider": "gcp",
        "keepAccount": True,
        "planDigest": recovery["planSha256"],
        "resources": [{"id": item["id"], "scope": "resource_only"} for item in plan["resources"]],
        "removed": complete,
        "total": len(removable),
        "progressKnown": True,
        "canFinalize": recovery.get("qualifiedComplete") is True,
        "approvalRequired": not approval_current and recovery.get("qualifiedComplete") is not True,
        "confirmation": plan["project"]["projectId"],
        "executionStarted": any(
            event.get("stage") == "intent" for event in recovery.get("events", [])
        ),
        "canCancel": False,
        "inProgress": (pending or started >= 0 and exited is None)
        and approved
        and failure is None
        and recovery.get("qualifiedComplete") is not True,
        "workerOutcome": "failed" if failure else None,
        "authorizationOutcome": {"status": "attention_required", "code": failure["receipt"]["code"]}
        if failure
        else None,
        "legacyRecovery": True,
        "nextEligibleAt": min(eligible)[1] if waiting and len(eligible) == len(waiting) else None,
    }


async def append_recovery_event(store: Any, owner: str, recovery: dict, event: dict) -> dict:
    """SQL derives the current journal digest and admits one immutable event."""
    value = await store._value(
        "SELECT public.retain_legacy_cloud_removal(:owner,:attempt,"
        "encode(sha256(convert_to(CAST(:expected AS jsonb)::text,'UTF8')),'hex'),"
        "CAST(:plan AS jsonb),CAST(:event AS jsonb)) AS value",
        {
            "owner": owner,
            "attempt": recovery["plan"]["attemptId"],
            "expected": json.dumps(recovery),
            "plan": json.dumps(recovery["plan"]),
            "event": json.dumps(event),
        },
    )
    if not isinstance(value, dict):
        raise AzureTeardownRefused("CLOUD_REMOVAL_RECOVERY_CHANGED")
    return value


class LegacyRemovalJournal:
    """One dedicated PostgreSQL session for a source-pinned operator execution."""

    def __init__(self, connection: Any, owner: str, attempt: str) -> None:
        self.connection = connection
        self.owner = owner
        self.attempt = attempt
        self.execution_id: str | None = None

    def _one(self, sql: str, params: tuple = ()) -> Any:
        with self.connection.cursor() as cursor:
            cursor.execute(sql, params)
            row = cursor.fetchone()
        return row[0] if row else None

    def read(self) -> dict:
        value = self._one(
            "SELECT c.recovery FROM public.personal_agent_cloud_removals c "
            "JOIN public.personal_agent_registry p ON p.user_id=c.user_id "
            "WHERE c.user_id=%s AND c.attempt_id=%s AND c.completed_at IS NULL "
            "AND c.cancelled_at IS NULL AND p.status='suspended' "
            "AND p.backend_metadata->'erasure'->>'attemptId'=c.attempt_id "
            "AND c.snapshot_sha256=encode(sha256(convert_to("
            "(p.backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex')",
            (self.owner, self.attempt),
        )
        _require(isinstance(value, dict), "CLOUD_REMOVAL_RECOVERY_CHANGED")
        return value

    def identity_sha256(self, resource: dict) -> str:
        return self._one(
            "SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex')",
            (json.dumps(resource["identity"]),),
        )

    def prepare(self, plan: dict) -> dict:
        existing = self._one(
            "SELECT recovery FROM public.personal_agent_cloud_removals WHERE user_id=%s AND attempt_id=%s",
            (self.owner, self.attempt),
        )
        if isinstance(existing, dict):
            _require(existing.get("plan") == plan, "CLOUD_REMOVAL_RECOVERY_CHANGED")
            return self.read()
        value = self._one(
            "SELECT public.retain_legacy_cloud_removal(%s,%s,%s,%s::jsonb)",
            (self.owner, self.attempt, plan["snapshotSha256"], json.dumps(plan)),
        )
        _require(isinstance(value, dict), "CLOUD_REMOVAL_RECOVERY_UNVERIFIED")
        return value

    def append(self, resource: str, stage: str, receipt: dict) -> dict:
        event = {"resource": resource, "stage": stage, "receipt": receipt}
        if self.execution_id is not None:
            event["executionId"] = self.execution_id
        for _ in range(2):
            current = self.read()
            if any({key: saved.get(key) for key in event} == event for saved in current["events"]):
                return current
            value = self._one(
                "SELECT public.retain_legacy_cloud_removal(%s,%s,"
                "encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex'),%s::jsonb,%s::jsonb)",
                (
                    self.owner,
                    self.attempt,
                    json.dumps(current),
                    json.dumps(current["plan"]),
                    json.dumps(event),
                ),
            )
            if isinstance(value, dict):
                return value
            # A definite CAS refusal may follow a concurrent owner approval.
            # Retry only retention against the new prefix, never the provider call.
            _require(self.read() != current, "CLOUD_REMOVAL_RECOVERY_CHANGED")
        raise AzureTeardownRefused("CLOUD_REMOVAL_RECOVERY_CHANGED")

    def start(self, execution_id: str, source_revision: str) -> dict:
        _require(operator_source(self.read()) == source_revision)
        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()"
            )
            pid, started = cursor.fetchone()
        receipt = {
            "executionId": execution_id,
            "sourceRevision": source_revision,
            "databasePid": pid,
            "databaseStartedAt": started,
        }
        self.append("$executor", "executor_started", receipt)
        self.execution_id = execution_id
        return receipt


def record_supervised_exit(
    journal: LegacyRemovalJournal, process: subprocess.Popen, started: dict
) -> int:
    """The parent records exit only after joining the actual child process.

    PostgreSQL independently refuses this receipt while the original database
    session remains alive. Its absence alone never creates an exit receipt.
    """
    status = process.wait()
    _require(process.returncode is not None)
    journal.append(
        "$executor",
        "executor_exit",
        {
            **started,
            "processExitCode": status,
            "outcome": "returned" if status == 0 else "failed",
            "supervisorVerified": True,
        },
    )
    return status
