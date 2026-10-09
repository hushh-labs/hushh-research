#!/usr/bin/env python3
"""Safely retire tagged Cloud Run revisions after a healthy release."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any


REVISION_RE = re.compile(r"^[a-z][a-z0-9-]*-[a-z0-9]+$")
TAG_RE = re.compile(r"^[a-z][a-z0-9-]*$")


class UnsafeState(RuntimeError):
    """Observed state does not authorize cleanup."""


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
    result = subprocess.run(command, check=True, capture_output=True, text=True)
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


def traffic_fingerprint(service: dict[str, Any]) -> tuple[Any, str, Any]:
    # A desired traffic update can precede its resolved status. Include both
    # generations and desired traffic so a concurrent rollout cannot hide in
    # the status propagation window.
    metadata = service.get("metadata") or {}
    desired = (service.get("spec") or {}).get("traffic")
    return (
        traffic_state(service),
        json.dumps(desired, sort_keys=True),
        metadata.get("generation"),
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
    protected = serving | explicit_protected | set(ordered[:keep_count])
    if fallback:
        protected.add(fallback)
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
    name: str, project: str | None, region: str, expected: tuple[Any, str, Any]
) -> None:
    if traffic_fingerprint(service_state(name, project, region)) != expected:
        raise UnsafeState("service traffic changed during cleanup; refusing mutation")


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
    parser.add_argument(
        "--healthy", action="store_true", help="assert release health gate passed"
    )
    parser.add_argument("--drain-seconds", type=int, default=120)
    parser.add_argument(
        "--tags-only", action="store_true",
        help="retire zero-traffic tags without waiting or deleting revisions",
    )
    args = parser.parse_args()
    if args.keep_count < 1 or args.drain_seconds < 0:
        parser.error("keep_count must be positive and drain-seconds nonnegative")
    if args.apply and not args.healthy:
        parser.error("--apply requires --healthy after the release health gate")
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
    before = service_state(args.service, args.project, args.region)
    expected = traffic_fingerprint(before)
    revisions = revision_state(args.service, args.project, args.region)
    plan = plan_cleanup(before, revisions, args.keep_count, protected)
    drain_seconds = (
        0 if args.tags_only
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
    if plan.remove_tags:
        assert_traffic(args.service, args.project, args.region, expected)
        gcloud(
            [
                "services",
                "update-traffic",
                args.service,
                f"--remove-tags={','.join(plan.remove_tags)}",
            ],
            args.project,
            args.region,
            json_output=False,
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
    if plan.delete_revisions:
        # This also covers a retry after an earlier run removed tags but failed
        # before deletion; no durable untag timestamp is available.
        print(f"Waiting {drain_seconds}s for requests to drain before deletion")
        time.sleep(drain_seconds)
    for revision in plan.delete_revisions:
        assert_traffic(args.service, args.project, args.region, expected)
        current = revision_state(args.service, args.project, args.region)
        if revision not in {
            (item.get("metadata") or {}).get("name") for item in current
        }:
            raise UnsafeState(f"revision disappeared during cleanup: {revision}")
        current_plan = plan_cleanup(
            service_state(args.service, args.project, args.region),
            current,
            args.keep_count,
            protected,
        )
        if revision not in current_plan.delete_revisions:
            raise UnsafeState(f"revision became protected during cleanup: {revision}")
        gcloud(
            ["revisions", "delete", revision],
            args.project,
            args.region,
            json_output=False,
        )
        print(f"Deleted {revision}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (subprocess.CalledProcessError, json.JSONDecodeError, UnsafeState) as exc:
        print(f"Retention stopped: {exc}", file=sys.stderr)
        sys.exit(1)
