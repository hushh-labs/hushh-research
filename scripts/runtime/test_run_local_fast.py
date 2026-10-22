#!/usr/bin/env python3
"""Exercise fast-mode build isolation without real ports, services, or secrets."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


LAUNCHER = Path(__file__).with_name("run_local_fast.sh")
DIST_DIR = ".next-local-fast"


class FastBuildIsolationTest(unittest.TestCase):
    def run_launcher(self, *, skip_build: bool, isolated_build: bool = False) -> tuple[subprocess.CompletedProcess[str], dict, bool]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "scripts" / "runtime"
            runtime.mkdir(parents=True)
            shutil.copy2(LAUNCHER, runtime / LAUNCHER.name)
            web = root / "hushh-webapp"
            (web / ".next").mkdir(parents=True)
            sentinel = web / ".next" / "verification-sentinel"
            sentinel.write_text("do not replace", encoding="utf-8")
            # A valid old shared build must never satisfy --skip-build.
            shared_server = web / ".next" / "standalone" / "hushh-webapp" / "server.js"
            shared_server.parent.mkdir(parents=True)
            shared_server.touch()
            (web / ".next" / "static").mkdir()
            (web / ".next" / "static" / "fixture.js").touch()
            if isolated_build:
                (web / DIST_DIR / "standalone" / "hushh-webapp").mkdir(parents=True)
                (web / DIST_DIR / "standalone" / "hushh-webapp" / "server.js").touch()
                (web / DIST_DIR / "static").mkdir()
                (web / DIST_DIR / "static" / "fixture.js").touch()
            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            profile = root / "scripts" / "env" / "use_profile.sh"
            profile.parent.mkdir()
            profile.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            commands = {
                # Proxy is reused; frontend is free. Other Python invocations
                # use the real interpreter, including private process groups.
                "python3": f"""#!{sys.executable}
import os, sys
if len(sys.argv) == 4 and sys.argv[1] == '-':
    sys.exit(0 if sys.argv[3] == '6543' else 1)
os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
""",
                "curl": "#!/bin/sh\nexit 0\n",
                "npm": f"""#!{sys.executable}
import json, os
from pathlib import Path
dist = os.environ.get('NEXT_DIST_DIR', '.next')
Path(os.environ['FAST_TEST_BUILD']).write_text(json.dumps({{'dist': dist}}))
server = Path(dist) / 'standalone' / 'hushh-webapp' / 'server.js'
server.parent.mkdir(parents=True, exist_ok=True)
server.touch()
static = Path(dist) / 'static'
static.mkdir(exist_ok=True)
(static / 'fixture.js').touch()
""",
                "node": f"""#!{sys.executable}
import json, os, sys
from pathlib import Path
server = Path(sys.argv[1])
asset = server.parent / '{DIST_DIR}' / 'static' / 'fixture.js'
Path(os.environ['FAST_TEST_SERVER']).write_text(json.dumps({{'server': str(server), 'asset_exists': asset.exists()}}))
sys.exit(0 if asset.exists() else 1)
""",
            }
            for name, content in commands.items():
                path = fake_bin / name
                path.write_text(content, encoding="utf-8")
                path.chmod(0o755)
            backend = root / "bin" / "hushh"
            backend.parent.mkdir()
            backend.write_text("#!/bin/sh\nexec sleep 60\n", encoding="utf-8")
            backend.chmod(0o755)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            build_result = root / "build-result.json"
            server_result = root / "server-result.json"
            env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}",
                   "NEXT_DIST_DIR": ".next-unrelated", "FAST_TEST_BUILD": str(build_result),
                   "FAST_TEST_SERVER": str(server_result)}
            completed = subprocess.run(["bash", str(runtime / LAUNCHER.name),
                                        *(["--skip-build"] if skip_build else [])],
                                       cwd=root, env=env, capture_output=True, text=True, timeout=15)
            evidence = {"build": json.loads(build_result.read_text()) if build_result.exists() else None,
                        "server": json.loads(server_result.read_text()) if server_result.exists() else None}
            return completed, evidence, sentinel.read_text() == "do not replace"

    def test_build_and_serve_use_the_same_isolated_directory(self) -> None:
        completed, evidence, sentinel_unchanged = self.run_launcher(skip_build=False)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(evidence["build"], {"dist": DIST_DIR})
        self.assertIn(f"/{DIST_DIR}/standalone/", evidence["server"]["server"])
        self.assertTrue(evidence["server"]["asset_exists"])
        self.assertTrue(sentinel_unchanged)

    def test_skip_build_reuses_only_the_isolated_output(self) -> None:
        completed, evidence, sentinel_unchanged = self.run_launcher(skip_build=True, isolated_build=True)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIsNone(evidence["build"])
        self.assertTrue(evidence["server"]["asset_exists"])
        self.assertTrue(sentinel_unchanged)

    def test_skip_build_refuses_the_old_shared_build(self) -> None:
        completed, evidence, sentinel_unchanged = self.run_launcher(skip_build=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(f"missing in {DIST_DIR}", completed.stderr)
        self.assertIsNone(evidence["server"])
        self.assertTrue(sentinel_unchanged)


if __name__ == "__main__":
    unittest.main()
