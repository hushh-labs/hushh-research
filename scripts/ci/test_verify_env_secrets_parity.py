from __future__ import annotations

import importlib.util
from pathlib import Path


def _module():
    path = Path(__file__).parents[1] / "ops" / "verify-env-secrets-parity.py"
    spec = importlib.util.spec_from_file_location("verify_env_secrets_parity", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _valid_one_email_env() -> dict[str, dict[str, str]]:
    return {
        "ONE_EMAIL_ADDRESS": {"value": "one@hushh.ai"},
        "ONE_EMAIL_DELEGATED_USER": {"value": "one@hushh.ai"},
        "ONE_EMAIL_PUBSUB_TOPIC": {
            "value": "projects/hushh-pda/topics/one-email-kyc-uat"
        },
        "ONE_EMAIL_WEBHOOK_AUDIENCE": {
            "value": "https://backend.example/api/one/email/webhook"
        },
        "ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL": {
            "value": "one-email-push@example.iam.gserviceaccount.com"
        },
        "ONE_EMAIL_WEBHOOK_AUTH_ENABLED": {"value": "true"},
        "ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED": {"value": "true"},
        "ONE_EMAIL_KYC_DEFAULT_SCOPE": {"value": "attr.identity.*"},
        "ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED": {"value": "true"},
    }


def test_one_email_runtime_semantics_accepts_canonical_hosted_configuration():
    result = _module()._one_email_runtime_semantics(_valid_one_email_env())

    assert result["status"] == "valid"
    assert set(result["checks"].values()) == {"valid"}


def test_one_email_runtime_semantics_rejects_noncanonical_mailbox():
    env = _valid_one_email_env()
    env["ONE_EMAIL_ADDRESS"] = {"value": "other@hushh.ai"}

    result = _module()._one_email_runtime_semantics(env)

    assert result["status"] == "mismatch"
    assert result["checks"]["mailbox"] == "mismatch"


def test_secret_inventory_does_not_misclassify_auth_failure(monkeypatch):
    import subprocess
    import pytest
    module = _module()
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k:
                        subprocess.CompletedProcess(a, 1, "", "Reauthentication failed: sensitive marker"))
    with pytest.raises(module.CloudReadUnavailable, match="secret_inventory_unverifiable"):
        module._has_secret("example", "EXAMPLE_SECRET")


def test_secret_inventory_distinguishes_found_and_not_found(monkeypatch):
    import subprocess
    module = _module()
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k:
                        subprocess.CompletedProcess(a, 0, "projects/example/secrets/EXAMPLE", ""))
    assert module._has_secret("example", "EXAMPLE") is True
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k:
                        subprocess.CompletedProcess(a, 1, "", "NOT_FOUND: Secret missing"))
    assert module._has_secret("example", "EXAMPLE") is False


def test_unverifiable_inventory_report_omits_provider_error(monkeypatch, tmp_path, capsys):
    import json
    import sys
    module = _module()
    report = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["verify", "--project", "example", "--report-path", str(report)])
    def unavailable(*args):
        raise module.CloudReadUnavailable("sensitive marker")
    monkeypatch.setattr(module, "_has_secret", unavailable)
    assert module.main() == 1
    payload = json.loads(report.read_text())
    assert payload["missing_secrets"] is None
    assert payload["classifications"] == ["secret_inventory_unverifiable"]
    assert "sensitive marker" not in report.read_text() + capsys.readouterr().out


def test_db_guard_clears_inherited_socket_for_explicit_tcp(tmp_path):
    import json
    import os
    import shutil
    import subprocess
    import sys
    import pytest
    if not shutil.which('jq'):
        pytest.skip('DB wrapper requires jq')
    fake_cloud = tmp_path / 'gcloud'
    service = {'spec': {'template': {'spec': {'containers': [{'env': [
        {'name': 'DB_HOST', 'value': '127.0.0.1'},
        {'name': 'DB_NAME', 'value': 'fixture'},
        {'name': 'DB_USER', 'value': 'mounted-user'},
        {'name': 'DB_PASSWORD', 'value': 'mounted-password'},
    ]}]}}}}
    fake_cloud.write_text(
        f'#!{sys.executable}\nimport sys\n'
        f'if sys.argv[1:4] == ["run", "services", "describe"]: print({json.dumps(json.dumps(service))})\n'
        'elif sys.argv[1:3] == ["secrets", "describe"]: sys.exit(1)\n'
        'elif sys.argv[1:4] == ["secrets", "versions", "access"]: print("fixture-only")\n'
        'else: sys.exit(2)\n'
    )
    fake_cloud.chmod(0o700)
    probe = tmp_path / 'probe-python'
    probe.write_text(
        f'#!{sys.executable}\nimport os\n'
        'assert os.environ["DB_UNIX_SOCKET"] == ""\n'
        'assert os.environ["DB_HOST"] == "127.0.0.1"\n'
        'assert os.environ["DB_USER"] == "mounted-user"\n'
        'assert os.environ["DB_PASSWORD"] == "mounted-password"\n'
        'print("explicit TCP contract preserved")\n'
    )
    probe.chmod(0o700)
    env = dict(os.environ, PATH=f'{tmp_path}{os.pathsep}{os.environ["PATH"]}',
               PYTHON=str(probe), DB_UNIX_SOCKET='/cloudsql/fixture-stale-socket')
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([
        'bash', 'scripts/ops/verify_runtime_db_contract.sh', '--project', 'fixture',
        '--service', 'fixture', '--contract-file', 'fixture.json',
        '--report-path', str(tmp_path / 'report.json'),
    ], cwd=root, env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert 'explicit TCP contract preserved' in result.stdout


def test_db_guard_rejects_an_existing_proxy_port(tmp_path):
    import json
    import os
    import shutil
    import socket
    import subprocess
    import sys
    import pytest

    if not shutil.which("jq"):
        pytest.skip("DB wrapper requires jq")
    service = {"spec": {"template": {"spec": {"containers": [{"env": [
        {"name": "DB_UNIX_SOCKET", "value": "/cloudsql/fixture:region:instance"},
    ]}]}}}}
    cloud = tmp_path / "gcloud"
    cloud.write_text(f"#!{sys.executable}\nimport sys\n"
        f"if sys.argv[1:4] == ['run', 'services', 'describe']: print({json.dumps(json.dumps(service))})\n"
        "elif sys.argv[1:3] == ['secrets', 'describe']: sys.exit(1)\n"
        "else: print('fixture-only')\n")
    cloud.chmod(0o700)
    proxy = tmp_path / "cloud-sql-proxy"
    proxy.write_text("#!/bin/sh\nexit 91\n")
    proxy.chmod(0o700)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        result = subprocess.run([
            "bash", "scripts/ops/verify_runtime_db_contract.sh", "--project", "fixture",
            "--contract-file", "fixture.json", "--proxy-port", str(listener.getsockname()[1]),
            "--report-path", str(tmp_path / "report.json"),
        ], cwd=Path(__file__).resolve().parents[2],
            env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"},
            capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert "proxy port is occupied" in result.stderr
    assert not (tmp_path / "report.json").exists()
