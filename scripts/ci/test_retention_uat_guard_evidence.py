#!/usr/bin/env python3
"""UAT guard-only proof: an exact pre-mutation refusal qualifies; nothing else does."""

import copy
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import retention_preflight_evidence as base  # noqa: E402
import retention_uat_guard_evidence as evidence  # noqa: E402

SHA = "c" * 40
STYLE_ON, STYLE_OFF = "\x1b[36;1m", "\x1b[0m"
# Layout of failed attempt 41105484094/1: numbered steps 1-9, then post steps 17-19.
NUMBERS = (*range(1, 10), 17, 18, 19)
WINDOWS = (
    ("18:17:34", "18:17:36"), ("18:17:36", "18:18:04"), ("18:18:04", "18:18:04"),
    ("18:18:04", "18:18:41"), ("18:18:41", "18:18:41"), ("18:18:41", "18:18:47"),
    ("18:18:47", "18:19:07"), ("18:19:07", "18:19:07"), ("18:19:07", "18:19:07"),
    ("18:19:07", "18:19:07"), ("18:19:07", "18:19:08"), ("18:19:08", "18:19:08"),
)
GUARD = "Hosted maintenance stopped: maintenance cleanup invocation is missing"
PROOF = {"attempt": 1, "checkout_sha": "a" * 40, "job_id": 7, "qualification": "no_provider_mutation", "run_id": 9}


def at(clock):
    return f"2026-10-30T{clock}Z"


def record(**change):
    return evidence.PROOF_PREFIX + json.dumps({**PROOF, **change}, sort_keys=True)


def fixture(*, diagnostic=GUARD, after_guard=(), before_guard=(), command=evidence.PREPARE_COMMAND):
    steps = []
    for number, name, (start, end) in zip(NUMBERS, base._STEP_NAMES, WINDOWS, strict=True):
        conclusion = "failure" if name == base._PREPARE else "skipped" if name == base._SAVE else "success"
        steps.append({"name": name, "number": number, "status": "completed", "conclusion": conclusion,
                      "started_at": at(start), "completed_at": at(end)})
    run = {"id": 100, "run_attempt": 1, "path": base.WORKFLOW, "head_sha": SHA, "head_branch": "main",
           "event": "repository_dispatch", "status": "completed", "conclusion": "failure",
           "repository": {"full_name": base.REPOSITORY}, "head_repository": {"full_name": base.REPOSITORY}}
    job = {"id": 200, "run_id": 100, "run_attempt": 1, "head_sha": SHA, "head_branch": "main",
           "name": base._JOB, "status": "completed", "conclusion": "failure",
           "started_at": at("18:17:34"), "completed_at": at("18:19:10"), "steps": steps}
    lines = [
        f"﻿{at('18:17:34.7')} Current runner version: '2.338.2'",
        f"{at('18:18:04.3')} {base._CHECKOUT_COMMAND}",
        f"{at('18:18:04.4')} {SHA}",
        f"{at('18:18:47.6')} {command[0]}",
        *(f"{at('18:18:47.6')} {STYLE_ON}{line}{STYLE_OFF}" for line in command[1:]),
        f"{at('18:18:47.6')} shell: /usr/bin/bash -e {{0}}",
        f"{at('18:18:47.6')} env:",
        f"{at('18:18:47.6')}   PRIVATE_CANARY: PRIVATE_SYNTHETIC_SENTINEL",
        f"{at('18:18:47.6')}   APPLY: true",
        f"{at('18:18:47.6')} ##[endgroup]",
        *(f"{at('18:19:07.84')} {line}" for line in before_guard),
        f"{at('18:19:07.85')} {diagnostic}",
        *(f"{at('18:19:07.86')} {line}" for line in after_guard),
        f"{at('18:19:07.869')} {base._EXIT}",
        f"{at('18:19:07.877')} {base.REPORT_GROUP}",
        f"{at('18:19:08.23')} Cleaning up orphan processes",
    ]
    return run, job, "\n".join(lines), blobs(evidence.SOURCE_PROFILES[1])


def blobs(profile):
    return {path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()}


def qualify(run, job, log, source, environment="uat", workflow=None):
    return evidence.qualify_guard_run(
        base.REPOSITORY, environment, run, job, log, source, workflow or source[base.WORKFLOW]
    )


class UatGuardEvidenceTest(unittest.TestCase):
    def test_exact_guard_refusal_qualifies_under_each_reviewed_source(self):
        for diagnostic in sorted(evidence.DIAGNOSTICS):
            for profile in evidence.SOURCE_PROFILES:
                with self.subTest(diagnostic=diagnostic, publication=profile[evidence.PUBLICATION]):
                    run, job, log, _ = fixture(diagnostic=diagnostic)
                    proof = qualify(run, job, log, blobs(profile))
                    self.assertEqual(proof, {"run_id": 100, "attempt": 1, "job_id": 200,
                                             "checkout_sha": SHA, "qualification": "no_provider_mutation"})
                    self.assertNotIn("PRIVATE", json.dumps(proof))

    def test_the_walks_own_proof_records_may_surround_the_guard_diagnostic(self):
        records = tuple(record(run_id=number) for number in range(1, 4))
        for change in ({"after_guard": records}, {"before_guard": records[:1], "after_guard": records[1:]}):
            with self.subTest(change=change):
                self.assertIsNotNone(qualify(*fixture(**change)))
        malformed = (
            record(extra=1),
            record(qualification="reconciled"),
            record(checkout_sha="not-a-commit"),
            evidence.PROOF_PREFIX + "{",
            *(record(run_id=number) for number in range(1, evidence.MAX_PROOF_RECORDS + 2)),
        )
        for line in malformed[:4]:
            with self.subTest(line=line):
                self.assertIsNone(qualify(*fixture(after_guard=(line,))))
        self.assertIsNone(qualify(*fixture(after_guard=malformed[4:])))

    def test_other_diagnostics_output_after_the_guard_or_another_command_refuse(self):
        refusals = (
            {"diagnostic": "Hosted maintenance stopped: live release changed during maintenance"},
            {"diagnostic": "Hosted maintenance stopped: GitHub authority lookup exceeded its bounded budget"},
            {"after_guard": ("Deleting revision consent-protocol-00302-fix",)},
            {"after_guard": ("checkpoint_ready=true",)},
            {"after_guard": ("##[error]Revision deletion failed",)},
            {"command": ("##[group]Run set -euo pipefail", *base._PREPARE_COMMAND)},
        )
        for change in refusals:
            with self.subTest(change=change):
                self.assertIsNone(qualify(*fixture(**change)))

    def test_source_environment_attempt_and_steps_are_fail_closed(self):
        run, job, log, source = fixture()
        self.assertIsNone(qualify(run, job, log, {**source, base.OWNER: {"sha": "f" * 40, "size": 1}}))
        self.assertIsNone(qualify(run, job, log, source, workflow={"sha": "f" * 40, "size": 1}))
        self.assertIsNone(qualify(run, job, log, source, environment="production"))
        for key, value in (("event", "pull_request"), ("conclusion", "success"), ("head_branch", "dev")):
            with self.subTest(run=key):
                self.assertIsNone(qualify({**run, key: value}, job, log, source))
        for key, value in (("head_sha", "d" * 40), ("run_attempt", 2), ("name", "Production bounded revision cleanup")):
            with self.subTest(job=key):
                self.assertIsNone(qualify(run, {**job, key: value}, log, source))
        for name, conclusion in ((base._SAVE, "success"), (base._PREPARE, "success")):
            with self.subTest(step=name):
                altered = copy.deepcopy(job)
                altered["steps"][base._STEP_NAMES.index(name)]["conclusion"] = conclusion
                self.assertIsNone(qualify(run, altered, log, source))
        self.assertIsNone(qualify(run, job, log.replace(f" {SHA}\n", " not-a-commit\n"), source))


class PublicationRoutingTest(unittest.TestCase):
    def test_current_uat_failure_is_qualified_at_its_checkout_for_either_clock_tick(self):
        publication = importlib.import_module("retention_publication")
        maintenance = importlib.import_module("uat-retention-maintenance")
        run, job, log, source = fixture()
        reads = []

        def owner_for(served):
            def command(*args):
                path, ref = args[2].split("/contents/", 1)[1].split("?ref=", 1)
                reads.append((path, ref))
                return json.dumps(served[path])

            owner = mock.Mock(retention=maintenance.retention, SCOPED_TICK_TITLES=maintenance.SCOPED_TICK_TITLES)
            owner.api.return_value = run
            owner.command.side_effect = command
            owner.Path = Path
            owner.__file__ = str(Path(__file__).resolve().parent / "uat-retention-maintenance.py")
            return owner

        run.update(actor={"login": "github-actions[bot]"}, triggering_actor={"login": "github-actions[bot]"})
        for title in (maintenance.SCOPED_TICK_TITLES["uat"], publication.UNSCOPED_TICK_TITLE):
            with self.subTest(title=title), mock.patch.object(publication, "_log", return_value=log):
                run["display_title"], reads[:] = title, []
                proof = publication.qualify(owner_for(source), base.REPOSITORY, "uat", run, job)
                self.assertEqual(proof["qualification"], "no_provider_mutation")
                self.assertEqual(reads, [*((path, SHA) for path in evidence.SOURCE_PATHS), (base.WORKFLOW, SHA)])
        unknown = {**source, base.OWNER: {"sha": "f" * 40, "size": 1}}
        refusals = (
            ("uat", maintenance.SCOPED_TICK_TITLES["production"], "repository_dispatch", source, "actor is ungoverned"),
            ("uat", publication.UNSCOPED_TICK_TITLE, "workflow_dispatch", source, "actor is ungoverned"),
            ("production", publication.UNSCOPED_TICK_TITLE, "repository_dispatch", source, "actor is ungoverned"),
            ("uat", publication.UNSCOPED_TICK_TITLE, "repository_dispatch", unknown, "source is unknown"),
        )
        for environment, title, event, served, reason in refusals:
            with self.subTest(environment=environment, title=title, event=event, refused=reason), \
                    mock.patch.object(publication, "_log", return_value=log):
                run.update(display_title=title, event=event)
                with self.assertRaisesRegex(maintenance.retention.UnsafeState, reason):
                    publication.qualify(owner_for(served), base.REPOSITORY, environment, run, job)


if __name__ == "__main__":
    unittest.main()
