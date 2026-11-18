#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Focused contracts for local bootstrap parity and Cloud SQL proxy credentials."""

from __future__ import annotations

import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PARITY_HELPER = Path(__file__).with_name("local_runtime_parity.py")
REPO_ROOT = PARITY_HELPER.resolve().parents[2]
LAUNCHER = REPO_ROOT / "scripts" / "runtime" / "run_backend_local.sh"
if str(PARITY_HELPER.parent) not in sys.path:
    sys.path.insert(0, str(PARITY_HELPER.parent))

from local_runtime_parity import (  # noqa: E402
    enforce_ed25519_pairings,
    normalize_json_env_file,
    resolve_proxy_credentials,
)


class LocalBootstrapAndProxyParityTest(unittest.TestCase):
    def test_explicit_credentials_file_takes_priority_and_missing_fails(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            explicit = root / "explicit.json"
            explicit.write_text("{}", encoding="utf-8")
            env_file = root / ".env"
            env_file.write_text(f"CLOUDSQL_PROXY_CREDENTIALS_FILE={explicit}\n", encoding="utf-8")
            code, status_line, output = resolve_proxy_credentials(env_file)
            self.assertEqual(code, 0)
            self.assertEqual(output, str(explicit))
            self.assertTrue(status_line.startswith("pass|"))

            explicit.unlink()
            code, status_line, _ = resolve_proxy_credentials(env_file, check_only=True)
            self.assertEqual(code, 1)
            self.assertTrue(status_line.startswith("fail|"))

    def test_least_privilege_firebase_sa_uses_adc_and_fails_without_adc(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            sdk_dir = root / "gcloud"
            sdk_dir.mkdir()
            env_file = root / ".env"
            sa_json = json.dumps({"client_email": "firebase-sdk-dev@hushh-pda-dev.iam.gserviceaccount.com"})
            env_file.write_text(f"FIREBASE_ADMIN_CREDENTIALS_JSON={sa_json}\n", encoding="utf-8")
            prev = os.environ.get("CLOUDSDK_CONFIG")
            prev_gac = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
            os.environ["CLOUDSDK_CONFIG"] = str(sdk_dir)
            os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
            try:
                code, status_line, _ = resolve_proxy_credentials(env_file, check_only=True)
                self.assertEqual(code, 1)
                self.assertTrue(status_line.startswith("fail|"))

                adc_file = sdk_dir / "application_default_credentials.json"
                adc_file.write_text('{"type":"authorized_user"}', encoding="utf-8")
                temp_file = root / "temp-sa.json"
                code, status_line, output = resolve_proxy_credentials(env_file, materialize_temp=temp_file)
                self.assertEqual(code, 0)
                self.assertEqual(output, str(adc_file))
                self.assertFalse(temp_file.exists())
                self.assertTrue(status_line.startswith("pass|"))
            finally:
                if prev is not None:
                    os.environ["CLOUDSDK_CONFIG"] = prev
                else:
                    os.environ.pop("CLOUDSDK_CONFIG", None)
                if prev_gac is not None:
                    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = prev_gac

    def test_runtime_sa_materializes_chmod600_temp_file_without_using_adc(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env_file = root / ".env"
            sa_json = json.dumps({"client_email": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"})
            env_file.write_text(f"FIREBASE_ADMIN_CREDENTIALS_JSON={sa_json}\n", encoding="utf-8")
            temp_file = root / "temp-sa.json"
            code, _, output = resolve_proxy_credentials(env_file, materialize_temp=temp_file)
            self.assertEqual(code, 0)
            self.assertEqual(output, str(temp_file))
            self.assertTrue(temp_file.is_file())
            self.assertEqual(stat.S_IMODE(temp_file.stat().st_mode), 0o600)

            empty_env = root / ".empty.env"
            empty_env.write_text("CLOUDSQL_PROXY_CREDENTIALS_FILE=\nFIREBASE_ADMIN_CREDENTIALS_JSON=\n", encoding="utf-8")
            code, _, _ = resolve_proxy_credentials(empty_env)
            self.assertEqual(code, 1)

    def test_normalize_json_and_ed25519_pairing_guard(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            env_file = Path(raw) / ".env"
            env_file.write_text(
                "CONSENT_ED25519_PUBLIC_KEYS={\n"
                '  "k1": "pub"\n'
                "}\n"
                "CONSENT_TOKEN_SIGNING_ALG=ed25519\n"
                "CONSENT_ED25519_PRIVATE_KEY=\n"
                "CONSENT_AUDIT_SIGNING_ALG=ed25519\n"
                "CONSENT_AUDIT_ED25519_PRIVATE_KEY=seed-present\n"
                'CONSENT_AUDIT_ED25519_PUBLIC_KEYS={"a1":"pub"}\n'
                "KEEP_KEY=value\n",
                encoding="utf-8",
            )
            normalize_json_env_file(env_file)
            enforce_ed25519_pairings(env_file)
            text = env_file.read_text(encoding="utf-8")
            self.assertIn('CONSENT_ED25519_PUBLIC_KEYS={"k1":"pub"}', text)
            self.assertIn("CONSENT_TOKEN_SIGNING_ALG=\n", text)
            self.assertIn("CONSENT_AUDIT_SIGNING_ALG=ed25519\n", text)
            self.assertIn("KEEP_KEY=value\n", text)

    def test_backend_launcher_uses_adc_fallback_for_least_privilege_firebase_sa(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            for rel in ("scripts/runtime", "scripts/env", "consent-protocol/.venv/bin", "fake-bin", "gcloud"):
                (root / rel).mkdir(parents=True)
            shutil.copy2(LAUNCHER, root / "scripts/runtime/run_backend_local.sh")
            shutil.copy2(PARITY_HELPER, root / "scripts/env/local_runtime_parity.py")
            (root / "scripts/env/runtime_profile_lib.sh").write_text(
                "normalize_runtime_profile() { printf '%s\\n' \"$1\"; }\n"
                "runtime_profile_backend_mode() { printf 'local\\n'; }\n",
                encoding="utf-8",
            )
            os.symlink(sys.executable, root / "consent-protocol/.venv/bin/python")
            adc_file = root / "gcloud/application_default_credentials.json"
            adc_file.write_text('{"type":"authorized_user"}', encoding="utf-8")
            creds_seen = root / "creds-seen.txt"
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                proxy_port = reservation.getsockname()[1]
            sa_json = json.dumps({"client_email": "firebase-sdk-dev@hushh-pda-dev.iam.gserviceaccount.com"})
            (root / "consent-protocol/.env").write_text(
                f"DB_HOST=127.0.0.1\nDB_PORT={proxy_port}\nCLOUDSQL_PROXY_PORT={proxy_port}\n"
                "CLOUDSQL_INSTANCE_CONNECTION_NAME=hushh-pda-dev:us-central1:hushh-dev-pg\n"
                f"FIREBASE_ADMIN_CREDENTIALS_JSON={sa_json}\n",
                encoding="utf-8",
            )
            (root / "fake-bin/uv").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            (root / "fake-bin/uv").chmod(0o755)
            (root / "fake-bin/cloud-sql-proxy").write_text(
                f"#!{sys.executable}\nimport pathlib, socket, sys\n"
                "creds = sys.argv[sys.argv.index('--credentials-file') + 1]\n"
                f"pathlib.Path({str(creds_seen)!r}).write_text(creds, encoding='utf-8')\n"
                "port = int(sys.argv[sys.argv.index('--port') + 1])\n"
                "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
                "s.bind(('127.0.0.1', port)); s.listen()\n"
                "while True: c, _ = s.accept(); c.close()\n",
                encoding="utf-8",
            )
            (root / "fake-bin/cloud-sql-proxy").chmod(0o755)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            env = {**os.environ, "PATH": f"{root / 'fake-bin'}:{os.environ['PATH']}", "CLOUDSDK_CONFIG": str(root / "gcloud")}
            env.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
            completed = subprocess.run(
                ["bash", "scripts/runtime/run_backend_local.sh", "local", "--skip-activate", "--skip-preflight", "--preflight-only"],
                cwd=root, env=env, text=True, capture_output=True, timeout=15, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertEqual(creds_seen.read_text(encoding="utf-8"), str(adc_file))

    def test_backend_template_contains_required_pod_and_ed25519_parity_keys(self) -> None:
        text = (REPO_ROOT / "consent-protocol" / ".env.example").read_text(encoding="utf-8")
        for key in (
            "HUSHH_DEPLOY_ENV=",
            "CLOUDSQL_PROXY_CREDENTIALS_FILE=",
            "CONSENT_TOKEN_SIGNING_ALG=",
            "CONSENT_ED25519_PRIVATE_KEY=",
            "CONSENT_ED25519_PUBLIC_KEYS=",
            "CONSENT_AUDIT_ED25519_PRIVATE_KEY=",
            "PERSONAL_AGENT_ENABLED=",
            "HUSSH_GEMINI_TEXT_MODEL=",
        ):
            self.assertIn(key, text)


if __name__ == "__main__":
    unittest.main()
