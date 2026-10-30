"""Trust and continuity tests for UAT drain artifacts uploaded before workflow completion."""

from __future__ import annotations

import copy
import hashlib
import importlib
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from zipfile import ZipFile, ZipInfo


maintenance = importlib.import_module("uat-retention-maintenance")


def fixture() -> tuple[dict, dict, dict]:
    run = {
        "id": 38561977307,
        "path": ".github/workflows/capacity-maintenance.yml",
        "head_branch": "main",
        "status": "in_progress",
        "conclusion": None,
        "event": "workflow_run",
        "run_attempt": 1,
        "repository": {"full_name": "org/repo"},
        "head_repository": {"full_name": "org/repo"},
    }
    artifact = {
        "id": 11894675856,
        "name": "uat-retention-state",
        "expired": False,
        "size_in_bytes": 1869,
        "digest": "sha256:" + "a" * 64,
        "created_at": "2026-10-14T12:36:35Z",
        "workflow_run": {"id": run["id"]},
    }
    jobs = {
        "total_count": 2,
        "jobs": [
            {
                "name": "Verify cleanup authority and release evidence",
                "status": "completed",
                "conclusion": "success",
                "run_attempt": 1,
            },
            {
                "name": "UAT revision maintenance (no drain wait)",
                "status": "completed",
                "conclusion": "success",
                "run_attempt": 1,
                "steps": [
                    {
                        "name": "Prepare or finish eligible UAT revision cleanup",
                        "status": "completed",
                        "conclusion": "success",
                    },
                    {
                        "name": "Save UAT drain evidence for a later maintenance pass",
                        "status": "completed",
                        "conclusion": "success",
                        "started_at": "2026-10-14T12:36:34Z",
                        "completed_at": "2026-10-14T12:36:35Z",
                    },
                ],
            },
        ],
    }
    return run, artifact, jobs


class PendingUatStateTests(unittest.TestCase):
    def test_bridge_intent_survives_checkpoints_and_blocks_a_conflicting_deployment(self):
        bridge = {
            "version": 1, "project": "hushh-pda", "service": "consent-protocol",
            "revision": "consent-protocol-cap-" + "a" * 16,
            "sourceFingerprint": "b" * 64, "serviceControlsFingerprint": "c" * 64,
            "sourceRevision": "consent-protocol-source", "displacedLatestRevision": "consent-protocol-displaced",
            "pins": {"DB_PASSWORD": {"version": "projects/hushh-pda/secrets/DB_PASSWORD/versions/1", "unchangedSinceSource": True}},
            "traffic": [["consent-protocol-source", 100, ""]], "requested": True, "status": "intent",
        }
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            receipt = directory / "completed.json"
            receipt.write_text(json.dumps({"capacity_bridge": bridge}))
            args = SimpleNamespace(state_dir=directory, environment="production")
            maintenance.checkpoint(args, 123, 456, [], "complete")
            self.assertEqual(json.loads(receipt.read_text())["capacity_bridge"], bridge)
            with mock.patch.object(maintenance, "assert_checkpoint_publication"), \
                mock.patch.object(maintenance, "restore_state"):
                with self.assertRaisesRegex(maintenance.retention.UnsafeState, "bridge provider outcome"):
                    maintenance.assert_no_pending_mutations("org/repo", directory, "production")
                bridge["status"] = "verified"
                receipt.write_text(json.dumps({"capacity_bridge": bridge, "pass_status": "complete"}))
                maintenance.assert_no_pending_mutations("org/repo", directory, "production")
                predecessor = {**bridge, "status": "intent"}
                successor = {**bridge, "profile": "serving_backend_clone_v2", "revision": "consent-protocol-cap-" + "d" * 16,
                    "displacedLatestRevision": bridge["revision"], "predecessor": predecessor,
                    "predecessorObservation": "provider_observed_unhealthy", "status": "intent"}
                receipt.write_text(json.dumps({"capacity_bridge": successor, "pass_status": "complete"}))
                with self.assertRaisesRegex(maintenance.retention.UnsafeState, "bridge provider outcome"):
                    maintenance.assert_no_pending_mutations("org/repo", directory, "production")
                successor["status"] = "verified"
                receipt.write_text(json.dumps({"capacity_bridge": successor, "pass_status": "complete"}))
                maintenance.assert_no_pending_mutations("org/repo", directory, "production")
                successor["predecessorObservation"] = "healthy"
                receipt.write_text(json.dumps({"capacity_bridge": successor, "pass_status": "complete"}))
                with self.assertRaisesRegex(maintenance.retention.UnsafeState, "predecessor evidence"):
                    maintenance.assert_no_pending_mutations("org/repo", directory, "production")

    def test_three_realistic_overlapping_passes_restore_original_deadline(self) -> None:
        base_run, base_artifact, base_jobs = fixture()
        observations = (
            (38561977307, 11894675856, '2026-10-14T12:36:35Z', 1791981383, 1791981394),
            (38564624075, 11894581322, '2026-10-14T12:38:42Z', 1791981509, 1791981521),
            (38564891487, 11894696741, '2026-10-14T12:41:25Z', 1791981674, 1791981684),
        )
        runs: dict[int, dict] = {}
        jobs: dict[int, dict] = {}
        artifacts: list[dict] = []
        states: dict[int, tuple[int, int]] = {}
        for run_id, artifact_id, created_at, backend_at, worker_at in observations:
            run = copy.deepcopy(base_run)
            run['id'] = run_id
            if run_id == observations[0][0]:
                # The earliest wait has finished, but its recheck is queued.
                run['status'] = 'queued'
            item = copy.deepcopy(base_artifact)
            item.update(id=artifact_id, created_at=created_at, workflow_run={'id': run_id})
            job_inventory = copy.deepcopy(base_jobs)
            upload = job_inventory['jobs'][1]['steps'][1]
            upload['started_at'] = created_at
            upload['completed_at'] = created_at
            runs[run_id] = run
            jobs[run_id] = job_inventory
            artifacts.append(item)
            states[artifact_id] = (backend_at, worker_at)

        def api(_repository: str, endpoint: str) -> dict:
            if endpoint.startswith('artifacts?'):
                # GitHub's artifact ID order can differ from creation order.
                return {'artifacts': [artifacts[2], artifacts[0], artifacts[1]]}
            run_id = int(endpoint.split('/')[1])
            return jobs[run_id] if endpoint.endswith('/jobs?filter=latest&per_page=100') else runs[run_id]

        def download(_repository: str, item: dict, directory: Path, *, environment: str = "uat", source_kind: str = "pending_drain") -> None:
            self.assertEqual(source_kind, "pending_drain")
            backend_at, worker_at = states[item['id']]
            (directory / 'README.txt').write_text('drain evidence')
            for service, observed_at, duration in (
                ('consent-protocol', backend_at, 3660),
                ('consent-protocol-drive-worker', worker_at, 300),
            ):
                (directory / f'{service}.json').write_text(json.dumps({
                    'schema_version': 1,
                    'service': service,
                    'project': 'hushh-pda-uat',
                    'region': 'us-central1',
                    'release_run_id': '38559996683',
                    'fingerprint': [service, 2139],
                    'protected': [service + '-protected'],
                    'observed_at': observed_at,
                    'not_before': observed_at + duration,
                    'revisions': [service + '-old'],
                }))
            (directory / 'completed.json').write_text(json.dumps({
                'schema_version': 1,
                'environment': 'uat',
                'project': 'hushh-pda-uat',
                'release_run_id': 38559996683,
                'observed_run_id': 38564617552 if item['id'] != artifacts[0]['id'] else 38559996683,
            }))

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with (
                mock.patch.object(maintenance, 'api', side_effect=api),
                mock.patch.object(maintenance, 'download_pending_uat_state', side_effect=download),
            ):
                maintenance.restore_state('org/repo', directory)
            backend = json.loads((directory / 'consent-protocol.json').read_text())
            worker = json.loads((directory / 'consent-protocol-drive-worker.json').read_text())
            receipt = json.loads((directory / 'completed.json').read_text())
            self.assertEqual((backend['observed_at'], backend['not_before']),
                             (1791981383, 1791985043))
            self.assertEqual((worker['observed_at'], worker['not_before']),
                             (1791981394, 1791981694))
            self.assertEqual(receipt['observed_run_id'], 38564617552)

    def test_successful_first_pass_preserves_clock_after_cancelled_deploy_observation(self) -> None:
        run, artifact, jobs = fixture()
        expected = ((('consent-protocol-02137-beq', 100, ''),), 'null', 2139, 'uid')
        plan = maintenance.retention.Plan(
            serving=frozenset({'consent-protocol-02137-beq'}),
            protected=frozenset({'consent-protocol-02137-beq'}),
            remove_tags=(),
            delete_revisions=('consent-protocol-02131-tep',),
        )
        saved = {
            'schema_version': 1,
            'service': 'consent-protocol',
            'project': 'hushh-pda-uat',
            'region': 'us-central1',
            'release_run_id': '38559996683',
            'fingerprint': json.loads(json.dumps(expected)),
            'protected': sorted(plan.protected),
            'observed_at': 10000,
            'not_before': 13660,
            'revisions': list(plan.delete_revisions),
        }

        def api(_repository: str, endpoint: str) -> dict:
            if endpoint.startswith('artifacts?'):
                return {'artifacts': [artifact]}
            if endpoint == f'runs/{run["id"]}':
                return run
            if endpoint == f'runs/{run["id"]}/jobs?filter=latest&per_page=100':
                return jobs
            raise AssertionError(endpoint)

        def download(_repository: str, selected: dict, directory: Path, *, environment: str = "uat", source_kind: str = "pending_drain") -> None:
            self.assertEqual(source_kind, "pending_drain")
            self.assertEqual(selected['id'], artifact['id'])
            (directory / 'README.txt').write_text('drain evidence')
            (directory / 'consent-protocol.json').write_text(json.dumps(saved))
            (directory / 'completed.json').write_text(json.dumps({
                'schema_version': 1,
                'environment': 'uat',
                'project': 'hushh-pda-uat',
                'release_run_id': 38559996683,
                'observed_run_id': 38559996683,
            }))

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with (
                mock.patch.object(maintenance, 'api', side_effect=api),
                mock.patch.object(maintenance, 'download_pending_uat_state', side_effect=download) as fetch,
                mock.patch.object(maintenance, 'download', side_effect=AssertionError('name-based download is unsafe')),
                mock.patch.object(maintenance, 'latest_deploy_observation', return_value=38564617552),
                mock.patch.object(maintenance.time, 'time', return_value=10291),
            ):
                self.assertTrue(maintenance.maintenance_due(
                    'org/repo', directory, environment='uat', release_run_id=38559996683
                ))
                fetch.assert_called_once()
                self.assertFalse(maintenance.retention.deferred_drain_ready(
                    directory / 'consent-protocol.json',
                    service='consent-protocol',
                    project='hushh-pda-uat',
                    region='us-central1',
                    expected=expected,
                    plan=plan,
                    drain_seconds=3660,
                    release_run_id='38559996683',
                ))
            inherited = json.loads((directory / 'consent-protocol.json').read_text())
            self.assertEqual((inherited['observed_at'], inherited['not_before']), (10000, 13660))

    def test_pending_artifact_requires_origin_jobs_attempt_and_upload_time(self) -> None:
        run, artifact, jobs = fixture()
        with mock.patch.object(maintenance, 'api', return_value=jobs):
            for workflow_status in ('in_progress', 'queued', 'pending'):
                with self.subTest(workflow_status=workflow_status):
                    run['status'] = workflow_status
                    self.assertTrue(maintenance.trusted_pending_uat_state(
                        'org/repo', run, artifact
                    ))
            run['status'] = 'in_progress'
            mutations = (
                (run, 'path', '.github/workflows/other.yml'),
                (run, 'head_branch', 'feature'),
                (run, 'status', 'completed'),
                (run, 'conclusion', 'failure'),
                (run, 'event', 'pull_request'),
                (run, 'head_repository', {'full_name': 'fork/repo'}),
                (run, 'run_attempt', 2),
                (artifact, 'created_at', '2026-10-14T13:42:14Z'),
                (artifact, 'digest', None),
                (artifact, 'workflow_run', {'id': 999}),
            )
            for target, key, value in mutations:
                with self.subTest(key=key, value=value):
                    variant_run, variant_artifact = copy.deepcopy((run, artifact))
                    (variant_run if target is run else variant_artifact)[key] = value
                    self.assertFalse(maintenance.trusted_pending_uat_state(
                        'org/repo', variant_run, variant_artifact
                    ))
            for target, key, value in (
                (0, 'conclusion', 'failure'),
                (1, 'conclusion', 'failure'),
                (1, 'run_attempt', 2),
                (1, 'steps', []),
            ):
                with self.subTest(job=target, key=key, value=value):
                    variant = copy.deepcopy(jobs)
                    variant['jobs'][target][key] = value
                    with mock.patch.object(maintenance, 'api', return_value=variant):
                        self.assertFalse(maintenance.trusted_pending_uat_state(
                            'org/repo', run, artifact
                        ))

    def test_invalid_creation_time_stops_before_state_download(self) -> None:
        _run, artifact, _jobs = fixture()
        artifact['created_at'] = 'not-a-time'
        with tempfile.TemporaryDirectory() as temporary:
            with (
                mock.patch.object(maintenance, 'api', return_value={'artifacts': [artifact]}),
                mock.patch.object(maintenance, 'download_pending_uat_state',
                                  side_effect=AssertionError('must not download')),
            ):
                with self.assertRaisesRegex(maintenance.retention.UnsafeState,
                                            'creation time'):
                    maintenance.restore_state('org/repo', Path(temporary))

    def test_newer_empty_successful_pass_supersedes_preseeded_state(self) -> None:
        run, artifact, _jobs = fixture()
        run.update(status='completed', conclusion='success')

        def api(_repository: str, endpoint: str) -> dict:
            return {'artifacts': [artifact]} if endpoint.startswith('artifacts?') else run

        def download(_repository: str, _run_id: int, _name: str, directory: Path, *, environment: str = "uat") -> None:
            (directory / 'README.txt').write_text('empty pass')
            (directory / 'completed.json').write_text(json.dumps({
                'schema_version': 1, 'observed_run_id': 200,
            }))

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'consent-protocol.json').write_text('{"observed_at": 100}')
            (directory / 'completed.json').write_text('{"observed_run_id": 100}')
            with (
                mock.patch.object(maintenance, 'api', side_effect=api),
                mock.patch.object(maintenance, 'download', side_effect=download),
            ):
                maintenance.restore_state('org/repo', directory)
            self.assertFalse((directory / 'consent-protocol.json').exists())
            self.assertEqual(json.loads((directory / 'completed.json').read_text())['observed_run_id'], 200)

    def test_production_never_restores_an_in_progress_artifact(self) -> None:
        run, artifact, jobs = fixture()
        artifact['name'] = 'production-retention-state'
        with tempfile.TemporaryDirectory() as temporary:
            with (
                mock.patch.object(maintenance, 'api', side_effect=[
                    {'artifacts': [artifact]}, run,
                ]),
                mock.patch.object(maintenance, 'download', side_effect=AssertionError('must not download')),
                mock.patch.object(maintenance, 'download_pending_uat_state', side_effect=AssertionError('must not download')),
            ):
                maintenance.restore_state('org/repo', Path(temporary), environment='production')
            self.assertEqual(list(Path(temporary).iterdir()), [])

class ImmutableStateArchiveTests(unittest.TestCase):
    def test_pending_download_binds_id_digest_and_rejects_unsafe_zip(self) -> None:
        _run, artifact, _jobs = fixture()

        def archive(name: str, contents: bytes) -> bytes:
            memory = BytesIO()
            with ZipFile(memory, 'w') as bundle:
                bundle.writestr('README.txt', 'drain evidence')
                bundle.writestr('completed.json', '{}')
                bundle.writestr(name, contents)
            return memory.getvalue()

        safe = archive('consent-protocol.json', b'{"observed_at": 10000}')
        unsafe = archive('../consent-protocol.json', b'{}')
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for content, accepted in ((safe, True), (unsafe, False)):
                selected = {**artifact,
                            'size_in_bytes': len(content),
                            'digest': 'sha256:' + hashlib.sha256(content).hexdigest()}
                with mock.patch.object(maintenance.retention, 'run_command', return_value=subprocess.CompletedProcess(
                    [], 0, content, b''
                )) as call:
                    if accepted:
                        maintenance.download_pending_uat_state('org/repo', selected, directory)
                        self.assertEqual((directory / 'consent-protocol.json').read_bytes(), b'{"observed_at": 10000}')
                    else:
                        with self.assertRaises(maintenance.retention.UnsafeState):
                            maintenance.download_pending_uat_state('org/repo', selected, directory)
                    self.assertIn(f'/artifacts/{artifact["id"]}/zip', call.call_args.args[0][-1])
            bad_digest = {**artifact,
                          'size_in_bytes': len(safe),
                          'digest': 'sha256:' + '0' * 64}
            with mock.patch.object(maintenance.retention, 'run_command', return_value=subprocess.CompletedProcess(
                [], 0, safe, b''
            )):
                with self.assertRaisesRegex(maintenance.retention.UnsafeState, 'digest changed'):
                    maintenance.download_pending_uat_state('org/repo', bad_digest, directory)

    def test_saved_checkpoint_without_readme_preserves_archive_safety(self) -> None:
        _run, artifact, _jobs = fixture()

        def archive(*, receipt: bool = True, extra: str | ZipInfo | None = None) -> bytes:
            memory = BytesIO()
            with ZipFile(memory, 'w') as bundle:
                if receipt:
                    bundle.writestr('completed.json', '{"pass_status":"complete"}')
                bundle.writestr('consent-protocol.json', '{"pending_mutation":null}')
                if extra is not None:
                    bundle.writestr(extra, '{}')
            return memory.getvalue()

        symlink = ZipInfo('hushh-webapp.json')
        symlink.create_system = 3
        symlink.external_attr = 0o120777 << 16
        cases = (
            ('modern', archive(), 'saved_checkpoint', True),
            ('legacy_missing_readme', archive(), 'pending_drain', False),
            ('missing_receipt', archive(receipt=False), 'saved_checkpoint', False),
            ('unknown_path', archive(extra='../outside.json'), 'saved_checkpoint', False),
            ('symlink', archive(extra=symlink), 'saved_checkpoint', False),
            ('invalid_kind', archive(), 'unverified', False),
        )
        for name, content, source_kind, accepted in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                selected = {**artifact, 'size_in_bytes': len(content),
                            'digest': 'sha256:' + hashlib.sha256(content).hexdigest()}
                directory = Path(temporary)
                with mock.patch.object(maintenance.retention, 'run_command', return_value=subprocess.CompletedProcess(
                    [], 0, content, b''
                )):
                    if accepted:
                        maintenance.download_pending_uat_state(
                            'org/repo', selected, directory, source_kind=source_kind
                        )
                        self.assertEqual((directory / 'consent-protocol.json').read_text(),
                                         '{"pending_mutation":null}')
                    else:
                        with self.assertRaises(maintenance.retention.UnsafeState):
                            maintenance.download_pending_uat_state(
                                'org/repo', selected, directory, source_kind=source_kind
                            )
                        self.assertEqual(list(directory.iterdir()), [])


class CheckpointRestoreCopyTest(unittest.TestCase):
    def test_trusted_missing_readme_preserves_pending_journal_and_blocks_mutation(self):
        for defect in (None, "digest"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary)
                entries = {"completed.json": json.dumps({"schema_version": 1, "environment": "uat",
                    "project": "hushh-pda-uat", "release_run_id": 40375889792,
                    "observed_run_id": 40375889792, "pass_status": "in_progress"}).encode(),
                    "consent-protocol.json": b'{"pending_mutation":{"operation":"delete","revision":"backend-old"}}'}
                memory = BytesIO()
                with ZipFile(memory, "w") as bundle:
                    for name, content in entries.items():
                        bundle.writestr(name, content)
                archive = memory.getvalue()
                run, item, jobs = fixture()
                run.update(status="completed", conclusion="failure", event="workflow_dispatch", run_attempt=4)
                saved = jobs["jobs"][1]["steps"][1]
                jobs = {"total_count": 1, "jobs": [{"name": "UAT bounded revision cleanup", "status": "completed",
                    "conclusion": "failure", "run_id": run["id"], "run_attempt": 4, "steps": [
                        {**saved, "name": name} for name in ("Checkout mutation tooling and rollback history",
                        "Recheck due source under the deployment lock", "Authenticate to uat", "Save uat cleanup checkpoint")]}]}
                item.update(size_in_bytes=len(archive), digest="sha256:" + hashlib.sha256(archive).hexdigest())
                if defect == "digest":
                    item["digest"] = "sha256:" + "0" * 64
                def api(_repository, endpoint):
                    if endpoint.startswith("artifacts?"):
                        return {"artifacts": [item]}
                    return jobs if "/jobs?" in endpoint else run
                def download(arguments, **_kwargs):
                    self.assertEqual(list(destination.iterdir()), [])
                    self.assertEqual(arguments, ["gh", "api", f"repos/org/repo/actions/artifacts/{item['id']}/zip"])
                    return subprocess.CompletedProcess(arguments, 0, archive, b"")
                with mock.patch.object(maintenance, "api", side_effect=api), mock.patch.object(
                    maintenance, "download", side_effect=AssertionError("saved checkpoint must use artifact ID")
                ) as legacy, mock.patch.object(maintenance.retention, "run_command", side_effect=download) as fetch, \
                    mock.patch.object(maintenance, "assert_checkpoint_publication"):
                    expected = "digest changed" if defect else "provider outcome is unresolved"
                    with self.assertRaisesRegex(maintenance.retention.UnsafeState, expected):
                        maintenance.assert_no_pending_mutations("org/repo", destination, "uat")
                    fetch.assert_called_once()
                    legacy.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in destination.iterdir()},
                                 {} if defect else entries)


if __name__ == '__main__':
    unittest.main()
