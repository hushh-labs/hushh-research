#!/usr/bin/env python3
"""Regression proof for the local backend/proxy handoff."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


LAUNCHER = Path(__file__).with_name("run_backend_local.sh")


class BackendProxyHandoffTest(unittest.TestCase):
    def test_restarts_a_reused_proxy_that_disappears_before_backend_start(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            runtime_dir = root / "scripts" / "runtime"
            env_dir = root / "scripts" / "env"
            backend_dir = root / "consent-protocol"
            fake_bin = root / "fake-bin"
            runtime_dir.mkdir(parents=True)
            env_dir.mkdir(parents=True)
            (backend_dir / ".venv" / "bin").mkdir(parents=True)
            fake_bin.mkdir()

            shutil.copy2(LAUNCHER, runtime_dir / LAUNCHER.name)
            (env_dir / "runtime_profile_lib.sh").write_text(
                "normalize_runtime_profile() { printf '%s\\n' \"$1\"; }\n"
                "runtime_profile_backend_mode() { printf 'local\\n'; }\n",
                encoding="utf-8",
            )
            os.symlink(sys.executable, backend_dir / ".venv" / "bin" / "python")
            credentials = root / "credentials.json"
            credentials.write_text("{}", encoding="utf-8")

            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                proxy_port = reservation.getsockname()[1]

            (backend_dir / ".env").write_text(
                "DB_HOST=127.0.0.1\n"
                f"DB_PORT={proxy_port}\n"
                f"CLOUDSQL_PROXY_PORT={proxy_port}\n"
                "CLOUDSQL_INSTANCE_CONNECTION_NAME=test:region:instance\n"
                f"CLOUDSQL_PROXY_CREDENTIALS_FILE={credentials}\n",
                encoding="utf-8",
            )
            (fake_bin / "uv").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            (fake_bin / "uv").chmod(0o755)
            (fake_bin / "cloud-sql-proxy").write_text(
                """#!/usr/bin/env python3
import socket
import sys

port = int(sys.argv[sys.argv.index('--port') + 1])
with socket.socket() as server:
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen()
    while True:
        connection, _ = server.accept()
        connection.close()
""",
                encoding="utf-8",
            )
            (fake_bin / "cloud-sql-proxy").chmod(0o755)
            subprocess.run(["git", "init", "-q", str(root)], check=True)

            listener_ready = threading.Event()

            def serve_reused_listener_once() -> None:
                with socket.socket() as server:
                    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    server.bind(("127.0.0.1", proxy_port))
                    server.listen(1)
                    listener_ready.set()
                    connection, _ = server.accept()
                    connection.close()

            listener = threading.Thread(target=serve_reused_listener_once, daemon=True)
            listener.start()
            self.assertTrue(listener_ready.wait(timeout=2))

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"
            completed = subprocess.run(
                [
                    "bash",
                    str(runtime_dir / LAUNCHER.name),
                    "local",
                    "--skip-activate",
                    "--skip-preflight",
                    "--preflight-only",
                ],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                timeout=15,
                check=False,
            )

            listener.join(timeout=2)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertIn(
                "The reused DB listener exited during backend handoff; starting a replacement proxy.",
                completed.stdout,
            )
            self.assertIn("Backend preflight passed for runtime mode local.", completed.stdout)


if __name__ == "__main__":
    unittest.main()
