"""Execute the authored browser gate with synthetic package/test executables."""

import subprocess
from pathlib import Path

import yaml

from tests.helpers.deployment_cli import document_installer_environment

ROOT = Path(__file__).resolve().parents[3]
DOCUMENT = "tests/services/test_document_delivery_browser.py"
WEBKIT = DOCUMENT + "::test_protected_document_browser_payment_preview_download_revoke[webkit]"
PHONE = "tests/test_account_phone_browser.py"


def assert_document_platform(tmp_path, ci, mode, runner, expected):
    mirrors = tmp_path / "apt-mirrors.txt"
    mirrors.write_text(
        "http://azure.archive.ubuntu.com/ubuntu/ 10\n"
        "http://archive.ubuntu.com/ubuntu/ 20\nhttp://security.ubuntu.com/ubuntu/ 30\n"
    )
    environment = document_installer_environment(tmp_path)
    executable = tmp_path / "consent-protocol/.venv/bin/python"
    executable.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_ROOT/python-calls"\n')
    script = (
        (ROOT / "scripts/ci/document-delivery-check.sh")
        .read_text()
        .replace("/etc/apt/apt-mirrors.txt", mirrors.as_posix())
    )
    stubs = (
        'git() { echo "$FIXTURE_ROOT"; }; node() { :; }; '
        'sudo() { [ "$1 $2" = "sed -i" ] || return 1; '
        'sed "$3" "$4" > "$4.filtered" && mv "$4.filtered" "$4"; };\n'
    )
    result = subprocess.run(  # noqa: S603 - authored gate, synthetic executables and fixed cases.
        ["bash", "-c", stubs + script, "document-gate", *mode],
        env={**environment, "CI": ci, "RUNNER_OS": runner},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == expected, result.stdout + result.stderr
    package_calls = tmp_path / "calls"
    test_calls = tmp_path / "python-calls"
    if expected:
        assert not package_calls.exists() and not test_calls.exists()
        return
    linux_install = ci == "true" and runner != "macOS"
    assert ("azure.archive" not in mirrors.read_text()) is linux_install
    assert "http://archive.ubuntu.com/ubuntu/" in mirrors.read_text()
    assert "http://security.ubuntu.com/ubuntu/" in mirrors.read_text()
    actual = package_calls.read_text().splitlines() if package_calls.exists() else []
    assert actual == (["playwright install --with-deps chromium webkit"] if linux_install else [])
    selection = f"{DOCUMENT} {PHONE}"
    if mode == ("--ci-linux-document",):
        selection += f" --deselect {WEBKIT}"
    elif mode == ("--ci-macos-webkit",):
        selection = WEBKIT
    assert test_calls.read_text().splitlines() == [f"-m pytest -q {selection}"]


def assert_document_platform_wiring():
    jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
    mac = jobs["web-editor-performance-check"]
    integration = jobs["integration-check"]
    assert mac["runs-on"] == "macos-15" and mac["timeout-minutes"] == 20
    selected = "needs['preflight-gate'].outputs.frontend == 'true' || needs['preflight-gate'].outputs.backend == 'true'"
    assert selected in " ".join(mac["if"].split())
    assert selected in " ".join(integration["if"].split())
    steps = {step.get("id"): step for step in mac["steps"] if step.get("id")}
    assert set(steps) == {"document-python", "document-postgres", "document-webkit"}
    for step in steps.values():
        assert step["if"] == selected
        assert not step.get("continue-on-error")
    assert (
        steps["document-webkit"]["run"]
        == "bash scripts/ci/document-delivery-check.sh --ci-macos-webkit"
    )
    assert steps["document-python"]["uses"] == "./consent-protocol/.github/actions/setup-python-uv"
    assert 'echo "$pg_bin" >> "$GITHUB_PATH"' in steps["document-postgres"]["run"]
    editor = next(
        step for step in mac["steps"] if step.get("run") == "npm run test:layout-editor-performance"
    )
    assert editor["if"] == "needs['preflight-gate'].outputs.editor == 'true'"
    execution = next(
        step
        for step in integration["steps"]
        if step.get("name") == "Run integration check script (single source of truth)"
    )
    assert execution["run"] == "bash scripts/ci/integration-check.sh --ci-linux-document"
    assert not execution.get("continue-on-error")


def assert_integration_mode(tmp_path, mode, runner, expected):
    environment = document_installer_environment(tmp_path)
    (tmp_path / "hushh-webapp/node_modules/vitest").mkdir(parents=True)
    binary = tmp_path / "hushh-webapp/node_modules/.bin/vitest"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    script = (ROOT / "scripts/ci/integration-check.sh").read_text()
    stubs = (
        'git() { echo "$FIXTURE_ROOT"; }; npm() { :; }; '
        'bash() { printf "%s\\n" "$*" >> "$FIXTURE_ROOT/gates"; };\n'
    )
    result = subprocess.run(  # noqa: S603 - authored gate, synthetic executables and fixed cases.
        ["bash", "-c", stubs + script, "integration", *mode],
        env={**environment, "CI": "true", "RUNNER_OS": runner, "CI_RUN_PKM_UPGRADE_GATE": "false"},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == expected, result.stdout + result.stderr
    gates = tmp_path / "gates"
    if expected:
        assert not gates.exists()
        return
    selected = mode[0] if mode else "all"
    assert gates.read_text().splitlines() == [
        str(tmp_path / "scripts/ci/no-ria-feature-flags.sh"),
        str(tmp_path / "scripts/ci/runtime-contract-check.sh"),
        str(tmp_path / "scripts/ci/account-deletion-check.sh"),
        str(tmp_path / "scripts/ci/document-delivery-check.sh") + " " + selected,
    ]
