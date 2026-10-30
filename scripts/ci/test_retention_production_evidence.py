#!/usr/bin/env python3
"""Production guard-only proof: exact pre-mutation refusal qualifies; nothing else does."""

import copy
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retention_preflight_evidence as base  # noqa: E402
import retention_production_evidence as evidence  # noqa: E402

SHA = "c" * 40
STYLE_ON, STYLE_OFF = "\x1b[36;1m", "\x1b[0m"
# Real job layout: numbered steps 1-13, then post steps 24-27.
NUMBERS = (*range(1, 14), 24, 25, 26, 27)
WINDOWS = (
    ("20:30:26", "20:30:27"), ("20:30:27", "20:30:52"), ("20:30:52", "20:31:04"),
    ("20:31:04", "20:31:04"), ("20:31:04", "20:31:04"), ("20:31:04", "20:31:05"),
    ("20:31:05", "20:31:13"), ("20:31:13", "20:31:13"), ("20:31:13", "20:31:29"),
    ("20:31:29", "20:34:54"), ("20:34:54", "20:35:42"), ("20:35:42", "20:35:42"),
    ("20:35:42", "20:35:42"), ("20:35:42", "20:35:42"), ("20:35:42", "20:35:42"),
    ("20:35:42", "20:35:42"), ("20:35:42", "20:35:42"),
)
GUARD = "Hosted maintenance stopped: Maintenance publication proof is unavailable or invalid"


def at(clock):
    return f"2026-10-29T{clock}Z"


def fixture(*, diagnostic=GUARD, after_guard=(), glob=evidence._GLOB_CONTINUATION):
    steps = []
    for number, name, (start, end), in zip(NUMBERS, evidence.STEP_NAMES, WINDOWS, strict=True):
        conclusion = "failure" if name == evidence.PREPARE else "skipped" if name == evidence.SAVE else "success"
        steps.append({"name": name, "number": number, "status": "completed", "conclusion": conclusion,
                      "started_at": at(start), "completed_at": at(end)})
    run = {"id": 100, "run_attempt": 1, "path": base.WORKFLOW, "head_sha": SHA, "head_branch": "main",
           "event": "workflow_dispatch", "status": "completed", "conclusion": "failure",
           "repository": {"full_name": base.REPOSITORY}, "head_repository": {"full_name": base.REPOSITORY}}
    job = {"id": 200, "run_id": 100, "run_attempt": 1, "head_sha": SHA, "head_branch": "main",
           "name": evidence.JOB, "status": "completed", "conclusion": "failure",
           "started_at": at("20:30:26"), "completed_at": at("20:35:46"), "steps": steps}
    lines = [
        f"﻿{at('20:30:26.1')} Current runner version: '2.338.0'",
        f"{at('20:30:51.0')} {base._CHECKOUT_COMMAND}",
        f"{at('20:30:51.1')} {SHA}",
        f"{at('20:30:53.0')} {evidence._GLOB_HEADER}",
        *glob,
        f"{at('20:30:53.1')}   restore-cache: true",
        f"{at('20:31:29.5')} ##[group]Run set -euo pipefail",
        f"{at('20:31:29.6')} ##[endgroup]",
        f"{at('20:34:54.1')} {evidence.PREPARE_COMMAND[0]}",
        *(f"{at('20:34:54.1')} {STYLE_ON}{line}{STYLE_OFF}" for line in evidence.PREPARE_COMMAND[1:]),
        f"{at('20:34:54.2')} shell: /usr/bin/bash -e {{0}}",
        f"{at('20:34:54.2')} env:",
        f"{at('20:34:54.2')}   PRIVATE_CANARY: PRIVATE_SYNTHETIC_SENTINEL",
        f"{at('20:34:54.2')}   APPLY: true",
        f"{at('20:34:54.2')}   CAPACITY_BRIDGE: false",
        f"{at('20:34:54.2')} ##[endgroup]",
        f"{at('20:35:42.4')} {diagnostic}",
        *(f"{at('20:35:42.41')} {line}" for line in after_guard),
        f"{at('20:35:42.48')} {base._EXIT}",
        f"{at('20:35:42.49')} {base.REPORT_GROUP}",
        f"{at('20:35:42.91')} Cleaning up orphan processes",
        f"{at('20:35:42.94')} {base.RUNNER_WARNING}",
    ]
    profile = evidence.SOURCE_PROFILES[1]
    blobs = {path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()}
    return run, job, "\n".join(lines), blobs


def qualify(run, job, log, blobs, environment="production", workflow=None):
    return evidence.qualify_guard_run(
        base.REPOSITORY, environment, run, job, log, blobs, workflow or blobs[base.WORKFLOW]
    )


class ProductionGuardEvidenceTest(unittest.TestCase):
    def test_exact_guard_refusal_returns_identifiers_without_private_content(self):
        for diagnostic in sorted(evidence.DIAGNOSTICS):
            with self.subTest(diagnostic=diagnostic):
                run, job, log, blobs = fixture(diagnostic=diagnostic)
                proof = qualify(run, job, log, blobs)
                self.assertEqual(proof, {"run_id": 100, "attempt": 1, "job_id": 200,
                                         "checkout_sha": SHA, "qualification": "no_provider_mutation"})
                self.assertNotIn("PRIVATE", json.dumps(proof))
        run, job, log, blobs = fixture()
        earlier = {path: {"sha": sha, "size": size} for path, (sha, size) in evidence.SOURCE_PROFILES[0].items()}
        self.assertIsNotNone(qualify(run, job, log, earlier))

    def test_other_diagnostics_or_output_after_the_guard_refuse(self):
        refusals = (
            {"diagnostic": "Hosted maintenance stopped: live release changed during maintenance"},
            {"diagnostic": "Hosted maintenance stopped: GitHub authority lookup exceeded its bounded budget"},
            {"after_guard": ("Deleting revision consent-protocol-00302-fix",)},
            {"after_guard": ("checkpoint_ready=true",)},
            {"after_guard": ("##[error]Revision deletion failed",)},
        )
        for change in refusals:
            with self.subTest(change=change):
                self.assertIsNone(qualify(*fixture(**change)))

    def test_only_the_exact_setup_block_may_omit_line_stamps(self):
        run, job, log, blobs = fixture()
        self.assertIsNotNone(qualify(run, job, log, blobs))
        for glob in (evidence._GLOB_CONTINUATION[:-1], (*evidence._GLOB_CONTINUATION, "**/extra")):
            with self.subTest(glob=glob):
                self.assertIsNone(qualify(*fixture(glob=glob)))
        moved = log.replace(evidence._GLOB_HEADER, "  enable-cache: auto")
        self.assertIsNone(qualify(run, job, moved, blobs))

    def test_source_environment_attempt_and_steps_are_fail_closed(self):
        run, job, log, blobs = fixture()
        changed_owner = {**blobs, base.OWNER: {"sha": "f" * 40, "size": 1}}
        self.assertIsNone(qualify(run, job, log, changed_owner))
        self.assertIsNone(qualify(run, job, log, blobs, workflow={"sha": "f" * 40, "size": 1}))
        self.assertIsNone(qualify(run, job, log, blobs, environment="uat"))
        for key, value in (("event", "repository_dispatch"), ("conclusion", "success"), ("head_branch", "dev")):
            with self.subTest(run=key):
                self.assertIsNone(qualify({**run, key: value}, job, log, blobs))
        for key, value in (("head_sha", "d" * 40), ("run_attempt", 2), ("name", "UAT bounded revision cleanup")):
            with self.subTest(job=key):
                self.assertIsNone(qualify(run, {**job, key: value}, log, blobs))
        for name, conclusion in ((evidence.SAVE, "success"), (evidence.PREPARE, "success"),
                                 ("Publish operational backend reference under deployment lock", "skipped")):
            with self.subTest(step=name):
                altered = copy.deepcopy(job)
                altered["steps"][evidence.STEP_NAMES.index(name)]["conclusion"] = conclusion
                self.assertIsNone(qualify(run, altered, log, blobs))
        self.assertIsNone(qualify(run, job, log.replace(f" {SHA}\n", " not-a-commit\n"), blobs))


class PublicationRoutingTest(unittest.TestCase):
    def test_production_failure_is_qualified_by_its_own_owner_at_the_actual_checkout(self):
        publication = importlib.import_module("retention_publication")
        run, job, log, blobs = fixture()
        run.update(actor={"login": "ankitkumarsingh1702"}, triggering_actor={"login": "ankitkumarsingh1702"})
        reads = []

        def command(*args):
            path, ref = args[2].split("/contents/", 1)[1].split("?ref=", 1)
            reads.append((path, ref))
            return json.dumps(blobs[path])

        owner = mock.Mock()
        owner.api.return_value = run
        owner.command.side_effect = command
        owner.Path = Path
        owner.__file__ = str(Path(__file__).resolve().parent / "uat-retention-maintenance.py")
        with mock.patch.object(publication, "_log", return_value=log):
            proof = publication.qualify(owner, base.REPOSITORY, "production", run, job)
        self.assertEqual(proof["qualification"], "no_provider_mutation")
        self.assertEqual(reads, [*((path, SHA) for path in evidence.SOURCE_PATHS), (base.WORKFLOW, SHA)])
        self.assertIsNone(publication.qualify(owner, base.REPOSITORY, "dev", run, job))


if __name__ == "__main__":
    unittest.main()
