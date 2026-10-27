#!/usr/bin/env python3
"""Retire revisions after verified health or qualified pending retirement."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from process_group import command_group
import retention_admission

REVISION_RE = re.compile(r"^[a-z][a-z0-9-]*-[a-z0-9]+$")
TAG_RE = re.compile(r"^[a-z][a-z0-9-]*$")


class UnsafeState(RuntimeError):
    """Observed state does not authorize cleanup."""


class BudgetExpired(RuntimeError):
    """The bounded pass must checkpoint and yield, not wait on a runner."""


class MutationUncertain(UnsafeState):
    """A submitted mutation needs observation before any retry."""


PASS_DEADLINE: ContextVar[float | None] = ContextVar("retention_deadline", default=None)


def remaining_seconds(limit: float = 180) -> float:
    deadline = PASS_DEADLINE.get()
    remaining = limit if deadline is None else min(limit, deadline - time.monotonic())
    if remaining <= 0:
        raise BudgetExpired("Cleanup execution budget exhausted")
    return remaining


def run_command(args, *, timeout=180, check=True, text=True):
    """Reap the entire owned command group on timeout; never print payloads."""
    timeout = remaining_seconds(timeout)
    with command_group(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=text,
    ) as (process, stop):
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except (subprocess.TimeoutExpired, BudgetExpired) as exc:
            stop()
            try:
                process.communicate(timeout=0.5)
            except subprocess.TimeoutExpired:
                stop(force=True)
                process.communicate(timeout=0.5)
            raise BudgetExpired(
                "Cleanup command exceeded its execution budget"
            ) from exc
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result


def atomic_state(path: Path, state: dict) -> None:
    if path.is_symlink():
        raise UnsafeState("cleanup checkpoint is a symlink")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    if temporary.is_symlink():
        raise UnsafeState("temporary cleanup checkpoint is a symlink")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(path)


@dataclass(frozen=True)
class Plan:
    serving: frozenset[str]
    protected: frozenset[str]
    remove_tags: tuple[str, ...]
    delete_revisions: tuple[str, ...]


def gcloud(
    args: list[str], project: str | None, region: str, *, json_output: bool = True
) -> Any:
    command = ["gcloud", "run", *args, f"--region={region}"]
    if project:
        command.append(f"--project={project}")
    command.append("--format=json" if json_output else "--quiet")
    result = run_command(command)
    return json.loads(result.stdout) if json_output else None


def traffic_state(service: dict[str, Any]) -> tuple[tuple[str, int, str], ...]:
    items = (service.get("status") or {}).get("traffic")
    if not isinstance(items, list) or not items:
        raise UnsafeState("service has no resolved traffic entries")
    traffic = []
    for item in items:
        revision, percent, tag = (
            item.get("revisionName"),
            item.get("percent", 0),
            item.get("tag") or "",
        )
        if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
            raise UnsafeState("traffic has an invalid or unresolved revision")
        if not isinstance(percent, int) or not 0 <= percent <= 100:
            raise UnsafeState("traffic has an invalid percentage")
        if tag and not TAG_RE.fullmatch(tag):
            raise UnsafeState("traffic has an invalid tag")
        traffic.append((revision, percent, tag))
    if sum(percent for _, percent, _ in traffic) != 100:
        raise UnsafeState("resolved traffic does not total 100%")
    return tuple(sorted(traffic))


def traffic_fingerprint(service: dict[str, Any]) -> tuple[Any, str, Any, Any]:
    # A desired traffic update can precede its resolved status. Include both
    # generations and desired traffic so a concurrent rollout cannot hide in
    # the status propagation window.
    metadata = service.get("metadata") or {}
    desired = (service.get("spec") or {}).get("traffic")
    return (
        traffic_state(service),
        json.dumps(desired, sort_keys=True),
        metadata.get("generation"),
        metadata.get("uid"),
    )


def plan_cleanup(
    service: dict[str, Any],
    revisions: list[dict[str, Any]],
    keep_count: int,
    explicit_protected: set[str],
) -> Plan:
    traffic = traffic_state(service)
    serving = {revision for revision, percent, _ in traffic if percent > 0}
    names = []
    for item in revisions:
        metadata = item.get("metadata") or {}
        name = metadata.get("name")
        created = metadata.get("creationTimestamp")
        if not isinstance(name, str) or not REVISION_RE.fullmatch(name):
            raise UnsafeState("revision list has an invalid name")
        if not isinstance(created, str) or not created:
            raise UnsafeState("revision list has no creation timestamp")
        names.append((created, name))
    if len(names) != len({name for _, name in names}):
        raise UnsafeState("revision list contains duplicates")
    ordered = [name for _, name in sorted(names, reverse=True)]
    if not serving.issubset(ordered):
        raise UnsafeState("serving revision absent from revision list")
    if not explicit_protected.issubset(ordered):
        raise UnsafeState("protected revision absent from revision list")
    # Keep a fallback if the caller omitted its exact predeploy revision.
    fallback = next((name for name in ordered if name not in serving), None)
    protected = serving | explicit_protected
    status = service.get("status") or {}
    protected.update(
        name
        for name in (
            status.get("latestCreatedRevisionName"),
            status.get("latestReadyRevisionName"),
        )
        if name
    )
    if not protected.issubset(ordered):
        raise UnsafeState("latest revision absent from revision list")
    if fallback and not (explicit_protected - serving):
        protected.add(fallback)
    # Exact rollback anchors count toward retention. Otherwise a failed newer
    # candidate displaces neither anchor and is retained indefinitely as an
    # extra revision, consuming the next release's connection budget.
    for name in ordered:
        if len(protected) >= keep_count:
            break
        protected.add(name)
    # Revision protection preserves rollback artifacts, not their public tag
    # URLs. A zero-traffic tag can still serve requests and bypass the service
    # instance cap, even when its revision is retained for rollback.
    remove_tags = tuple(
        sorted({tag for _, percent, tag in traffic if percent == 0 and tag})
    )
    tagged_after_cleanup = {
        revision for revision, _, tag in traffic if tag and tag not in remove_tags
    }
    protected |= tagged_after_cleanup
    return Plan(
        frozenset(serving),
        frozenset(protected),
        remove_tags,
        tuple(name for name in ordered if name not in protected),
    )


def required_drain_seconds(
    service: dict[str, Any], revisions: list[dict[str, Any]], plan: Plan, requested: int
) -> int:
    """Cover the longest request that could still use a revision being deleted."""
    if not plan.delete_revisions:
        return 0
    template = (service.get("spec") or {}).get("template") or {}
    timeouts = [(template.get("spec") or {}).get("timeoutSeconds")]
    by_name = {(item.get("metadata") or {}).get("name"): item for item in revisions}
    for name in plan.delete_revisions:
        timeouts.append((by_name[name].get("spec") or {}).get("timeoutSeconds"))
    if any(
        isinstance(value, bool) or not str(value).isdigit() or int(value) < 1
        for value in timeouts
    ):
        raise UnsafeState("request timeout unavailable for a revision to delete")
    return max(requested, max(int(value) for value in timeouts) + 60)


def revision_drain_seconds(item: dict[str, Any], requested: int) -> int:
    """One revision's own longest request, bounded as required_drain_seconds is."""
    value = (item.get("spec") or {}).get("timeoutSeconds")
    if isinstance(value, bool) or not str(value).isdigit() or int(value) < 1:
        raise UnsafeState("request timeout unavailable for a revision to delete")
    return max(requested, int(value) + 60)


def routed_revisions(service: dict[str, Any]) -> frozenset[str]:
    """Every revision that resolved or desired traffic sends requests or a tag to."""
    names = {name for name, _, _ in traffic_state(service)}
    desired = (service.get("spec") or {}).get("traffic") or []
    if not isinstance(desired, list):
        raise UnsafeState("service has invalid desired traffic")
    for item in desired:
        name = item.get("revisionName") if isinstance(item, dict) else ""
        if name is None:
            # A latestRevision target resolves in status traffic, and
            # plan_cleanup always keeps the latest revisions.
            continue
        if not isinstance(name, str) or not REVISION_RE.fullmatch(name):
            raise UnsafeState("desired traffic has an invalid revision")
        names.add(name)
    return frozenset(names)


def revision_retired(item: dict[str, Any]) -> bool:
    """Cloud Run's own report that a revision is retired; absence proves nothing."""
    conditions = (item.get("status") or {}).get("conditions")
    if not isinstance(conditions, list) or not all(
        isinstance(condition, dict) for condition in conditions
    ):
        return False
    active = [c for c in conditions if c.get("type") == "Active"]
    return (
        len(active) == 1
        and active[0].get("status") == "False"
        and active[0].get("reason") == "Retired"
    )


def revision_clocks(
    prior: dict[str, Any],
    *,
    authority: dict[str, str],
    observed: list[Any],
    candidates: dict[str, dict[str, Any]],
    routed: frozenset[str],
    now: int,
) -> dict[str, dict[str, Any]]:
    """Since when each unrouted revision is proven to have received no request.

    An unchanged service fingerprint carries every clock, as the service-wide
    clock always has: traffic and tags cannot change without a new generation.
    Across a generation change only the revision object is evidence. Serving
    or tag traffic needs an active revision, and activating a retired revision
    rewrites it, so a revision that Cloud Run reports retired, with the uid and
    resourceVersion (opaque; compared for equality only) of the earlier
    observation, received no route in between. A revision named by traffic now
    or before this pass's tag removal starts afresh, and a receipt without
    revision clocks carries none.
    """
    earlier_clocks = prior.get("clocks")
    fingerprint = prior.get("fingerprint")
    run_id = prior.get("release_run_id")
    trusted = (
        prior.get("schema_version") == 1
        and all(prior.get(key) == value for key, value in authority.items())
        and isinstance(earlier_clocks, dict)
        and isinstance(fingerprint, list)
        and len(fingerprint) == 4
        and fingerprint[3] == observed[3]
        and isinstance(run_id, str)
        and run_id.isdigit()
        and int(run_id) > 0
    )
    unchanged = trusted and fingerprint == observed
    clocks = {}
    for name, item in sorted(candidates.items()):
        metadata = item.get("metadata") or {}
        uid, version = metadata.get("uid"), metadata.get("resourceVersion")
        earlier = earlier_clocks.get(name) if trusted else None
        carried = (
            isinstance(earlier, dict)
            and name not in routed
            and type(earlier.get("observed_at")) is int
            and 0 < earlier["observed_at"] <= now
            and earlier.get("uid") == uid
            and (
                unchanged
                or (
                    isinstance(uid, str)
                    and bool(uid)
                    and isinstance(version, str)
                    and bool(version)
                    and earlier.get("resource_version") == version
                    and revision_retired(item)
                )
            )
        )
        clocks[name] = {
            "uid": uid if isinstance(uid, str) else None,
            "resource_version": version if isinstance(version, str) else None,
            "observed_at": earlier["observed_at"] if carried else now,
        }
    return clocks


def service_state(name: str, project: str | None, region: str) -> dict[str, Any]:
    state = gcloud(["services", "describe", name], project, region)
    if not isinstance(state, dict):
        raise UnsafeState("service describe returned invalid JSON")
    return state


def revision_state(name: str, project: str | None, region: str) -> list[dict[str, Any]]:
    state = gcloud(
        ["revisions", "list", f"--service={name}", "--limit=10000"], project, region
    )
    if not isinstance(state, list):
        raise UnsafeState("revision list returned invalid JSON")
    return state


def assert_traffic(
    name: str, project: str | None, region: str, expected: tuple[Any, ...]
) -> None:
    if traffic_fingerprint(service_state(name, project, region)) != expected:
        raise UnsafeState("service traffic changed during cleanup; refusing mutation")


def deferred_drain_ready(
    path: Path,
    *,
    service: str,
    project: str,
    region: str,
    expected: tuple[Any, ...],
    plan: Plan,
    drain_seconds: int,
    release_run_id: str,
) -> bool:
    """Persist drainage evidence between short maintenance runs, never sleep.

    A generation change invalidates the clock even if traffic went A -> B -> A.
    Revision creation time cannot prove when its last request was admitted.
    UAT keeps one clock per revision instead; see drain_each_revision.
    """
    if not project or not expected[2] or not expected[3]:
        raise UnsafeState(
            "deferred cleanup requires project, service generation and UID"
        )
    now = int(time.time())
    identity = {
        "schema_version": 1,
        "service": service,
        "project": project,
        "region": region,
        "release_run_id": release_run_id,
        "fingerprint": json.loads(json.dumps(expected)),
        "protected": sorted(plan.protected),
    }
    prior = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(prior, dict):
        raise UnsafeState("invalid deferred retention state")
    observed_at = prior.get("observed_at")
    same_service_drain = (
        all(
            prior.get(key) == value
            for key, value in identity.items()
            if key != "release_run_id"
        )
        and isinstance(observed_at, int)
        and not isinstance(observed_at, bool)
        and 0 < observed_at <= now
        and isinstance(prior.get("revisions"), list)
        and all(isinstance(name, str) for name in prior["revisions"])
        and set(plan.delete_revisions).issubset(prior["revisions"])
    )
    valid = same_service_drain and prior.get("release_run_id") == release_run_id
    if not valid:
        observed_at = now
    due_at = observed_at + drain_seconds
    state = {
        **identity,
        "observed_at": observed_at,
        "not_before": due_at,
        "revisions": list(plan.delete_revisions),
    }
    atomic_state(path, state)
    if now < due_at:
        print(
            f"Deferred deletion until epoch {due_at}; {due_at - now}s remain. No runner wait."
        )
        return False
    return True


def reconcile_mutation(path: Path, service: str, project: str, region: str) -> None:
    if not path.exists():
        return
    if path.is_symlink():
        raise UnsafeState("cleanup checkpoint is a symlink")
    state = json.loads(path.read_text())
    intent = state.get("pending_mutation")
    if intent is None:
        return
    if not isinstance(intent, dict) or any(
        state.get(k) != v
        for k, v in (("service", service), ("project", project), ("region", region))
    ):
        raise UnsafeState("mutation checkpoint has incompatible authority")
    live = service_state(service, project, region)
    if (live.get("metadata") or {}).get("uid") != intent.get("service_uid"):
        raise UnsafeState("mutation checkpoint belongs to a replaced service")
    kind = intent.get("kind")
    if kind == "delete" and not REVISION_RE.fullmatch(str(intent.get("revision", ""))):
        raise UnsafeState("invalid pending revision identity")
    if kind == "remove_tags" and (
        not isinstance(intent.get("tags"), list)
        or not intent["tags"]
        or any(
            not isinstance(tag, str) or not TAG_RE.fullmatch(tag)
            for tag in intent["tags"]
        )
        or not isinstance(intent.get("serving"), list)
        or not intent["serving"]
    ):
        raise UnsafeState("invalid pending traffic identity")
    if kind == "delete":
        revisions = revision_state(service, project, region)
        settled = intent.get("revision") not in {
            (item.get("metadata") or {}).get("name") for item in revisions
        }
    elif kind == "remove_tags":
        metadata, status = live.get("metadata") or {}, live.get("status") or {}
        observed = status.get("observedGeneration")
        desired = (live.get("spec") or {}).get("traffic")
        settled = (
            observed is not None
            and str(observed) == str(metadata.get("generation"))
            and any(
                c.get("type") == "Ready" and c.get("status") == "True"
                for c in status.get("conditions", [])
            )
            and isinstance(desired, list)
            and not any(t.get("tag") in intent.get("tags", []) for t in desired)
            and not any(t[2] in intent.get("tags", []) for t in traffic_state(live))
            and sorted(
                [name, percent] for name, percent, _ in traffic_state(live) if percent
            )
            == intent.get("serving")
        )
    else:
        raise UnsafeState("unknown pending cleanup mutation")
    if not settled:
        raise MutationUncertain(
            "Prior provider outcome is unresolved; operator reconciliation required"
        )
    state.pop("pending_mutation")
    atomic_state(path, state)


def mutate(args, command: list[str], expected, intent: dict) -> None:
    if args.defer_state:
        state = (
            json.loads(args.defer_state.read_text())
            if args.defer_state.exists()
            else {
                "schema_version": 1,
                "service": args.service,
                "project": args.project,
                "region": args.region,
                "release_run_id": args.release_run_id,
            }
        )
        state["pending_mutation"] = {**intent, "service_uid": expected[3]}
        atomic_state(args.defer_state, state)
    try:
        gcloud(command, args.project, args.region, json_output=False)
    except (
        BudgetExpired,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as exc:
        raise MutationUncertain(
            "Provider mutation outcome requires reconciliation"
        ) from exc
    if args.defer_state:
        state.pop("pending_mutation")
        atomic_state(args.defer_state, state)


def drain_each_revision(
    args: argparse.Namespace,
    *,
    before: dict[str, Any],
    after: dict[str, Any],
    expected: tuple[Any, ...],
    revisions: list[dict[str, Any]],
    plan: Plan,
    protected: set[str],
) -> int:
    """UAT: delete each revision once its own drain has elapsed; never sleep.

    A clock never authorizes deletion: plan_cleanup still decides what is
    deletable, and traffic is rechecked before every delete. While any
    deletion is pending the receipt keeps every unrouted revision's clock, so
    a rollback anchor can be mature when a later release stops protecting it.
    The receipt records each revision's resourceVersion beside the fingerprint,
    so traffic is also rechecked after the revisions are read.
    """
    if not args.project or not expected[2] or not expected[3]:
        raise UnsafeState(
            "deferred cleanup requires project, service generation and UID"
        )
    now = int(time.time())
    path: Path = args.defer_state
    prior = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(prior, dict):
        raise UnsafeState("invalid deferred retention state")
    if plan.remove_tags:
        # Record each revision as Cloud Run left it after this pass's untag.
        revisions = revision_state(args.service, args.project, args.region)
    # A route added and removed between the fingerprint read and the revision
    # list shows in neither read. Without this check the receipt could pair a
    # carried clock with a resourceVersion read after that route, and a later
    # generation change would carry the clock across it.
    assert_traffic(args.service, args.project, args.region, expected)
    by_name = {(item.get("metadata") or {}).get("name"): item for item in revisions}
    in_traffic = {name for name, _, _ in traffic_state(after)}
    # Before and after the untag, so a tag removed now never carries a clock.
    routed = routed_revisions(before) | routed_revisions(after)
    clocks = revision_clocks(
        prior,
        authority={
            "service": args.service,
            "project": args.project,
            "region": args.region,
        },
        observed=json.loads(json.dumps(traffic_fingerprint(before))),
        candidates={
            name: item for name, item in by_name.items() if name not in in_traffic
        },
        routed=routed,
        now=now,
    )
    pending = list(plan.delete_revisions)
    if not set(pending).issubset(clocks):
        raise UnsafeState("revision to delete is missing or still in traffic")
    drains = {
        name: revision_drain_seconds(by_name[name], args.drain_seconds)
        for name in pending
    }
    due = [name for name in pending if clocks[name]["observed_at"] + drains[name] <= now]
    receipt = {
        "schema_version": 1,
        "service": args.service,
        "project": args.project,
        "region": args.region,
        "release_run_id": args.release_run_id,
        "fingerprint": json.loads(json.dumps(expected)),
        "protected": sorted(plan.protected),
        "checked_at": now,
    }

    def record() -> int | None:
        """Persist pending revisions; not_before only wakes the next pass."""
        if not pending:
            path.unlink(missing_ok=True)
            return None
        deadline = min(clocks[name]["observed_at"] + drains[name] for name in pending)
        atomic_state(
            path,
            {
                **receipt,
                "clocks": clocks,
                "not_before": deadline,
                "revisions": list(pending),
            },
        )
        return deadline

    deadline = record()
    for name in pending:
        print(
            f"  drain {name}: unrouted since epoch {clocks[name]['observed_at']}, "
            f"due at epoch {clocks[name]['observed_at'] + drains[name]}"
        )
    for name in due:
        assert_traffic(args.service, args.project, args.region, expected)
        current = revision_state(args.service, args.project, args.region)
        if name not in {(item.get("metadata") or {}).get("name") for item in current}:
            raise UnsafeState(f"revision disappeared during cleanup: {name}")
        current_plan = plan_cleanup(
            service_state(args.service, args.project, args.region),
            current,
            args.keep_count,
            protected,
        )
        if name not in current_plan.delete_revisions:
            raise UnsafeState(f"revision became protected during cleanup: {name}")
        remaining_seconds()
        mutate(
            args,
            ["revisions", "delete", name],
            expected,
            {"kind": "delete", "revision": name},
        )
        print(f"Deleted {name}")
        pending.remove(name)
        del clocks[name]
        deadline = record()
    if deadline is not None:
        print(
            f"Deferred deletion of {len(pending)} revision(s) until epoch {deadline}; "
            f"{deadline - now}s remain. No runner wait."
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service")
    parser.add_argument("region", nargs="?", default="us-central1")
    parser.add_argument("keep_count", nargs="?", type=int, default=10)
    parser.add_argument("protected_revision", nargs="?", default="")
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT_ID"))
    parser.add_argument("--rollback-revision", default="")
    parser.add_argument("--last-known-good-revision", default="")
    parser.add_argument("--candidate-revision", default="")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument(
        "--dry-run", action="store_true", help="show cleanup plan (the default)"
    )
    admission = parser.add_mutually_exclusive_group()
    admission.add_argument(
        "--healthy", action="store_true", help="assert release health gate passed"
    )
    admission.add_argument("--qualified-pending-retirement", type=Path)
    parser.add_argument("--qualified-pending-retirement-sha256", default="")
    parser.add_argument("--drain-seconds", type=int, default=120)
    parser.add_argument(
        "--tags-only",
        action="store_true",
        help="retire zero-traffic tags without waiting or deleting revisions",
    )
    parser.add_argument(
        "--defer-state",
        type=Path,
        help="persist drain state; return instead of sleeping",
    )
    parser.add_argument("--release-run-id", default="")
    parser.add_argument(
        "--carry-uat-clock",
        action="store_true",
        help="drain each UAT revision on its own clock while it provably stays unrouted",
    )
    args = parser.parse_args()
    pending_context = retention_admission.cleanup_arguments(args, parser)
    protected = {
        name
        for name in (
            args.protected_revision,
            args.rollback_revision,
            args.last_known_good_revision,
            args.candidate_revision,
        )
        if name
    }
    if any(not REVISION_RE.fullmatch(name) for name in protected):
        parser.error("protected revision name is invalid")
    remaining_seconds()
    if args.defer_state:
        reconcile_mutation(args.defer_state, args.service, args.project, args.region)
    before = service_state(args.service, args.project, args.region)
    expected = traffic_fingerprint(before)
    revisions = revision_state(args.service, args.project, args.region)
    plan = plan_cleanup(before, revisions, args.keep_count, protected)
    if pending_context is not None:
        retention_admission.pending_plan(sys.modules[__name__], pending_context, before, revisions, plan)
    drain_seconds = (
        0
        if args.tags_only
        else required_drain_seconds(before, revisions, plan, args.drain_seconds)
    )
    print(
        f"{'APPLY' if args.apply else 'DRY RUN'}: {args.service} project={args.project or '(default)'}"
    )
    print(f"Serving: {', '.join(sorted(plan.serving))}")
    print(f"Protected: {', '.join(sorted(plan.protected))}")
    print(f"Zero-traffic tags to remove: {len(plan.remove_tags)}")
    print(f"Revisions to delete: {len(plan.delete_revisions)}")
    print(f"Drain before deletion: {drain_seconds}s")
    for tag in plan.remove_tags:
        print(f"  untag {tag}")
    for revision in plan.delete_revisions:
        print(f"  delete {revision}")
    if not args.apply:
        return 0
    after_service = before
    if plan.remove_tags:
        assert_traffic(args.service, args.project, args.region, expected)
        mutate(
            args,
            [
                "services",
                "update-traffic",
                args.service,
                f"--remove-tags={','.join(plan.remove_tags)}",
            ],
            expected,
            {
                "kind": "remove_tags",
                "tags": list(plan.remove_tags),
                "serving": sorted(
                    [name, percent] for name, percent, _ in expected[0] if percent
                ),
            },
        )
        after_service = service_state(args.service, args.project, args.region)
        after = traffic_state(after_service)
        expected_after = tuple(
            sorted(item for item in expected[0] if item[2] not in plan.remove_tags)
        )
        if after != expected_after:
            raise UnsafeState(
                "traffic differed after tag removal; refusing revision deletion"
            )
        expected = traffic_fingerprint(after_service)
    if args.tags_only:
        # The independently serialized maintenance job owns full timeout-based
        # draining and deletion. Tag retirement alone preserves all revisions.
        assert_traffic(args.service, args.project, args.region, expected)
        print("Tags retired; revision draining/deletion deferred to maintenance")
        return 0
    if args.carry_uat_clock:
        # The parser allows this only for deferred UAT cleanup.
        return drain_each_revision(
            args,
            before=before,
            after=after_service,
            expected=expected,
            revisions=revisions,
            plan=plan,
            protected=protected,
        )
    if plan.delete_revisions:
        if args.defer_state:
            if not deferred_drain_ready(
                args.defer_state,
                service=args.service,
                project=args.project,
                region=args.region,
                expected=expected,
                plan=plan,
                drain_seconds=drain_seconds,
                release_run_id=args.release_run_id,
            ):
                return 0
        # This also covers a retry after an earlier run removed tags but failed
        # before deletion; no durable untag timestamp is available.
        else:
            print(
                f"Waiting {drain_seconds}s for requests to drain before deletion",
                flush=True,
            )
            time.sleep(drain_seconds)
    for revision in plan.delete_revisions:
        assert_traffic(args.service, args.project, args.region, expected)
        current = revision_state(args.service, args.project, args.region)
        if revision not in {
            (item.get("metadata") or {}).get("name") for item in current
        }:
            raise UnsafeState(f"revision disappeared during cleanup: {revision}")
        current_service = service_state(args.service, args.project, args.region)
        current_plan = plan_cleanup(
            current_service,
            current,
            args.keep_count,
            protected,
        )
        if pending_context is not None:
            retention_admission.pending_plan(sys.modules[__name__], pending_context, current_service, current, current_plan)
        if revision not in current_plan.delete_revisions:
            raise UnsafeState(f"revision became protected during cleanup: {revision}")
        remaining_seconds()
        mutate(
            args,
            ["revisions", "delete", revision],
            expected,
            {"kind": "delete", "revision": revision},
        )
        print(f"Deleted {revision}")
    if args.defer_state:
        args.defer_state.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        json.JSONDecodeError,
        UnsafeState,
    ) as exc:
        print(f"Retention stopped: {exc}", file=sys.stderr)
        sys.exit(1)
