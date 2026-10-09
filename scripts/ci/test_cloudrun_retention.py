"""Safety contracts for Cloud Run revision cleanup."""

import importlib.util
import contextlib
import io
import pathlib
import sys
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("cloudrun-retention.py")
SPEC = importlib.util.spec_from_file_location("cloudrun_retention", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def service(*traffic):
    return {
        "spec": {"template": {"spec": {"timeoutSeconds": 240}}},
        "status": {"traffic": list(traffic)},
    }


def revision(number):
    return {
        "metadata": {
            "name": f"consent-protocol-{number:05d}-abc",
            "creationTimestamp": f"2026-10-07T00:{number:02d}:00Z",
        },
        "spec": {"timeoutSeconds": 240},
    }


class RetentionSafetyTest(unittest.TestCase):
    def test_preserves_serving_rollback_candidate_and_last_known_good(self):
        old, good, candidate, rollback, serving = (
            revision(n)["metadata"]["name"] for n in range(1, 6)
        )
        state = service(
            {"revisionName": serving, "percent": 100},
            {"revisionName": old, "percent": 0, "tag": "old-tag"},
            {"revisionName": candidate, "percent": 0, "tag": "candidate"},
        )
        plan = MODULE.plan_cleanup(
            state, [revision(n) for n in range(1, 6)], 1, {good, rollback, candidate}
        )
        self.assertEqual(plan.remove_tags, ("candidate", "old-tag"))
        self.assertEqual(plan.delete_revisions, (old,))
        self.assertTrue({serving, rollback, candidate, good}.issubset(plan.protected))

    def test_refuses_ambiguous_traffic_and_missing_protected_revision(self):
        state = service(
            {"revisionName": revision(2)["metadata"]["name"], "percent": 99}
        )
        with self.assertRaises(MODULE.UnsafeState):
            MODULE.plan_cleanup(state, [revision(1), revision(2)], 1, set())
        state["status"]["traffic"][0]["percent"] = 100
        with self.assertRaises(MODULE.UnsafeState):
            MODULE.plan_cleanup(
                state, [revision(1), revision(2)], 1, {revision(3)["metadata"]["name"]}
            )

    def test_rechecks_traffic_before_mutation(self):
        expected = MODULE.traffic_fingerprint(
            service({"revisionName": revision(2)["metadata"]["name"], "percent": 100})
        )
        changed = service(
            {"revisionName": revision(1)["metadata"]["name"], "percent": 100}
        )
        with mock.patch.object(MODULE, "service_state", return_value=changed):
            with self.assertRaisesRegex(MODULE.UnsafeState, "traffic changed"):
                MODULE.assert_traffic(
                    "consent-protocol", "project", "us-central1", expected
                )

    def test_dry_run_displays_live_timeout_floor_and_does_not_mutate(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100},
            {
                "revisionName": revision(1)["metadata"]["name"],
                "percent": 0,
                "tag": "old",
            },
        )
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        output = io.StringIO()
        with (
            mock.patch.object(MODULE, "service_state", return_value=state),
            mock.patch.object(
                MODULE,
                "revision_state",
                return_value=[revision(1), revision(2), revision(3)],
            ),
            mock.patch.object(MODULE, "gcloud") as cloud,
            mock.patch.object(
                sys,
                "argv",
                ["retention", "consent-protocol", "us-central1", "1", "--dry-run"],
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(MODULE.main(), 0)
        self.assertIn("Drain before deletion: 3660s", output.getvalue())
        cloud.assert_not_called()

    def test_missing_request_timeout_fails_closed(self):
        state = service(
            {"revisionName": revision(3)["metadata"]["name"], "percent": 100}
        )
        old = revision(1)
        old["spec"].pop("timeoutSeconds")
        revisions = [old, revision(2), revision(3)]
        plan = MODULE.plan_cleanup(state, revisions, 1, set())
        with self.assertRaisesRegex(MODULE.UnsafeState, "timeout unavailable"):
            MODULE.required_drain_seconds(state, revisions, plan, 120)

    def test_tags_only_retires_tag_without_sleeping_or_deleting(self):
        current = revision(3)["metadata"]["name"]
        state = service(
            {"revisionName": current, "percent": 100},
            {"revisionName": revision(1)["metadata"]["name"], "percent": 0, "tag": "old"},
        )
        untagged = service({"revisionName": current, "percent": 100})
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        with (
            mock.patch.object(MODULE, "service_state", side_effect=[state, state, untagged, untagged]),
            mock.patch.object(MODULE, "revision_state", return_value=[revision(1), revision(2), revision(3)]),
            mock.patch.object(MODULE, "gcloud") as cloud,
            mock.patch.object(MODULE.time, "sleep") as sleep,
            mock.patch.object(sys, "argv", ["retention", "consent-protocol", "us-central1", "1", "--apply", "--healthy", "--tags-only"]),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(MODULE.main(), 0)
        sleep.assert_not_called()
        self.assertEqual(cloud.call_count, 1)
        self.assertEqual(cloud.call_args.args[0], ["services", "update-traffic", "consent-protocol", "--remove-tags=old"])

    def test_full_cleanup_still_waits_for_maximum_request_lifetime(self):
        current = revision(3)["metadata"]["name"]
        state = service({"revisionName": current, "percent": 100})
        state["spec"]["template"]["spec"]["timeoutSeconds"] = 3600
        with (
            mock.patch.object(MODULE, "service_state", return_value=state),
            mock.patch.object(MODULE, "revision_state", return_value=[revision(1), revision(2), revision(3)]),
            mock.patch.object(MODULE, "gcloud") as cloud,
            mock.patch.object(MODULE.time, "sleep") as sleep,
            mock.patch.object(sys, "argv", ["retention", "consent-protocol", "us-central1", "1", "--apply", "--healthy"]),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(MODULE.main(), 0)
        sleep.assert_called_once_with(3660)
        self.assertEqual(cloud.call_args.args[0], ["revisions", "delete", revision(1)["metadata"]["name"]])


if __name__ == "__main__":
    unittest.main()
