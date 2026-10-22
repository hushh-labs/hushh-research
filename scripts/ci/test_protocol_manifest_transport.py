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
    def test_large_manifest_keeps_every_argument_and_final_collection(self):
        with tempfile.TemporaryDirectory(prefix="protocol-manifest-") as temporary:
            root = Path(temporary)
            test_path = "tests/" + "selected_test_" * 7 + ".py"
            (root / "tests").mkdir()
            (root / test_path).touch()
            expected = [test_path] * 1000
            (root / "manifest.txt").write_text("\n".join(expected) + "\n")
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
            )
            env = {
                **os.environ, "PYTHON_BIN": sys.executable,
                "PYTEST_TRANSPORT_LOG": str(log),
            }
            result = subprocess.run(
                [_bash(), str(ROOT / "consent-protocol/scripts/run-test-ci.sh"), "manifest.txt"],
                cwd=root, env=env, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(calls[0], ["-q", "-n", "auto", "--dist", "loadfile", *expected])
            self.assertEqual(calls[1], ["--collect-only", "-q", "tests/"])


if __name__ == "__main__":
    unittest.main()
