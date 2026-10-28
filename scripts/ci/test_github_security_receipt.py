#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Verify immutable security receipts and duplicate-worker precedence."""

import json
import os
import tempfile
import time
import unittest
from contextlib import nullcontext, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import github_security_authority as authority

HEAD = "a" * 40


def receipt_fixture():
    import hashlib
    from io import BytesIO
    from types import SimpleNamespace
    from zipfile import ZipFile

    import github_security_receipt as consumer

    repository = consumer.REPOSITORY
    source = {
        "run_id": 20,
        "attempt": 2,
        "head_sha": HEAD,
        "repository": repository,
        "repository_id": 10,
        "workflow_id": 30,
        "workflow_path": authority.CI_PATH,
        "event": "pull_request",
    }
    repo = {"id": 10, "full_name": repository}
    producer = {
        "id": 40,
        "run_attempt": 1,
        "head_sha": "c" * 40,
        "workflow_id": 50,
        "path": authority.WORKER_PATH,
        "head_branch": "main",
        "event": "workflow_run",
        "status": "completed",
        "conclusion": "success",
        "repository": repo,
        "head_repository": repo,
        "run_started_at": "2026-10-22T15:00:00Z",
        "updated_at": "2026-10-22T15:01:00Z",
    }
    receipt = {
        "schema_version": 1,
        "source": source,
        "producer": {
            "workflow_path": authority.WORKER_PATH,
            "main_sha": producer["head_sha"],
            "run_id": 40,
            "attempt": 1,
        },
        "policy": {"required_secret_clearance": True, "dependabot_blocking": False},
        "verdict": "clear",
        "recorded_at": "2026-10-22T15:00:30.900000+00:00",
        "secret_scanning": {"complete": True, "open": 0, "severity": {}},
        "dependabot": {"complete": True, "open": 142, "severity": {"high": 60}},
    }
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        archive.writestr("ci-security.json", json.dumps(receipt))
    raw = output.getvalue()
    artifact = {
        "id": 70,
        "name": "ci-security-40-1",
        "expired": False,
        "workflow_run": {"id": 40},
        "size_in_bytes": len(raw),
        "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "created_at": "2026-10-22T15:00:30Z",
    }
    workflow = {"id": 50, "path": authority.WORKER_PATH}
    responses = receipt_responses(repository, repo, producer, artifact)
    return (
        consumer,
        SimpleNamespace(read=responses.__getitem__),
        source,
        producer,
        workflow,
        artifact,
        receipt,
        raw,
        responses,
    )


def receipt_responses(repository, repo, producer, artifact):
    prefix = f"repos/{repository}"
    responses = {
        prefix: repo,
        f"{prefix}/actions/workflows/ci.yml": {"id": 30, "path": authority.CI_PATH},
        f"{prefix}/actions/runs/20": {
            "id": 20,
            "run_attempt": 2,
            "head_sha": HEAD,
            "workflow_id": 30,
            "path": authority.CI_PATH,
            "event": "pull_request",
            "status": "in_progress",
            "repository": repo,
        },
        f"{prefix}/compare/{producer['head_sha']}...main": {
            "status": "ahead",
            "merge_base_commit": {"sha": producer["head_sha"]},
        },
        f"{prefix}/actions/runs/40/artifacts?per_page=100": {
            "total_count": 1,
            "artifacts": [artifact],
        },
        f"{prefix}/actions/runs/40": producer.copy(),
    }
    return responses


def _owned_pid_running(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.WaitForSingleObject.restype = wintypes.DWORD
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE only; never terminate.
        if not handle:
            if ctypes.get_last_error() == 87:  # The owned PID no longer exists.
                return False
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            result = api.WaitForSingleObject(handle, 0)
            if result not in (0, 258):
                raise ctypes.WinError(ctypes.get_last_error())
            return result == 258
        finally:
            api.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = Path(f"/proc/{pid}/stat")
    return not (status.exists() and status.read_text().rsplit(")", 1)[1].split()[0] == "Z")


def _writer_command(directory, case, limit):
    import sys

    pids = [Path(directory) / name for name in ("writer.pid", "descendant.pid")]
    descendant = f"import os,time;from pathlib import Path;Path({str(pids[1])!r}).write_text(str(os.getpid()));time.sleep(60)"
    source = f"""import os,subprocess,sys,time
from pathlib import Path
Path({str(pids[0])!r}).write_text(str(os.getpid()))
subprocess.Popen([sys.executable,'-I','-c',{descendant!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
end=time.monotonic()+3
while not Path({str(pids[1])!r}).exists():
    if time.monotonic()>end: raise SystemExit(9)
    time.sleep(.01)
os.write(1, b'x'*{limit + 1} if {case!r}=='size' else b'exact artifact')
if {case!r}=='exit': raise SystemExit(3)
if {case!r}!='success': time.sleep(60)
"""
    return [sys.executable, "-I", "-X", "utf8", "-c", source], pids


class SecurityReceiptTest(unittest.TestCase):
    def test_duplicate_workers_reuse_only_a_verified_exact_attempt_receipt(self):
        consumer, api, source, producer, workflow, _, _, raw, responses = receipt_fixture()
        title = f"Security alerts for {source['run_id']} / {source['attempt']} / {HEAD}"
        duplicate = {**producer, "id": 41, "display_title": title}
        responses[f"repos/{consumer.REPOSITORY}/actions/workflows/ci-security.yml"] = workflow
        responses[
            f"repos/{consumer.REPOSITORY}/actions/workflows/ci-security.yml/runs?branch=main&per_page=100"
        ] = {
            "workflow_runs": [{**producer, "display_title": title}, duplicate],
        }
        responses[f"repos/{consumer.REPOSITORY}/actions/runs/41/artifacts?per_page=100"] = {
            "total_count": 0,
            "artifacts": [],
        }
        steps = [
            {
                "name": "Reuse a verified receipt for this exact source attempt",
                "conclusion": "success",
            },
            {
                "name": "Read alerts and bind the exact source attempt",
                "conclusion": "skipped",
            },
            {"name": "Upload bounded security receipt", "conclusion": "skipped"},
        ]
        responses[f"repos/{consumer.REPOSITORY}/actions/runs/41/jobs?per_page=100"] = {
            "total_count": 1,
            "jobs": [{"run_id": 41, "conclusion": "success", "steps": steps}],
        }
        with patch.object(consumer, "archive_read", return_value=raw):
            self.assertEqual(consumer.find_receipt(api, source)["producer"]["run_id"], 40)
            self.assertIsNone(consumer.find_receipt(api, {**source, "attempt": 3}))
            steps[1]["conclusion"] = "success"
            with self.assertRaisesRegex(consumer.Refused, "not a verified duplicate"):
                consumer.find_receipt(api, source)
            duplicate["conclusion"] = "failure"
            with self.assertRaisesRegex(consumer.Refused, "did not succeed"):
                consumer.find_receipt(api, source)
            self.assertIsNone(consumer.find_receipt(api, source, recover_failed=True))
            # An older run ID can have the newest attempt after a rerun.
            duplicate["conclusion"] = "success"
            steps[1]["conclusion"] = "skipped"
            older_run = responses[
                f"repos/{consumer.REPOSITORY}/actions/workflows/ci-security.yml/runs?branch=main&per_page=100"
            ]["workflow_runs"][0]
            older_run.update(conclusion="failure", run_attempt=2, updated_at="2026-10-22T15:03:00Z")
            with self.assertRaisesRegex(consumer.Refused, "did not succeed"):
                consumer.find_receipt(api, source)

    def test_exact_receipt_accepts_advisory_backlog_and_second_precision(self):
        consumer, api, source, run, workflow, _, _, raw, _ = receipt_fixture()
        with patch.object(consumer, "archive_read", return_value=raw):
            result = consumer.consume(api, source, run, workflow)
        self.assertEqual(result["dependabot"]["open"], 142)
        self.assertEqual(result["secret_scanning"]["open"], 0)

    def test_wrong_source_policy_clearance_or_attempt_window_refuses(self):
        import copy

        consumer, _, source, run, _, artifact, receipt, _, _ = receipt_fixture()
        cases = (
            ("source", {**source, "head_sha": "b" * 40}),
            ("producer", {**receipt["producer"], "attempt": 2}),
            (
                "policy",
                {"required_secret_clearance": False, "dependabot_blocking": False},
            ),
            ("secret_scanning", {"complete": True, "open": 1}),
            ("dependabot", {"complete": False, "open": 0}),
            ("recorded_at", "2026-10-22T14:00:00Z"),
        )
        for field, value in cases:
            candidate = copy.deepcopy(receipt)
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(consumer.Refused):
                consumer.validate(candidate, source, run, artifact)

    def test_producer_origin_artifact_and_current_attempt_are_enforced(self):
        defects = (
            "fork",
            "branch",
            "workflow",
            "event",
            "ancestor",
            "expired",
            "size",
            "digest",
            "rerun",
            "source_rerun",
        )
        for defect in defects:
            consumer, api, source, run, workflow, artifact, _, raw, responses = receipt_fixture()
            if defect == "fork":
                run["head_repository"] = {"id": 99}
            if defect == "branch":
                run["head_branch"] = "feature"
            if defect == "workflow":
                run["workflow_id"] = 99
            if defect == "event":
                run["event"] = "pull_request"
            if defect == "ancestor":
                responses[f"repos/{consumer.REPOSITORY}/compare/{run['head_sha']}...main"][
                    "status"
                ] = "diverged"
            if defect == "expired":
                artifact["expired"] = True
            if defect == "size":
                artifact["size_in_bytes"] += 1
            if defect == "digest":
                artifact["digest"] = "sha256:" + "0" * 64
            if defect == "rerun":
                responses[f"repos/{consumer.REPOSITORY}/actions/runs/40"]["run_attempt"] = 2
            if defect == "source_rerun":
                responses[f"repos/{consumer.REPOSITORY}/actions/runs/20"]["run_attempt"] = 3
            with (
                self.subTest(defect=defect),
                patch.object(consumer, "archive_read", return_value=raw),
                self.assertRaises(consumer.Refused),
            ):
                consumer.consume(api, source, run, workflow)

    def test_archive_tampering_size_and_extra_entries_refuse(self):
        import hashlib
        from io import BytesIO
        from zipfile import ZipFile

        consumer, _, _, _, _, _, _, raw, _ = receipt_fixture()
        with self.assertRaises(consumer.Refused):
            consumer.unpack(raw, "sha256:" + "0" * 64)
        with self.assertRaises(consumer.Refused):
            consumer.unpack(b"x" * (consumer.MAX_BYTES + 1), "unused")
        output = BytesIO()
        with ZipFile(output, "w") as archive:
            archive.writestr("ci-security.json", "{}")
            archive.writestr("../unexpected.json", "{}")
        raw = output.getvalue()
        with self.assertRaises(consumer.Refused):
            consumer.unpack(raw, "sha256:" + hashlib.sha256(raw).hexdigest())

    def test_oversized_download_reaps_its_owned_child(self):
        import subprocess
        import threading

        consumer, *_ = receipt_fixture()
        original = subprocess.Popen
        transport = consumer._process_group
        reasons = {"size": "exceeded its bound", "timeout": "timed out", "exit": "failed"}
        for case in ("success", "size", "timeout", "exit", "cancel"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                command, pids = _writer_command(directory, case, consumer.MAX_BYTES)
                owned = []

                def start(*args, _owned=owned, **kwargs):
                    child = original(*args, **kwargs)
                    child.communicate = unittest.mock.Mock(
                        side_effect=AssertionError("unbounded capture")
                    )
                    _owned.append(child)
                    return child

                get = transport.queue.Queue.get

                def interrupt(*args, _get=get, **kwargs):
                    _get(*args, **kwargs)  # Cancel only after the real writer produced bytes.
                    raise KeyboardInterrupt()

                with (
                    patch.object(transport.subprocess, "Popen", side_effect=start),
                    (
                        patch.object(transport.queue.Queue, "get", interrupt)
                        if case == "cancel"
                        else nullcontext()
                    ),
                ):
                    if case == "success":
                        self.assertEqual(
                            consumer.archive_read(70, command=command, timeout=5), b"exact artifact"
                        )
                    elif case == "cancel":
                        with self.assertRaises(KeyboardInterrupt):
                            consumer.archive_read(70, command=command, timeout=5)
                    else:
                        with self.assertRaisesRegex(consumer.Refused, reasons[case]):
                            consumer.archive_read(
                                70, command=command, timeout=1 if case == "timeout" else 5
                            )
                self.assertEqual(len(owned), 1)
                self.assertIsNotNone(owned[0].poll())
                self.assertTrue(owned[0].stdout.closed)
                for path in pids:
                    self.assertTrue(
                        path.exists(), "Synthetic writer and descendant must actually start"
                    )
                    pid, end = int(path.read_text()), time.monotonic() + 2
                    while _owned_pid_running(pid) and time.monotonic() < end:
                        time.sleep(0.01)
                    self.assertFalse(
                        _owned_pid_running(pid), "Owned process survived reader cleanup"
                    )
                self.assertFalse(
                    any(t.name == "bounded-command-stdout" for t in threading.enumerate())
                )


class SecurityRerunGateTest(unittest.TestCase):
    def test_rerun_guidance_preserves_wait_for_the_exact_worker(self):
        consumer, api, source, _, _, _, receipt, *_ = receipt_fixture()
        environment = {
            "GITHUB_REPOSITORY": consumer.REPOSITORY,
            "GH_TOKEN": "synthetic",
            "GITHUB_RUN_ID": "20",
            "GITHUB_RUN_ATTEMPT": "2",
            "CI_SECURITY_HEAD_SHA": HEAD,
        }
        output = StringIO()
        with (
            patch.object(consumer, "GitHub", return_value=api),
            patch.object(consumer, "find_receipt", side_effect=[None, receipt]),
            patch.object(consumer.time, "monotonic", side_effect=[0, 0, 1]),
            patch.object(consumer.time, "sleep") as sleep,
            redirect_stdout(output),
        ):
            self.assertEqual(consumer.await_receipt(environment), receipt)
        self.assertIn(
            "-f source_run_id=20 -f source_attempt=2 -f source_sha=" + HEAD, output.getvalue()
        )
        sleep.assert_called_once_with(10)

    def test_final_gate_rejects_previous_attempt_or_failed_current_worker(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/ci.yml").read_text().split("\n  ci-status:\n", 1)[1]
        self.assertIn("actions: read", workflow)
        self.assertRegex(
            workflow,
            r"if: github.run_attempt > 1\n\s+run: python3 scripts/ci/github_security_receipt.py",
        )
        self.assertIn(
            "CI_SECURITY_HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}",
            workflow,
        )
        worker = (root / ".github/workflows/ci-security.yml").read_text()
        self.assertIn("types: [requested]", worker)
        self.assertNotIn("types: [in_progress]", worker)
        for scenario in ("valid", "old", "failed"):
            consumer, api, source, producer, _, _, receipt, raw, responses = receipt_fixture()
            title = f"Security alerts for 20 / {1 if scenario == 'old' else 2} / {HEAD}"
            observed = {**producer, "display_title": title}
            if scenario == "failed":
                observed["conclusion"] = "failure"
            responses[
                f"repos/{consumer.REPOSITORY}/actions/workflows/ci-security.yml/runs?branch=main&per_page=100"
            ] = {"workflow_runs": [observed]}
            responses[f"repos/{consumer.REPOSITORY}/actions/workflows/ci-security.yml"] = {
                "id": 50,
                "path": authority.WORKER_PATH,
            }
            environment = {
                "GITHUB_REPOSITORY": consumer.REPOSITORY,
                "GH_TOKEN": "synthetic",
                "GITHUB_RUN_ID": "20",
                "GITHUB_RUN_ATTEMPT": "2",
                "CI_SECURITY_HEAD_SHA": HEAD,
            }
            with (
                self.subTest(scenario=scenario),
                patch.dict(os.environ, environment),
                patch.object(consumer.sys, "argv", ["github_security_receipt.py"]),
                patch.object(consumer, "GitHub", return_value=api),
                patch.object(consumer, "archive_read", return_value=raw),
                patch.object(consumer.time, "monotonic", side_effect=[0, 0, 481]),
                patch.object(consumer.time, "sleep"),
                redirect_stdout(StringIO()),
            ):
                self.assertEqual(consumer.main(), 0 if scenario == "valid" else 1)


if __name__ == "__main__":
    unittest.main()
