"""Explicit cleanup admission; pending retirement never asserts release health."""

from __future__ import annotations

import hashlib
import json
import re


UAT_DRIVE_WORKER = "consent-protocol-drive-worker"
_WORKER_STARTUP_FAILURE = "HealthCheckContainerError"


def uat_worker_release_run_id(args, run_id: int) -> int | None:
    if (
        args.environment == "uat"
        and getattr(args, "force_inspection", False)
        and getattr(args, "release_run_id", "") == str(run_id)
    ):
        return run_id
    return None


def _condition(snapshot, kind, status, *, reason=None) -> bool:
    conditions = [
        row for row in (snapshot.get("status") or {}).get("conditions", [])
        if row.get("type") == kind
    ]
    return (
        len(conditions) == 1
        and conditions[0].get("status") == status
        and (reason is None or conditions[0].get("reason") == reason)
    )


def _settled_worker_traffic(state, traffic, serving, failed) -> bool:
    generation = (state.get("metadata") or {}).get("generation")
    status = state.get("status") or {}
    desired = (state.get("spec") or {}).get("traffic")
    if (
        type(generation) is not int
        or generation < 1
        or status.get("observedGeneration") != generation
        or status.get("latestReadyRevisionName") != serving
        or failed == serving
        or not isinstance(failed, str)
        or not failed.startswith(f"{UAT_DRIVE_WORKER}-")
        or not _condition(state, "Ready", "False", reason=_WORKER_STARTUP_FAILURE)
        or not traffic
        or any(name != serving for name, _, _ in traffic)
        or not isinstance(desired, list)
    ):
        return False
    if any(
        not isinstance(row, dict)
        or row.get("latestRevision", False) is not False
        or row.get("revisionName") not in {serving, failed}
        or type(row.get("percent", 0)) is not int
        or row.get("percent", 0) not in {0, 100}
        for row in desired
    ):
        return False
    return [(row["revisionName"], row["percent"]) for row in desired if row.get("percent")] == [
        (serving, 100)
    ]


def _worker_revision(revisions, name):
    matches = [
        row for row in revisions
        if (row.get("metadata") or {}).get("name") == name
    ]
    if len(matches) != 1:
        return None
    labels = (matches[0].get("metadata") or {}).get("labels") or {}
    return matches[0] if labels.get("serving.knative.dev/service") == UAT_DRIVE_WORKER else None


def accepted_worker_with_failed_candidate(retention, state, traffic, serving, release, run_id):
    """Prove the accepted worker still serves while the latest candidate is unrouted."""
    verification = release.get("verification") or {}
    failed = (state.get("status") or {}).get("latestCreatedRevisionName")
    if (
        type(run_id) is not int
        or run_id < 1
        or release.get("status") != "healthy"
        or verification.get("drive_worker") != "success"
        or verification.get("drive_worker_gate_success") is not True
        or not re.fullmatch(r"[0-9a-f]{40}", str(release.get("sha", "")))
        or not _settled_worker_traffic(state, traffic, serving, failed)
    ):
        return False
    revisions = retention.revision_state(UAT_DRIVE_WORKER, "hushh-pda-uat", "us-central1")
    active = _worker_revision(revisions, serving)
    rejected = _worker_revision(revisions, failed)
    if active is None or rejected is None:
        return False
    labels = active["metadata"]["labels"]
    return (
        labels.get("deploy-sha") == release["sha"]
        and labels.get("github-run-id") == str(run_id)
        and _condition(active, "Ready", "True")
        and _condition(active, "Active", "True")
        and _condition(active, "ContainerHealthy", "True")
        and _condition(rejected, "Ready", "False", reason=_WORKER_STARTUP_FAILURE)
        and _condition(rejected, "Active", "False")
    )


def cleanup_arguments(args, parser):
    if args.keep_count < 1 or args.drain_seconds < 0:
        parser.error("keep_count must be positive and drain-seconds nonnegative")
    if args.apply and not (args.healthy or args.qualified_pending_retirement):
        parser.error(
            "--apply requires a passed health gate or qualified pending retirement"
        )
    if args.tags_only and args.defer_state:
        parser.error("--tags-only and --defer-state cannot be combined")
    if args.defer_state and (not args.apply or not args.release_run_id.isdigit()):
        parser.error("--defer-state requires --apply and a numeric --release-run-id")
    if args.carry_uat_clock and (
        not args.defer_state or args.project != "hushh-pda-uat"
    ):
        parser.error("--carry-uat-clock requires deferred cleanup in the UAT project")
    if not args.qualified_pending_retirement:
        if args.qualified_pending_retirement_sha256:
            parser.error("pending retirement digest requires its exact context")
        return None
    path = args.qualified_pending_retirement
    raw = path.read_bytes()
    value = json.loads(raw)
    if (
        path.is_symlink()
        or len(raw) > 1024 * 1024
        or not isinstance(value, dict)
        or not re.fullmatch(r"[0-9a-f]{64}", args.qualified_pending_retirement_sha256)
        or hashlib.sha256(raw).hexdigest() != args.qualified_pending_retirement_sha256
        or type(value.get("schema_version")) is not int
        or value["schema_version"] != 1
        or value.get("kind") != "production-pending-retirement"
        or value.get("status") != "pending_activation"
        or value.get("healthy_release") is not False
        or args.project != "hushh-pda"
        or args.service != "consent-protocol"
        or not args.apply
        or not args.defer_state
        or args.tags_only
        or str(value.get("release_run_id")) != args.release_run_id
        or value.get("candidate", {}).get("revision") != args.protected_revision
        or value.get("cold_rollback", {}).get("revision") != args.rollback_revision
        or args.last_known_good_revision != args.rollback_revision
    ):
        parser.error("pending retirement context is not exactly bound to cleanup")
    return value


def pending_plan(owner, context, service, revisions, plan) -> None:
    candidate, rollback = context["candidate"], context["cold_rollback"]
    by_name = {row["metadata"]["name"]: row for row in revisions}
    targets = ((candidate, candidate["source"]), (rollback, rollback["source"]))
    if service.get("metadata", {}).get("uid") != candidate["service_uid"] or (
        plan.serving != frozenset({candidate["revision"]})
        or not {candidate["revision"], rollback["revision"]}.issubset(plan.protected)
        or [
            (name, percent)
            for name, percent, _ in owner.traffic_state(service)
            if percent
        ]
        != [(candidate["revision"], 100)]
    ):
        raise owner.UnsafeState("pending retirement protected service changed")
    for identity, source in targets:
        row = by_name.get(identity["revision"], {})
        if (
            row.get("metadata", {}).get("uid") != identity["uid"]
            or row.get("metadata", {}).get("labels", {}).get("deploy-sha") != source
        ):
            raise owner.UnsafeState("pending retirement protected revision changed")
    expected = {row["revision"]: row for row in context["pending_revisions"]}
    allowed_tags = {tag for row in expected.values() for tag in row["tags"]}
    if not set(plan.delete_revisions).issubset(expected) or not set(
        plan.remove_tags
    ).issubset(allowed_tags):
        raise owner.UnsafeState("pending retirement plan exceeds qualified inventory")
    for name in plan.delete_revisions:
        row, wanted = by_name[name], expected[name]
        if (
            row.get("metadata", {}).get("uid") != wanted["uid"]
            or row.get("metadata", {}).get("labels", {}).get("deploy-sha")
            != wanted["source"]
        ):
            raise owner.UnsafeState("pending retirement legacy revision changed")


def known_good_revision(owner, environment: str, lane: str) -> str:
    if environment == "uat":
        tag = owner.retention.run_command(
            ["git", "show-ref", "--verify", "--quiet", "refs/tags/deployed/uat-latest"],
            check=False,
            timeout=30,
        )
        if tag.returncode not in {0, 1}:
            raise owner.retention.UnsafeState("UAT last-known-good tag lookup failed")
    if environment != "uat" or tag.returncode == 0:
        return owner.command(
            "bash", "scripts/ci/resolve-rollback-target.sh", environment, lane
        ).strip()
    return ""


def legacy_protection(
    owner,
    service: str,
    lane: str,
    release: dict,
    *,
    environment: str = "uat",
    phone_anchor=None,
) -> list[str]:
    current = release["final"][f"{lane}_revision"]
    rollback = release.get("predeploy", {}).get(f"{lane}_revision", "")
    if (
        environment == "uat"
        and lane == "backend"
        and release.get("scope") == "frontend"
    ):
        verified_rollback = release.get("_maintenance_backend_rollback_revision")
        if not isinstance(verified_rollback, str) or not re.fullmatch(
            r"consent-protocol-[a-z0-9-]+", verified_rollback
        ):
            raise owner.retention.UnsafeState(
                "frontend-only UAT backend rollback is unverified"
            )
        rollback = verified_rollback
    known_good = known_good_revision(owner, environment, lane)
    present: set[str] = set()
    if rollback or environment == "uat" or phone_anchor is not None:
        revisions = owner.retention.revision_state(
            service, owner.LANES[environment]["project"], owner.REGION
        )
        present = {item["metadata"]["name"] for item in revisions}
    if phone_anchor is not None:
        import production_phone_receipt

        if environment != "production" or lane != "backend":
            raise owner.retention.UnsafeState(
                "phone anchor is outside production backend authority"
            )
        rollback = production_phone_receipt.rollback_revision(
            phone_anchor, release, revisions
        )
    if rollback:
        if not owner.retention.REVISION_RE.fullmatch(rollback):
            raise owner.retention.UnsafeState("source predeploy revision is invalid")
        if rollback not in present:
            # After rollback, an older release artifact can name a predeploy
            # revision that a later healthy release already retired.
            print(f"Source predeploy revision {rollback} is already absent.")
            rollback = ""
    if known_good not in present and environment == "uat":
        # A tag records a historical revision and can outlive Cloud Run
        # retention. It cannot protect a revision that no longer exists.
        # Preserve an artifact-backed rollback anchor, or the verified live
        # revision when the historical predeploy revision is already absent.
        replacement = rollback or current
        if replacement not in present:
            raise owner.retention.UnsafeState("UAT recovery anchor is absent")
        print(
            f"Tagged last-known-good revision {known_good} is absent; "
            f"protecting verified UAT revision {replacement} instead."
        )
        known_good = replacement
    return [
        current,
        "--rollback-revision",
        rollback,
        "--last-known-good-revision",
        known_good,
    ]
