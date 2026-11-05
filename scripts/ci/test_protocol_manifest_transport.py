"""The backend runner retains every test without a native oversized argv."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from web_ci_lane_fixture import ROOT, _bash


class ProtocolManifestTransportTest(unittest.TestCase):
    def _run_manifest(self, manifest, partition=None, missing=(), shard=None, failure=0):
        with tempfile.TemporaryDirectory(prefix="protocol-manifest-") as temporary:
            root = Path(temporary)
            for test_path in set(manifest) - set(missing):
                target = root / test_path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.touch()
            (root / "manifest.txt").write_text("\n".join(manifest) + "\n")
            scratch = root / "scratch"
            scratch.mkdir()
            log = root / "calls.jsonl"
            (root / "pytest.py").write_text(
                "import json,os,sys\n"
                "from pathlib import Path\n"
                "assert len(' '.join(sys.argv)) < 4096, 'native argv is oversized'\n"
                "args=[]\n"
                "for arg in sys.argv[1:]:\n"
                "    args.extend(Path(arg[1:]).read_text().splitlines() if arg.startswith('@') else [arg])\n"
                "with open(os.environ['PYTEST_TRANSPORT_LOG'],'a') as log:\n"
                "    log.write(json.dumps(args)+'\\n')\n"
                f"sys.exit({failure} if '-n' in args else 0)\n"
            )
            env = {
                **os.environ, "PYTHON_BIN": sys.executable,
                "PYTEST_TRANSPORT_LOG": str(log),
                "TMPDIR": str(scratch),
            }
            env.pop("PROTOCOL_TEST_PARTITION", None)
            env.pop("PROTOCOL_DATABASE_SHARD_COUNT", None)
            env.pop("PROTOCOL_DATABASE_SHARD_INDEX", None)
            env.pop("ONE_COMMAND_TEST_DATABASE_URL", None)
            env.pop("ONE_COMMAND_TEST_PG_MANIFEST", None)
            env.pop("OFFLINE_DB_PATH", None)
            if partition is not None:
                env["PROTOCOL_TEST_PARTITION"] = partition
            if shard is not None:
                env.update(shard)
            result = subprocess.run(
                [_bash(), str(ROOT / "consent-protocol/scripts/run-test-ci.sh"), "manifest.txt"],
                cwd=root, env=env, capture_output=True, text=True, timeout=30,
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            self.assertEqual(list(scratch.iterdir()), [], "Runner leaked temporary arguments or offline state")
            return result, calls

    def test_backend_collects_independent_checks_after_successful_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("consent-protocol/scripts/ci/backend-check.sh", "scripts/ci/validation-results.sh"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text((ROOT / name).read_text())
            for name in ("sync_runtime_requirements.sh", "run-test-ci.sh"):
                (root / "consent-protocol/scripts" / name).write_text('echo "$0" >> "$CHECK_LOG"\n')
            binaries = root / "bin"
            binaries.mkdir()
            for name in ("uv", "node"):
                stub = binaries / name
                stub.write_text("""#!/bin/bash
echo "$*" >> "$CHECK_LOG"
case "$*" in
  'sync '*) exit "${SETUP_STATUS:-0}" ;;
  *generate_capability_graph*|*'ruff check'*) exit 1 ;;
esac
""")
                stub.chmod(0o755)
            log = root / "checks"
            env = {**os.environ, "PATH": f"{binaries}{os.pathsep}{os.environ['PATH']}", "CHECK_LOG": str(log)}
            command = [_bash(), "scripts/ci/backend-check.sh"]
            result = subprocess.run(command, cwd=root / "consent-protocol", env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("run-test-ci.sh", log.read_text())
            self.assertIn("Capability graph (exit 1)", result.stderr)
            self.assertIn("Python lint (exit 1)", result.stderr)
            log.unlink()
            result = subprocess.run(command, cwd=root / "consent-protocol", env={**env, "SETUP_STATUS": "1"}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(log.read_text().splitlines(), ["sync --frozen --group dev"])

    def test_large_manifest_keeps_every_argument_and_final_collection(self):
        test_path = "tests/" + "selected_test_" * 7 + ".py"
        expected = [test_path] * 1000
        result, calls = self._run_manifest(expected)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls[0], ["-q", "-n", "auto", "--dist", "loadfile", *expected])
        self.assertEqual(calls[1], ["--collect-only", "-q", "tests/"])

    def test_isolated_partitions_preserve_all_tests_serial_database_and_one_collection(self):
        manifest = [
            "tests/ordinary.py", "tests/owner_postgres.py",
            "tests/services/test_drive_sharing_store.py",
            "tests/services/test_document_delivery_custody.py",
            "tests/services/test_document_delivery_commerce.py",
            "tests/services/test_document_delivery_recovery.py",
            "tests/services/test_document_delivery_lifecycle.py",
        ]
        results = {}
        for partition in (None, "parallel", "database"):
            result, calls = self._run_manifest(manifest, partition)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            results[partition] = calls
        parallel, database = results["parallel"], results["database"]
        self.assertEqual(parallel[0], ["-q", "-n", "auto", "--dist", "loadfile", manifest[0]])
        self.assertEqual(database, [["-q", *manifest[1:]]])
        self.assertEqual(parallel[1:], [["--collect-only", "-q", "tests/"]])
        self.assertEqual(results[None], [parallel[0], *database, *parallel[1:]])

    def test_failed_parallel_tests_do_not_hide_serial_tests_or_collection(self):
        result, calls = self._run_manifest(["tests/ordinary.py", "tests/owner_postgres.py"], failure=1)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1], ["-q", "tests/owner_postgres.py"])
        self.assertEqual(calls[2], ["--collect-only", "-q", "tests/"])

    def test_interrupted_parallel_tests_stop_remaining_partitions(self):
        result, calls = self._run_manifest(["tests/ordinary.py", "tests/owner_postgres.py"], failure=2)
        self.assertEqual(result.returncode, 130)
        self.assertEqual(len(calls), 1)

    def test_unknown_partition_refuses_before_pytest(self):
        result, calls = self._run_manifest(["tests/ordinary.py"], "unknown")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])
        self.assertIn("Unknown backend test partition", result.stderr)

    def test_database_shards_preserve_the_exact_ordered_manifest_without_overlap(self):
        files = ["tests/a_postgres.py", "tests/ordinary.py", "tests/services/test_drive_sharing_store.py",
                 "tests/b_postgres.py", "tests/services/test_document_delivery_custody.py", "tests/c_postgres.py"]
        unsharded, expected = self._run_manifest(files, "database")
        self.assertEqual(unsharded.returncode, 0, unsharded.stderr)
        observed = []
        for index in ("1", "2"):
            result, calls = self._run_manifest(files, "database", shard={
                "PROTOCOL_DATABASE_SHARD_COUNT": "2", "PROTOCOL_DATABASE_SHARD_INDEX": index,
            })
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(calls, [["-q", *expected[0][int(index)::2]]])
            observed.extend(calls[0][1:])
        self.assertCountEqual(observed, expected[0][1:])
        self.assertEqual(len(set(observed)), len(observed))

    def test_invalid_or_empty_database_shards_fail_before_pytest(self):
        files = ["tests/a_postgres.py"]
        cases = [("database", {"PROTOCOL_DATABASE_SHARD_COUNT": "2"}),
                 ("database", {"PROTOCOL_DATABASE_SHARD_INDEX": "1"}),
                 ("database", {"PROTOCOL_DATABASE_SHARD_COUNT": "3", "PROTOCOL_DATABASE_SHARD_INDEX": "1"}),
                 ("database", {"PROTOCOL_DATABASE_SHARD_COUNT": "2", "PROTOCOL_DATABASE_SHARD_INDEX": "0"}),
                 ("database", {"PROTOCOL_DATABASE_SHARD_COUNT": "2", "PROTOCOL_DATABASE_SHARD_INDEX": "2"}),
                 ("parallel", {"PROTOCOL_DATABASE_SHARD_COUNT": "2", "PROTOCOL_DATABASE_SHARD_INDEX": "1"})]
        for partition, shard in cases:
            with self.subTest(partition=partition, shard=shard):
                result, calls = self._run_manifest(files, partition, shard=shard)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_shard_refuses_missing_file_assigned_to_the_other_shard(self):
        missing = "tests/b_postgres.py"
        result, calls = self._run_manifest(["tests/a_postgres.py", missing], "database", [missing],
                                           {"PROTOCOL_DATABASE_SHARD_COUNT": "2", "PROTOCOL_DATABASE_SHARD_INDEX": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])
        self.assertIn("Missing backend CI test file", result.stderr)

    def test_partition_still_refuses_a_missing_file_outside_its_selection(self):
        missing = "tests/owner_postgres.py"
        result, calls = self._run_manifest(["tests/ordinary.py", missing], "parallel", [missing])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])
        self.assertIn("Missing backend CI test file", result.stderr)


if __name__ == "__main__":
    unittest.main()
