#!/usr/bin/env python3
"""Black-box two-pass drain contract for UAT Cloud Run revision retention.

Each test runs cloudrun-retention.py main() the way uat-retention-maintenance.py
runs it on a scheduled pass (--apply --healthy --defer-state --release-run-id
--carry-uat-clock), once per maintenance pass. A fake Cloud Run control plane
answers every `gcloud run` command the script sends. Between passes the test
changes the fake world: a failed candidate, a tag removal, a release, or an
out-of-band route. Time is patched, time.sleep raises, and nothing reaches a
network or a cloud.

The fake world also checks ground truth on every delete. A revision is never
deleted while spec or status traffic references it, while it is the latest
revision, or sooner than its own request timeout + 60 s after it was last
routable. So an unsafe deletion fails a test even where the test makes no
explicit assertion about that revision.

Tiers
  RequiredSafety    Fail-closed properties. They held before per-revision
                    clocks and must keep holding.
  RequiredLiveness  The per-revision drain. They failed before it: they replay
                    the 2026-10-15 UAT 844/800 capacity deadlock.
  RequiredReceipt   What a per-revision receipt promises the next pass and
                    maintenance: when it falls due, and what a pass that is
                    interrupted or stopped leaves behind.
  Advisory          Liveness worth keeping. A failure is a regression or a
                    known limit, not a safety violation.

Run
  python3 scripts/ci/test_uat_per_revision_drain.py
"""

from __future__ import annotations

import contextlib
import copy
import importlib
import importlib.util
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("cloudrun-retention.py")
SPEC = importlib.util.spec_from_file_location("cloudrun_retention_drain_contract", SCRIPT)
RETENTION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RETENTION
SPEC.loader.exec_module(RETENTION)
MAINTENANCE = importlib.import_module("uat-retention-maintenance")

UAT, PRODUCTION = "hushh-pda-uat", "hushh-pda"
REGION, SERVICE = "us-central1", "consent-protocol"
TIMEOUT = 3600  # live UAT consent-protocol request timeout
DRAIN = TIMEOUT + 60  # 3660 s, the live UAT backend drain


def epoch(stamp: str) -> int:
    return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())


def iso(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def conditions(*, active: bool, at: int) -> list[dict]:
    stamp = iso(at)
    if active:
        return [
            {"type": "Ready", "status": "True", "lastTransitionTime": stamp},
            {"type": "Active", "status": "True", "lastTransitionTime": stamp},
            {"type": "ResourcesAvailable", "status": "True", "lastTransitionTime": stamp},
        ]
    # The shape UAT returned on 2026-10-15 for a revision with no traffic and no tag.
    return [
        {"type": "Ready", "status": "True", "reason": "Retired", "lastTransitionTime": stamp},
        {
            "type": "Active",
            "status": "False",
            "reason": "Retired",
            "message": "Revision retired.",
            "lastTransitionTime": stamp,
        },
        {"type": "ResourcesAvailable", "status": "Unknown", "reason": "Retired", "lastTransitionTime": stamp},
        {"type": "TrafficShutDown", "status": "True", "lastTransitionTime": stamp},
    ]


class FakeCloudRun:
    """One Cloud Run service, answered through the gcloud argv the script sends."""

    def __init__(self, project: str, *, now: int, template_timeout: int = TIMEOUT):
        self.project = project
        self.now = now
        self._serial = 0
        self.service = {
            "metadata": {"name": SERVICE, "uid": self._token("service-uid"), "generation": 1},
            "spec": {"template": {"spec": {"timeoutSeconds": template_timeout}}, "traffic": []},
            "status": {
                "observedGeneration": 1,
                "conditions": [{"type": "Ready", "status": "True"}],
                "traffic": [],
            },
        }
        self.revisions: dict[str, dict] = {}
        # Ground truth: when each revision last stopped being routable; None while routable.
        self.routable_until: dict[str, int | None] = {}
        self.deleted: list[str] = []
        self.untagged: list[str] = []
        # Cloud Run rewrites an untagged revision seconds later (02169-siy: 9 s),
        # so a pass can read it back unchanged.
        self.untag_rewrites_revisions = True
        self.failing_deletes: set[str] = set()  # the provider's outcome is unknown
        self.budget_ends_after_deletes: int | None = None
        self.after_delete = None  # a change that lands while the pass deletes
        self.during_revision_list = None  # a change that lands while the pass lists revisions (once)

    def _token(self, prefix: str) -> str:
        self._serial += 1
        return f"{prefix}-{self._serial:06d}"

    # World setup and out-of-band changes.

    def add_revision(
        self,
        name: str,
        *,
        created: int,
        unrouted_since: int | None = None,
        timeout: int = TIMEOUT,
        active: bool | None = None,
        uid: bool = True,
        resource_version: bool = True,
    ) -> None:
        """Add a revision; unrouted_since=None means it is about to be routed."""
        metadata = {
            "name": name,
            "creationTimestamp": iso(created),
            "labels": {"serving.knative.dev/service": SERVICE},
        }
        if uid:
            metadata["uid"] = self._token("revision-uid")
        if resource_version:
            metadata["resourceVersion"] = self._token("rv")
        if active is None:
            active = unrouted_since is None
        self.revisions[name] = {
            "metadata": metadata,
            "spec": {
                "timeoutSeconds": timeout,
                "containerConcurrency": 20,
                "containers": [{"image": f"registry.example/{SERVICE}@sha256:{'0' * 64}"}],
            },
            "status": {
                "conditions": conditions(
                    active=active, at=created if unrouted_since is None else unrouted_since
                )
            },
        }
        self.routable_until[name] = unrouted_since

    def set_latest(self, name: str) -> None:
        status = self.service["status"]
        status["latestCreatedRevisionName"] = status["latestReadyRevisionName"] = name

    def touch(self, name: str) -> None:
        """Any server-side modification of the revision object (status or labels)."""
        metadata = self.revisions[name]["metadata"]
        if "resourceVersion" in metadata:
            metadata["resourceVersion"] = self._token("rv")

    def replace_uid(self, name: str) -> None:
        """Same name, different object (resourceVersion deliberately unchanged)."""
        self.revisions[name]["metadata"]["uid"] = self._token("revision-uid")

    def recreate_service(self, *, at: int) -> None:
        self.now = at
        self.service["metadata"]["uid"] = self._token("service-uid")
        self.service["metadata"]["generation"] += 1
        self.service["status"]["observedGeneration"] = self.service["metadata"]["generation"]

    def routed(self, name: str) -> bool:
        entries = self.service["spec"]["traffic"] + self.service["status"]["traffic"]
        return any(
            entry.get("revisionName") == name and (entry.get("percent") or entry.get("tag"))
            for entry in entries
        )

    def set_traffic(
        self,
        entries: list[dict],
        *,
        at: int,
        reconcile: bool = True,
        platform_updates_revisions: bool = True,
    ) -> None:
        """Replace desired traffic. reconcile=False leaves status behind (rollout in flight)."""
        self.now = at
        before = {name for name in self.revisions if self.routed(name)}
        self.service["spec"]["traffic"] = copy.deepcopy(entries)
        self.service["metadata"]["generation"] += 1
        if reconcile:
            self.service["status"]["observedGeneration"] = self.service["metadata"]["generation"]
            self.service["status"]["traffic"] = self._resolve()
        after = {name for name in self.revisions if self.routed(name)}
        for name in after - before:
            self.routable_until[name] = None
            if reconcile and platform_updates_revisions:
                self.revisions[name]["status"]["conditions"] = conditions(active=True, at=at)
                self.touch(name)
        for name in before - after:
            self.routable_until[name] = at
            if platform_updates_revisions:
                self.revisions[name]["status"]["conditions"] = conditions(active=False, at=at)
                self.touch(name)

    def deploy_candidate(self, name: str, *, at: int, tag: str) -> None:
        """A deploy creates a zero-traffic tagged candidate, as failed run 38670378213 did."""
        self.add_revision(name, created=at)
        self.set_latest(name)
        self.set_traffic(
            self.service["spec"]["traffic"] + [{"revisionName": name, "tag": tag}], at=at
        )

    def _resolve(self) -> list[dict]:
        """Status traffic as Cloud Run reports it: percent and tag merge per revision."""
        order: list[str] = []
        percent: dict[str, int] = {}
        tags: dict[str, list[str]] = {}
        for entry in self.service["spec"]["traffic"]:
            name = entry["revisionName"]
            if name not in order:
                order.append(name)
            if entry.get("percent"):
                percent[name] = percent.get(name, 0) + entry["percent"]
            if entry.get("tag"):
                tags.setdefault(name, []).append(entry["tag"])
        resolved = []
        for name in order:
            remaining = list(tags.get(name, []))
            if percent.get(name):
                item = {"revisionName": name, "percent": percent[name]}
                if remaining:
                    item["tag"] = remaining.pop(0)
                resolved.append(item)
            resolved.extend({"revisionName": name, "tag": tag} for tag in remaining)
        return resolved

    # The gcloud surface the script uses.

    def run_command(self, args, *, timeout=180, check=True, text=True):
        args = [str(arg) for arg in args]
        if args[:2] != ["gcloud", "run"]:
            raise AssertionError(f"unexpected command: {args}")
        if (
            self.budget_ends_after_deletes is not None
            and len(self.deleted) >= self.budget_ends_after_deletes
        ):
            raise RETENTION.BudgetExpired("Cleanup execution budget exhausted")
        flags = dict(
            arg[2:].split("=", 1) for arg in args[2:] if arg.startswith("--") and "=" in arg
        )
        words = [arg for arg in args[2:] if not arg.startswith("--")]
        if flags.get("project") != self.project:
            raise AssertionError(f"command left the {self.project} lane: {args}")
        if flags.get("region") != REGION:
            raise AssertionError(f"unexpected region: {args}")
        if words == ["services", "describe", SERVICE]:
            output = json.dumps(self.service)
        elif words == ["revisions", "list"] and flags.get("service") == SERVICE:
            change, self.during_revision_list = self.during_revision_list, None
            if change:
                change()
            output = json.dumps(list(self.revisions.values()))
        elif words[:2] == ["revisions", "describe"] and len(words) == 3 and words[2] in self.revisions:
            output = json.dumps(self.revisions[words[2]])
        elif words == ["services", "update-traffic", SERVICE] and "remove-tags" in flags:
            self._remove_tags(flags["remove-tags"].split(","))
            output = ""
        elif words[:2] == ["revisions", "delete"] and len(words) == 3:
            if words[2] in self.failing_deletes:
                raise subprocess.CalledProcessError(1, args)
            self._delete(words[2])
            if self.after_delete:
                self.after_delete()
            output = ""
        else:
            raise AssertionError(f"the fake control plane does not model: {args}")
        return subprocess.CompletedProcess(args, 0, output if text else output.encode(), "")

    def _remove_tags(self, tags: list[str]) -> None:
        spec = self.service["spec"]["traffic"]
        for tag in tags:
            matches = [entry for entry in spec if entry.get("tag") == tag]
            if not matches:
                raise AssertionError(f"removed unknown tag {tag}")
            if any(entry.get("percent") for entry in matches):
                raise AssertionError(f"UNSAFE: removed tag {tag}, which carries traffic")
        self.untagged.extend(tags)
        self.set_traffic(
            [entry for entry in spec if entry.get("tag") not in tags],
            at=self.now,
            platform_updates_revisions=self.untag_rewrites_revisions,
        )

    def _delete(self, name: str) -> None:
        if name not in self.revisions:
            raise AssertionError(f"deleted unknown revision {name}")
        if self.routed(name):
            raise AssertionError(f"UNSAFE: deleted {name} while spec or status traffic references it")
        status = self.service["status"]
        if name in (status.get("latestCreatedRevisionName"), status.get("latestReadyRevisionName")):
            raise AssertionError(f"UNSAFE: deleted the latest revision {name}")
        last = self.routable_until[name]
        needed = self.revisions[name]["spec"]["timeoutSeconds"] + 60
        if last is None or self.now - last < needed:
            waited = "while routable" if last is None else f"{self.now - last}s after it was last routable"
            raise AssertionError(f"UNSAFE: deleted {name} {waited}; its requests need {needed}s")
        del self.revisions[name]
        self.deleted.append(name)


T = 1_792_000_000
O1, O2, RBK, SRV, CAN, NEW = (
    f"{SERVICE}-{number:05d}-{suffix}"
    for number, suffix in ((1, "aaa"), (2, "bbb"), (3, "ccc"), (4, "ddd"), (5, "eee"), (6, "fff"))
)
RELEASE_1 = {"current": SRV, "rollback": RBK, "run_id": 1001}


def standard_world(
    project: str = UAT,
    *,
    template_timeout: int = TIMEOUT,
    uid: bool = True,
    resource_version: bool = True,
    old_active: bool | None = None,
) -> FakeCloudRun:
    """SRV serves 100%; RBK is the rollback anchor; O1 and O2 are old and unrouted."""
    world = FakeCloudRun(project, now=T - 6000, template_timeout=template_timeout)
    for name, created, unrouted in ((O1, T - 20000, T - 10000), (O2, T - 15000, T - 9000)):
        world.add_revision(
            name,
            created=created,
            unrouted_since=unrouted,
            uid=uid,
            resource_version=resource_version,
            active=old_active,
        )
    world.add_revision(RBK, created=T - 9000, unrouted_since=T - 5000)
    world.add_revision(SRV, created=T - 6000)
    world.set_latest(SRV)
    world.set_traffic([{"revisionName": SRV, "percent": 100}], at=T - 5000)
    return world


ZIV, QIG, SIY = (
    "consent-protocol-02166-ziv",
    "consent-protocol-02163-qig",
    "consent-protocol-02169-siy",
)
OLD_FIVE = (
    "consent-protocol-02148-tow",
    "consent-protocol-02151-veq",
    "consent-protocol-02154-tof",
    "consent-protocol-02157-cov",
    "consent-protocol-02160-pux",
)
INCIDENT_T0 = epoch("2026-10-15T02:51:34Z")  # first pass after healthy release 38670020301
INCIDENT_CANDIDATE_AT = epoch("2026-10-15T03:03:39Z")  # failed run 38670378213 creates 02169-siy
INCIDENT_SECOND_PASS = epoch("2026-10-15T03:14:48Z")  # pass 38675132502 removes its tag
INCIDENT_RELEASE = {"current": ZIV, "rollback": QIG, "run_id": 38670020301}


def incident_world() -> FakeCloudRun:
    """UAT consent-protocol at 02:51Z on 2026-10-15, with real revision names and times.

    Creation times and last-routed times come from each revision's own conditions.
    """
    world = FakeCloudRun(UAT, now=INCIDENT_T0)
    for name, created, unrouted in (
        (OLD_FIVE[0], "2026-10-14T18:39:27Z", "2026-10-14T19:59:30Z"),
        (OLD_FIVE[1], "2026-10-14T19:46:18Z", "2026-10-14T22:33:17Z"),
        (OLD_FIVE[2], "2026-10-14T22:16:35Z", "2026-10-14T23:05:44Z"),
        (OLD_FIVE[3], "2026-10-14T22:48:12Z", "2026-10-15T00:58:09Z"),
        (OLD_FIVE[4], "2026-10-15T00:35:54Z", "2026-10-15T01:25:37Z"),
        (QIG, "2026-10-15T01:12:39Z", "2026-10-15T02:49:12Z"),
    ):
        world.add_revision(name, created=epoch(created), unrouted_since=epoch(unrouted))
    world.add_revision(ZIV, created=epoch("2026-10-15T02:31:10Z"))
    world.set_latest(ZIV)
    world.set_traffic(
        [
            {"revisionName": ZIV, "percent": 100},
            {"revisionName": ZIV, "tag": "account-deletion-38670020301"},
        ],
        at=epoch("2026-10-15T02:37:13Z"),
    )
    return world


class DrainCase(unittest.TestCase):
    keep = 2  # BACKEND_REVISION_RETENTION / LANES["uat"]["services"]["consent-protocol"]

    def setUp(self) -> None:
        self.reset_state()

    def reset_state(self) -> None:
        directory = pathlib.Path(tempfile.mkdtemp(prefix="drain-contract-"))
        self.addCleanup(shutil.rmtree, directory, True)
        self.directory = directory
        self.state = directory / f"{SERVICE}.json"

    def run_pass(
        self,
        world: FakeCloudRun,
        now: int,
        *,
        current: str,
        rollback: str,
        run_id: int,
        last_known_good: str | None = None,
        uat: bool = True,
        stops_with: type[Exception] | None = None,
    ) -> list[str]:
        """One scheduled maintenance pass for consent-protocol; returns what it deleted.

        stops_with names the error that must stop the pass.
        """
        world.now = now
        known_good = last_known_good or rollback
        argv = [
            "cloudrun-retention.py",
            SERVICE,
            REGION,
            str(self.keep),
            current,
            "--rollback-revision",
            rollback,
            "--last-known-good-revision",
            known_good,
            "--apply",
            "--healthy",
            "--defer-state",
            str(self.state),
            "--release-run-id",
            str(run_id),
        ]
        if uat:
            argv.append("--carry-uat-clock")
        argv += ["--project", world.project]
        start = len(world.deleted)
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(RETENTION, "run_command", world.run_command))
            stack.enter_context(mock.patch.object(RETENTION.time, "time", return_value=now))
            stack.enter_context(
                mock.patch.object(
                    RETENTION.time,
                    "sleep",
                    side_effect=AssertionError("no-sleeper policy (#7951): a deferred pass must never sleep"),
                )
            )
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            stack.enter_context(contextlib.redirect_stdout(output))
            if stops_with is not None:
                with self.assertRaises(stops_with):
                    RETENTION.main()
                return world.deleted[start:]
            try:
                result = RETENTION.main()
            except RETENTION.UnsafeState as exc:
                self.fail(f"pass at {iso(now)} stopped: {exc}\n{output.getvalue()}")
        self.assertEqual(result, 0, output.getvalue())
        self.assert_drain_state_contract(world, now, run_id, {current, rollback, known_good})
        return world.deleted[start:]

    def assert_drain_state_contract(
        self, world: FakeCloudRun, now: int, run_id: int, explicit: set[str]
    ) -> None:
        """What uat-retention-maintenance.py requires of a state file after a pass, plus coverage."""
        plan = RETENTION.plan_cleanup(
            copy.deepcopy(world.service),
            copy.deepcopy(list(world.revisions.values())),
            self.keep,
            set(explicit),
        )
        pending = set(plan.delete_revisions)
        if not self.state.exists():
            self.assertFalse(
                pending,
                f"{sorted(pending)} still wait for deletion, but no drain state remains to wake maintenance",
            )
            return
        state = json.loads(self.state.read_text())
        self.assertIsInstance(state, dict)
        for key, value in (
            ("schema_version", 1),
            ("service", SERVICE),
            ("project", world.project),
            ("region", REGION),
            ("release_run_id", str(run_id)),
        ):
            self.assertEqual(state.get(key), value, f"drain state {key}")
        self.assertIs(type(state.get("not_before")), int)
        self.assertGreater(
            state["not_before"],
            now,
            "a drain state that remains after a pass must be due later (maintenance rejects a past due time)",
        )
        listed = state.get("revisions")
        self.assertIsInstance(listed, list)
        self.assertTrue(listed, "a remaining drain state must list its revisions")
        self.assertNotIn("pending_mutation", state)
        self.assertLessEqual(set(listed), set(world.revisions), "drain state lists a deleted or unknown revision")
        self.assertLessEqual(pending, set(listed), "a revision waiting for deletion is missing from the drain state")

    def promote_new_release(self, world: FakeCloudRun, *, platform_updates_revisions: bool = True) -> dict:
        """Release 2002 creates NEW at T+500 and moves 100% to it at T+600; SRV is unrouted."""
        world.deploy_candidate(NEW, at=T + 500, tag="rel-2002")
        world.set_traffic(
            [{"revisionName": NEW, "percent": 100}, {"revisionName": NEW, "tag": "rel-2002"}],
            at=T + 600,
            platform_updates_revisions=platform_updates_revisions,
        )
        return {"current": NEW, "rollback": RBK, "run_id": 2002}


class RequiredLiveness(DrainCase):
    """The per-revision drain. Before it, these replayed the 2026-10-15 deadlock."""

    def test_incident_replay_failed_candidate_and_tag_removal_keep_old_clocks(self) -> None:
        world = incident_world()
        self.assertEqual(self.run_pass(world, INCIDENT_T0, **INCIDENT_RELEASE), [])
        world.deploy_candidate(SIY, at=INCIDENT_CANDIDATE_AT, tag="account-deletion-38670378213")
        self.assertEqual(self.run_pass(world, INCIDENT_SECOND_PASS, **INCIDENT_RELEASE), [])
        self.assertIn("account-deletion-38670378213", world.untagged)
        deleted = self.run_pass(world, INCIDENT_T0 + DRAIN + 1, **INCIDENT_RELEASE)
        self.assertEqual(
            sorted(deleted),
            sorted(OLD_FIVE),
            "the five revisions unrouted since before 02:51:34Z had drained by 03:52:34Z; "
            "a failed candidate and the removal of its tag must not restart their clocks",
        )
        self.assertEqual(set(world.revisions), {QIG, ZIV, SIY})

    def test_incident_replay_wakes_maintenance_when_old_clocks_are_due(self) -> None:
        world = incident_world()
        self.run_pass(world, INCIDENT_T0, **INCIDENT_RELEASE)
        world.deploy_candidate(SIY, at=INCIDENT_CANDIDATE_AT, tag="account-deletion-38670378213")
        self.run_pass(world, INCIDENT_SECOND_PASS, **INCIDENT_RELEASE)
        (self.directory / "completed.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "checkpoint_version": 2,
                    "environment": "uat",
                    "project": UAT,
                    "release_run_id": INCIDENT_RELEASE["run_id"],
                    "observed_run_id": 38676130648,
                    "pass_status": "complete",
                    "pending_services": [],
                }
            )
        )
        with (
            mock.patch.object(MAINTENANCE, "latest_deploy_observation", return_value=38676130648),
            mock.patch.object(MAINTENANCE.time, "time", return_value=INCIDENT_T0 + DRAIN + 1),
        ):
            due = MAINTENANCE.maintenance_due(
                "hushh-labs/hushh-research", self.directory, environment="uat", restore=False
            )
        self.assertTrue(
            due,
            "the hourly clock must find UAT due once the old revisions' own drain has passed "
            "(03:52:34Z), not only after the restarted clock (04:15:48Z)",
        )

    def test_new_release_between_passes_keeps_unchanged_old_clocks(self) -> None:
        world = standard_world()
        self.assertEqual(self.run_pass(world, T, **RELEASE_1), [])
        world.deploy_candidate(NEW, at=T + 1200, tag="rel-2002")
        world.set_traffic(
            [{"revisionName": NEW, "percent": 100}, {"revisionName": NEW, "tag": "rel-2002"}],
            at=T + 1800,
        )
        deleted = self.run_pass(world, T + DRAIN + 1, current=NEW, rollback=SRV, run_id=2002)
        self.assertLessEqual(
            {O1, O2},
            set(deleted),
            "O1 and O2 stayed unrouted and unchanged from T; a release that did not touch them "
            "must not restart their clocks",
        )
        self.assertLessEqual({NEW, SRV}, set(world.revisions))

    def test_tag_removed_by_a_pass_starts_a_clock_that_survives_a_later_release(self) -> None:
        # The pass records O1 as Cloud Run left it after removing its tag, so the
        # next pass can prove O1 unchanged across another revision's deploy.
        world = standard_world()
        world.set_traffic(
            world.service["spec"]["traffic"] + [{"revisionName": O1, "tag": "probe-o1"}],
            at=T - 100,
        )
        self.assertEqual(self.run_pass(world, T, **RELEASE_1), [])
        self.assertIn("probe-o1", world.untagged)
        world.deploy_candidate(CAN, at=T + 300, tag="deploy-2002")
        self.assertIn(
            O1,
            self.run_pass(world, T + DRAIN + 1, **RELEASE_1),
            "O1 stayed unrouted and unchanged since the pass that removed its tag",
        )


class RequiredSafety(DrainCase):
    """Fail-closed properties. They held before per-revision clocks and must keep holding."""

    def test_quiet_service_deletes_only_after_full_drain(self) -> None:
        world = standard_world()
        self.assertEqual(self.run_pass(world, T, **RELEASE_1), [])
        self.assertEqual(self.run_pass(world, T + DRAIN - 1, **RELEASE_1), [])
        self.assertEqual(sorted(self.run_pass(world, T + DRAIN + 1, **RELEASE_1)), sorted([O1, O2]))
        self.assertEqual(set(world.revisions), {RBK, SRV})

    def test_changed_revision_object_restarts_that_revisions_clock(self) -> None:
        for change in ("resource_version", "uid"):
            with self.subTest(change=change):
                self.reset_state()
                world = standard_world()
                self.run_pass(world, T, **RELEASE_1)
                world.deploy_candidate(CAN, at=T + 300, tag="deploy-2002")
                if change == "resource_version":
                    world.touch(O1)  # O1 changed: no proof it stayed unrouted
                else:
                    world.replace_uid(O1)  # a different object under the same name
                self.assertNotIn(O1, self.run_pass(world, T + DRAIN + 1, **RELEASE_1))
                self.run_pass(world, T + 2 * DRAIN + 2, **RELEASE_1)
                self.assertIn(O1, world.deleted, "O1 must still go after a full drain of its own")

    def test_recreated_service_restarts_every_clock(self) -> None:
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        world.recreate_service(at=T + 300)
        self.assertEqual(self.run_pass(world, T + DRAIN + 1, **RELEASE_1), [])

    def test_desired_route_not_yet_in_status_blocks_deletion(self) -> None:
        for route in ({"revisionName": O1, "percent": 100}, {"revisionName": O1, "tag": "probe-o1"}):
            with self.subTest(route=route):
                self.reset_state()
                world = standard_world()
                self.run_pass(world, T, **RELEASE_1)
                base = [{"revisionName": SRV, "percent": 100}] if "tag" in route else []
                # Rollout in flight: spec routes to O1, status and O1 itself not yet updated.
                world.set_traffic(base + [route], at=T + 300, reconcile=False)
                self.assertNotIn(O1, self.run_pass(world, T + DRAIN + 1, **RELEASE_1))

    def test_revision_routed_at_an_earlier_pass_waits_a_full_drain_after_unrouting(self) -> None:
        for platform_updates in (True, False):
            with self.subTest(platform_updates_revisions=platform_updates):
                self.reset_state()
                world = standard_world()
                self.run_pass(world, T, **RELEASE_1)  # SRV serves here
                release_2 = self.promote_new_release(world, platform_updates_revisions=platform_updates)
                self.run_pass(world, T + 600, **release_2)  # SRV is now a deletion candidate
                self.assertNotIn(
                    SRV,
                    self.run_pass(world, T + DRAIN + 1, **release_2),
                    "SRV served until T+600; it needs a full drain from then",
                )
                self.run_pass(world, T + 600 + DRAIN + 1, **release_2)
                if platform_updates:
                    self.assertIn(SRV, world.deleted)

    def test_missing_revision_identity_is_not_continuity_evidence(self) -> None:
        for missing in ("uid", "resource_version"):
            with self.subTest(missing=missing):
                self.reset_state()
                world = standard_world(**{missing: False})
                self.run_pass(world, T, **RELEASE_1)
                world.deploy_candidate(CAN, at=T + 300, tag="deploy-2002")
                self.assertEqual(self.run_pass(world, T + DRAIN + 1, **RELEASE_1), [])

    def test_production_lane_still_restarts_on_any_generation_change(self) -> None:
        world = standard_world(PRODUCTION)
        self.assertEqual(self.run_pass(world, T, uat=False, **RELEASE_1), [])
        world.deploy_candidate(CAN, at=T + 300, tag="deploy-2002")
        self.assertEqual(self.run_pass(world, T + DRAIN + 1, uat=False, **RELEASE_1), [])
        self.assertEqual(
            sorted(self.run_pass(world, T + 2 * DRAIN + 2, uat=False, **RELEASE_1)), sorted([O1, O2])
        )

    def test_drain_follows_each_revisions_own_request_timeout(self) -> None:
        world = standard_world(template_timeout=300)
        self.run_pass(world, T, **RELEASE_1)
        self.assertEqual(self.run_pass(world, T + DRAIN - 1, **RELEASE_1), [])

    def test_carried_clock_is_never_shortened(self) -> None:
        # The old revisions were unrouted for hours, but the passes prove only
        # 02:51:34Z onwards; their drain ends one second after this pass.
        world = incident_world()
        self.run_pass(world, INCIDENT_T0, **INCIDENT_RELEASE)
        world.deploy_candidate(SIY, at=INCIDENT_CANDIDATE_AT, tag="account-deletion-38670378213")
        self.run_pass(world, INCIDENT_SECOND_PASS, **INCIDENT_RELEASE)
        self.assertEqual(self.run_pass(world, INCIDENT_T0 + DRAIN - 1, **INCIDENT_RELEASE), [])

    def test_unretired_revision_restarts_its_clock_on_a_generation_change(self) -> None:
        # Across a generation change only a retired, unchanged revision object
        # proves that no route reached it. A quiet service still deletes it (Advisory).
        world = standard_world(old_active=True)
        self.run_pass(world, T, **RELEASE_1)
        world.deploy_candidate(CAN, at=T + 300, tag="deploy-2002")
        self.assertEqual(self.run_pass(world, T + DRAIN + 1, **RELEASE_1), [])
        self.assertEqual(
            sorted(self.run_pass(world, T + 2 * DRAIN + 2, **RELEASE_1)), sorted([O1, O2])
        )

    def test_revision_tagged_just_before_a_pass_waits_a_full_drain_from_its_untag(self) -> None:
        # Cloud Run has rewritten O1 neither for the tag nor for this pass's removal
        # of it, so only the traffic the pass read shows that O1 was routable.
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        world.untag_rewrites_revisions = False
        world.set_traffic(
            world.service["spec"]["traffic"] + [{"revisionName": O1, "tag": "probe-o1"}],
            at=T + DRAIN,
            platform_updates_revisions=False,
        )
        self.assertNotIn(O1, self.run_pass(world, T + DRAIN + 1, **RELEASE_1))
        self.assertIn(O1, self.run_pass(world, T + 2 * DRAIN + 2, **RELEASE_1))

    def test_route_added_while_a_pass_deletes_stops_its_remaining_deletes(self) -> None:
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        world.after_delete = lambda: world.set_traffic(
            world.service["spec"]["traffic"] + [{"revisionName": O1, "tag": "probe-o1"}],
            at=world.now,
        )
        deleted = self.run_pass(world, T + DRAIN + 1, stops_with=RETENTION.UnsafeState, **RELEASE_1)
        self.assertEqual(deleted, [O2])
        self.assertIn(O1, world.revisions)

    def test_carry_flag_is_refused_outside_deferred_uat_cleanup(self) -> None:
        # --carry-uat-clock selects the per-revision drain. Inside the helper only the
        # parser keeps that path out of production and out of cleanup without a receipt.
        for project, deferred in ((PRODUCTION, True), (PRODUCTION, False), (UAT, False)):
            with self.subTest(project=project, deferred=deferred):
                argv = [
                    "cloudrun-retention.py", SERVICE, REGION, str(self.keep), SRV,
                    "--rollback-revision", RBK, "--apply", "--healthy",
                    "--release-run-id", str(RELEASE_1["run_id"]),
                    "--carry-uat-clock", "--project", project,
                ]
                if deferred:
                    argv += ["--defer-state", str(self.state)]
                errors = io.StringIO()
                with (
                    mock.patch.object(
                        RETENTION,
                        "run_command",
                        side_effect=AssertionError("UNSAFE: a refused invocation reached Cloud Run"),
                    ) as cloud,
                    mock.patch.object(sys, "argv", argv),
                    contextlib.redirect_stderr(errors),
                    self.assertRaises(SystemExit) as refused,
                ):
                    RETENTION.main()
                self.assertEqual(refused.exception.code, 2)
                self.assertIn(
                    "--carry-uat-clock requires deferred cleanup in the UAT project", errors.getvalue()
                )
                cloud.assert_not_called()
                self.assertFalse(self.state.exists())


class RequiredReceipt(DrainCase):
    """What a per-revision receipt promises the next pass and maintenance."""

    def test_receipt_without_revision_clocks_carries_none(self) -> None:
        # A service-wide receipt (the format before per-revision clocks) proves
        # no single revision's history, so the pass that reads it starts afresh.
        world = standard_world()
        self.run_pass(world, T, uat=False, **RELEASE_1)
        self.assertEqual(self.run_pass(world, T + DRAIN + 1, **RELEASE_1), [])
        self.assertEqual(
            sorted(self.run_pass(world, T + 2 * DRAIN + 2, **RELEASE_1)), sorted([O1, O2])
        )

    def test_interrupted_pass_keeps_only_what_it_did_not_delete(self) -> None:
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        due = T + DRAIN + 1
        world.budget_ends_after_deletes = len(world.deleted) + 1
        self.assertEqual(
            self.run_pass(world, due, stops_with=RETENTION.BudgetExpired, **RELEASE_1), [O2]
        )
        world.budget_ends_after_deletes = None
        state = json.loads(self.state.read_text())
        self.assertEqual(state["revisions"], [O1])
        self.assertNotIn(O2, state["clocks"])
        self.assertNotIn("pending_mutation", state)
        # The provider fails O1's delete with an unknown outcome.
        world.failing_deletes = {O1}
        self.run_pass(world, due + 60, stops_with=RETENTION.MutationUncertain, **RELEASE_1)
        self.assertEqual(json.loads(self.state.read_text())["pending_mutation"]["revision"], O1)
        # No pass mutates anything until one observes O1's fate.
        self.run_pass(world, due + 120, stops_with=RETENTION.MutationUncertain, **RELEASE_1)
        self.assertEqual(world.deleted, [O2])
        world.failing_deletes = set()
        world._delete(O1)  # The provider finished it after all.
        self.assertEqual(self.run_pass(world, due + 180, **RELEASE_1), [])
        self.assertFalse(self.state.exists())

    def test_traffic_moving_while_a_pass_lists_revisions_leaves_the_receipt_untouched(self) -> None:
        # A pass reads the service, then lists revisions. A route that comes and goes in
        # between moves the generation and rewrites O1, yet neither read shows the route.
        # Recording O1's new resourceVersion beside the fingerprint read before it would
        # let the next generation change carry O1's clock across that route.
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        receipt = self.state.read_text()

        def probe_o1() -> None:
            base = copy.deepcopy(world.service["spec"]["traffic"])
            world.set_traffic(base + [{"revisionName": O1, "tag": "probe-o1"}], at=world.now)
            world.set_traffic(base, at=world.now)

        world.during_revision_list = probe_o1
        self.run_pass(world, T + 1000, stops_with=RETENTION.UnsafeState, **RELEASE_1)
        self.assertEqual(self.state.read_text(), receipt, "the stopped pass must leave the earlier receipt as it was")
        self.assertEqual(
            self.run_pass(world, T + DRAIN + 1, **RELEASE_1),
            [O2],
            "O1 was routable at T+1000 and needs a full drain from then; O2 is unchanged since T",
        )

    def test_due_revisions_are_deleted_while_newer_ones_drain(self) -> None:
        # Failed before per-revision clocks: one newly deletable revision held back every older one.
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        release_2 = self.promote_new_release(world)
        self.run_pass(world, T + 600, **release_2)
        self.assertEqual(
            json.loads(self.state.read_text())["not_before"],
            T + DRAIN,
            "maintenance wakes at not_before: O1 and O2 fall due at T+3660, and SRV, "
            "unrouted only since T+600, must not hold them back",
        )
        # Maintenance rejects a remaining receipt due at or before its helper's check,
        # so the pass at that very second must delete what fell due then.
        self.assertEqual(sorted(self.run_pass(world, T + DRAIN, **release_2)), sorted([O1, O2]))
        self.assertIn(SRV, world.revisions)


class Advisory(DrainCase):
    """Liveness worth keeping; a failure here is not a safety violation."""

    def test_quiet_service_keeps_clock_when_only_a_revision_status_changes(self) -> None:
        # Held before per-revision clocks too: an unchanged generation proves no route changed.
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        world.touch(O1)  # for example Reserve -> Retired, with no service change
        self.assertIn(O1, self.run_pass(world, T + DRAIN + 1, **RELEASE_1))

    def test_unrouted_revision_that_never_retires_is_still_deleted_in_a_quiet_service(self) -> None:
        # Held before per-revision clocks too: an Active=True guard on every delete leaks capacity.
        world = standard_world(old_active=True)
        self.run_pass(world, T, **RELEASE_1)
        self.assertEqual(sorted(self.run_pass(world, T + DRAIN + 1, **RELEASE_1)), sorted([O1, O2]))

    def test_frontend_only_release_keeps_the_unchanged_backend_clocks(self) -> None:
        # A frontend-only release has its own run ID but leaves the backend untouched.
        world = standard_world()
        self.run_pass(world, T, **RELEASE_1)
        deleted = self.run_pass(world, T + DRAIN + 1, current=SRV, rollback=RBK, run_id=1002)
        self.assertEqual(sorted(deleted), sorted([O1, O2]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
