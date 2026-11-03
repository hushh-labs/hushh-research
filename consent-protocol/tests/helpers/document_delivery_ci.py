"""Execute the authored browser gate with synthetic package/test executables."""

import subprocess
from pathlib import Path

import yaml

from tests.helpers.deployment_cli import document_installer_environment

ROOT = Path(__file__).resolve().parents[3]
DOCUMENT = "tests/services/test_document_delivery_browser.py"
PHONE = "tests/test_account_phone_browser.py"


# Valid and rejected invocation cases share the gate assertion owner.
DOCUMENT_PLATFORM_CASES = [
    ("false", (), "", 0),
    ("true", (), "Linux", 0),
    ("true", ("--ci-linux-document",), "Linux", 0),
    ("true", ("--ci-macos-webkit",), "macOS", 0),
    ("false", ("--ci-linux-document",), "Linux", 64),
    ("false", ("--ci-macos-webkit",), "macOS", 64),
    ("true", ("--ci-linux-document",), "macOS", 64),
    ("true", ("--ci-macos-webkit",), "Linux", 64),
    ("true", ("unknown",), "Linux", 64),
    ("true", ("all", "extra"), "Linux", 64),
]


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
    expected_engines = {
        (): "chromium webkit",
        ("--ci-linux-document",): "chromium",
        ("--ci-macos-webkit",): "webkit",
    }[mode]
    assert actual == (
        [f"playwright install --with-deps {expected_engines}"] if linux_install else []
    )
    selection = [DOCUMENT, PHONE]
    if mode == ("--ci-linux-document",):
        selection.extend(("-k", "not webkit"))
    elif mode == ("--ci-macos-webkit",):
        selection.extend(("-k", "webkit"))
    assert test_calls.read_text().splitlines() == [f"-m pytest -q {' '.join(selection)}"]


def assert_document_platform_wiring():
    jobs = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]
    mac = jobs["document-webkit-check"]
    integration = jobs["integration-check"]
    assert mac["name"] == "Protected Document WebKit (macOS)"
    assert mac["runs-on"] == "macos-15" and mac["timeout-minutes"] == 20
    selected = "needs['preflight-gate'].outputs.frontend == 'true' || needs['preflight-gate'].outputs.backend == 'true' || needs['preflight-gate'].outputs.document == 'true'"
    document_selected = "needs['preflight-gate'].outputs.document == 'true'"
    assert document_selected in " ".join(mac["if"].split())
    assert selected in " ".join(integration["if"].split())
    steps = {step.get("id"): step for step in mac["steps"] if step.get("id")}
    assert set(steps) == {"document-python", "document-postgres", "document-webkit"}
    for step in steps.values():
        assert step["if"] == document_selected
        assert not step.get("continue-on-error")
    assert (
        steps["document-webkit"]["run"]
        == "bash scripts/ci/document-delivery-check.sh --ci-macos-webkit"
    )
    assert steps["document-python"]["uses"] == "./consent-protocol/.github/actions/setup-python-uv"
    assert 'echo "$pg_bin" >> "$GITHUB_PATH"' in steps["document-postgres"]["run"]
    execution = next(
        step
        for step in integration["steps"]
        if step.get("name") == "Run integration check script (single source of truth)"
    )
    assert execution["run"] == "bash scripts/ci/integration-check.sh --ci-linux-document"
    assert not execution.get("continue-on-error")


def assert_integration_mode(tmp_path, mode, runner, expected, document="true"):
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
        env={
            **environment,
            "CI": "true",
            "RUNNER_OS": runner,
            "CI_RUN_PKM_UPGRADE_GATE": "false",
            "CI_DOCUMENT_CONTRACT_REQUIRED": document,
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == expected, result.stdout + result.stderr
    gates = tmp_path / "gates"
    if expected:
        if document == "true":
            assert not gates.exists()
        else:
            assert "document-delivery-check" not in gates.read_text()
        return
    selected = mode[0] if mode else "all"
    assert gates.read_text().splitlines() == [
        str(tmp_path / "scripts/ci/no-ria-feature-flags.sh"),
        str(tmp_path / "scripts/ci/runtime-contract-check.sh"),
        str(tmp_path / "scripts/ci/account-deletion-check.sh"),
    ] + (
        [str(tmp_path / "scripts/ci/document-delivery-check.sh") + " " + selected]
        if document == "true"
        else []
    )
