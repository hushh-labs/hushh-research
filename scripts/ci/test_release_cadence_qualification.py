#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""An isolated UAT success cannot become a shared release ordinal."""

from copy import deepcopy
import unittest
import test_release_cadence as fixtures

core, run = fixtures.core, fixtures.run


class NonReleaseQualificationTest(unittest.TestCase):
    # Reuse the existing inert GitHub/ledger port without inheriting its tests.
    invoke = fixtures.ReconciliationTest.invoke

    def test_successful_noop_does_not_poison_the_counter(self):
        jobs = {
            "total_count": 2,
            "jobs": [
                {
                    "name": "Select UAT target",
                    "steps": [
                        {
                            "name": "Summarize unchanged UAT target",
                            "conclusion": "success",
                        }
                    ],
                },
                {"name": "Deploy UAT Scope", "conclusion": "skipped"},
            ],
        }
        state, _ = self.invoke([run(20)], {20: None}, extra_api=jobs)
        self.assertEqual(state["count"], 0)
        self.assertEqual(state["noops"], [20])
        jobs["jobs"][1]["conclusion"] = "success"
        with self.assertRaisesRegex(core.UnsafeRelease, "NO_OP proof"):
            self.invoke([run(20)], {20: None}, extra_api=jobs)

    def test_isolated_uat_does_not_advance_shared_release_cadence(self):
        source = run(21)
        source["triggering_actor"] = {"login": "maintainer"}
        rows = [
            {
                "name": name,
                "status": "completed",
                "conclusion": result,
                "run_id": source["id"],
                "head_sha": source["head_sha"],
            }
            for name, result in (
                ("Select UAT target", "skipped"),
                ("Wait for UAT capacity outside the mutation lock", "skipped"),
                ("Deploy UAT Scope", "skipped"),
                ("PLG Isolated Uat Acceptance Gate", "success"),
            )
        ]
        jobs = {"total_count": len(rows), "jobs": rows}
        state, _ = self.invoke([source], {21: None}, extra_api=jobs)
        self.assertEqual(
            (state["count"], state["sources"], state["requests"], state["noops"]),
            (0, {}, {}, [21]),
        )
        for invalid in (
            "incomplete",
            "duplicate",
            "shared-deploy",
            "gate-skipped",
            "ungoverned",
            "wrong-sha",
        ):
            with self.subTest(invalid=invalid):
                bad_jobs, bad_source = deepcopy(jobs), deepcopy(source)
                if invalid == "incomplete":
                    bad_jobs["total_count"] += 1
                elif invalid == "duplicate":
                    bad_jobs["jobs"].append(deepcopy(rows[3]))
                    bad_jobs["total_count"] += 1
                elif invalid == "shared-deploy":
                    bad_jobs["jobs"][2]["conclusion"] = "success"
                elif invalid == "gate-skipped":
                    bad_jobs["jobs"][3]["conclusion"] = "skipped"
                elif invalid == "ungoverned":
                    bad_source["triggering_actor"] = {"login": "other"}
                else:
                    bad_jobs["jobs"][3]["head_sha"] = "b" * 40
                with self.assertRaises(core.UnsafeRelease):
                    self.invoke([bad_source], {21: None}, extra_api=bad_jobs)


if __name__ == "__main__":
    unittest.main()
