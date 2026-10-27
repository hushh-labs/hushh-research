"""The manual PLG gate must execute its PostgreSQL assertion, not collect it."""

import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/validate-plg-source.yml"
CASE = "test_memory_revision_lookup_on_disposable_postgres"
MODULE = "tests.test_plg_memory_query_postgres"


def _workflow():
    # BaseLoader has no object constructors and keeps GitHub's `on` key a string.
    return yaml.load(
        WORKFLOW.read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,  # noqa: S506 -- strings/sequences/mappings only, no object constructors.
    )


def _step(name):
    return next(
        step for step in _workflow()["jobs"]["validate"]["steps"] if step.get("name") == name
    )


def _python(name):
    run = _step(name)["run"]
    return run.split("python3 - <<'PY'\n", 1)[1].split("\nPY", 1)[0]


def _check_reports():
    code = compile(
        _python("Verify executed PostgreSQL case and backend reports"), str(WORKFLOW), "exec"
    )
    exec(code, {"__name__": "__main__"})  # noqa: S102 -- authored workflow, synthetic XML only.


def _bash():
    if os.name == "nt":
        path = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        return str(path) if path.is_file() else None
    return shutil.which("bash")


@pytest.mark.parametrize(
    ("event", "ref", "allowed"),
    [
        ("workflow_dispatch", "refs/heads/main", True),
        ("push", "refs/heads/main", False),
        ("workflow_dispatch", "refs/heads/other", False),
    ],
)
def test_dispatch_guard_rejects_other_events_and_branches(event, ref, allowed):
    bash = _bash()
    if not bash:
        pytest.skip("Bash is required to execute the workflow guard")
    result = subprocess.run(  # noqa: S603 -- main-owned shell guard with synthetic environment.
        [bash, "-c", _step("Require main workflow dispatch")["run"]],
        env={**os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_REF": ref},
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert (result.returncode == 0) == allowed


def test_workflow_keeps_main_authority_read_only_and_admits_before_source_checkout():
    workflow = _workflow()
    assert set(workflow["on"]) == {"workflow_dispatch"}
    assert set(workflow["on"]["workflow_dispatch"]["inputs"]) == {"sha"}
    assert workflow["permissions"] == {"contents": "read"}
    job = workflow["jobs"]["validate"]
    assert job["name"] == "PLG Source Validation Gate"
    assert job["runs-on"] == "ubuntu-24.04" and job["timeout-minutes"] == "40"
    assert job["services"]["postgres"]["image"] == (
        "mirror.gcr.io/pgvector/pgvector@sha256:"
        "cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f"
    )
    steps = job["steps"]
    names = [step.get("name") for step in steps]
    assert names.index("Require governed production actor") < names.index(
        "Admit exact PLG source before checkout"
    )
    assert names.index("Admit exact PLG source before checkout") < names.index(
        "Checkout admitted source"
    )
    assert _step("Checkout main validation authority")["with"]["path"] == "authority"
    assert _step("Checkout admitted source")["with"]["ref"] == "$" + "{{ steps.admit.outputs.sha }}"
    admission = _step("Admit exact PLG source before checkout")["run"]
    assert 'record.get("sourceSha") != os.environ["REQUESTED_SHA"]' in admission
    assert 'module.qualify_source(os.environ["REQUESTED_SHA"])' in admission
    assert 'proof["trafficAuthorized"] is not False' in admission
    actor = _step("Require governed production actor")["run"]
    assert "--surface production" in actor and "$GITHUB_TRIGGERING_ACTOR" in actor
    source = WORKFLOW.read_text(encoding="utf-8")
    assert "secrets." not in source and "id-token:" not in source
    assert "gcloud" not in source and "google-github-actions/" not in source


def test_full_source_runner_is_unchanged_with_bounded_workers_and_local_database():
    step = _step("Run full canonical source backend manifest")
    assert step["working-directory"] == "source/consent-protocol"
    assert step["env"]["ONE_COMMAND_TEST_DATABASE_URL"] == (
        "postgresql+psycopg2://postgres:postgres@127.0.0.1:5432/plg_test"
    )
    assert step["env"]["PYTEST_XDIST_AUTO_NUM_WORKERS"] == "2"
    assert step["env"]["DB_OFFLINE"] == "1"
    assert step["run"].count("bash scripts/run-test-ci.sh") == 1
    assert "--junitxml=$report" in step["run"] and "--collect-only" in step["run"]
    assert "pytest-$BASHPID.xml" in step["run"]
    setup = _step("Install locked source Python environment")
    assert setup["uses"].startswith("./authority/")
    assert setup["with"]["protocol-dir"] == "./source/consent-protocol"
    scan = _step("Scan exact source changes for secrets")["run"]
    assert "--redact" in scan and '--log-opts="$BASELINE..$SOURCE_SHA"' in scan
    assert (
        "authority/scripts/ci/check-dco-signoff.sh"
        in _step("Verify exact source DCO signoffs")["run"]
    )


def _reports(tmp_path, monkeypatch, variant):
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    folder = tmp_path / "plg-source-validation" / "reports"
    folder.mkdir(parents=True)
    if variant == "missing":
        return folder
    suite = ET.Element("testsuite", failures="0", errors="0")
    case = ET.SubElement(suite, "testcase", name=CASE, classname=MODULE)
    ET.SubElement(suite, "testcase", name="ordinary", classname="tests.ordinary")
    if variant in {"skipped", "failure", "error"}:
        ET.SubElement(case, variant)
    elif variant == "duplicate":
        ET.SubElement(suite, "testcase", name=CASE, classname=MODULE)
    elif variant == "wrong-module":
        case.set("classname", "tests.other")
    elif variant == "wrong-file":
        case.set("file", "tests/other.py")
    elif variant == "other-failure":
        ET.SubElement(list(suite)[1], "failure")
    elif variant == "suite-error":
        suite.set("errors", "1")
    elif variant == "collected-only":
        suite.remove(case)
    ET.ElementTree(suite).write(folder / "pytest-123.xml", encoding="utf-8")
    return folder


@pytest.mark.parametrize(
    "variant",
    [
        "missing",
        "skipped",
        "failure",
        "error",
        "duplicate",
        "wrong-module",
        "wrong-file",
        "other-failure",
        "suite-error",
        "collected-only",
    ],
)
def test_collection_skips_and_other_failures_cannot_make_a_regression_receipt(
    tmp_path, monkeypatch, variant
):
    _reports(tmp_path, monkeypatch, variant)
    with pytest.raises(SystemExit):
        _check_reports()
    assert not (tmp_path / "plg-source-validation/backend-counts.json").exists()


def test_actual_single_passed_case_produces_backend_counts(tmp_path, monkeypatch):
    _reports(tmp_path, monkeypatch, "passed")
    _check_reports()
    counts = json.loads((tmp_path / "plg-source-validation/backend-counts.json").read_text())
    assert counts == {"passed": 2, "failed": 0, "errors": 0, "skipped": 0}


@pytest.mark.parametrize("collect", [False, True])
def test_invocation_wrapper_adds_one_report_without_a_second_test_run(tmp_path, collect):
    bash = _bash()
    if not bash:
        pytest.skip("Bash is required for the invocation wrapper")
    run = _step("Run full canonical source backend manifest")["run"]
    wrapper = run.split("cat > \"$PYTHON_BIN\" <<'SH'\n", 1)[1].split("\nSH", 1)[0]
    path = tmp_path / "python-wrapper"
    path.write_text(wrapper, encoding="utf-8")
    (tmp_path / "pytest.py").write_text(
        "import json,os,sys\nfrom pathlib import Path\n"
        "with Path(os.environ['CALL_LOG']).open('a') as log:\n"
        "    log.write(json.dumps(sys.argv[1:]) + '\\n')\n",
        encoding="utf-8",
    )
    log = tmp_path / "call.json"
    arguments = ["-m", "pytest", "--collect-only" if collect else "-q", "tests/example.py"]
    subprocess.run(  # noqa: S603 -- test-only pytest module records arguments, executes no tests.
        [bash, path.as_posix(), *arguments],
        cwd=tmp_path,
        env={
            **os.environ,
            "PLG_REAL_PYTHON": Path(sys.executable).as_posix(),
            "PLG_REPORTS": tmp_path.as_posix(),
            "CALL_LOG": str(log),
        },
        capture_output=True,
        timeout=10,
        check=True,
    )
    calls = log.read_text().splitlines()
    assert len(calls) == 1
    actual = json.loads(calls[0])
    reports = [arg for arg in actual if arg.startswith("--junitxml=")]
    assert len(reports) == (0 if collect else 1)
    assert actual[: len(arguments) - 2] == arguments[2:]
    if reports:
        assert re.search(r"pytest-\d+\.xml$", reports[0])


def test_final_receipt_rechecks_authority_and_uploads_only_acceptance():
    final = _step("Recheck exact source and record validation receipt")["run"]
    assert "git -C source rev-parse HEAD" in final
    assert "git -C authority rev-parse HEAD" in final
    assert 'git -C "$checkout" diff --cached --quiet' in final
    assert "ls-files --others --exclude-standard" in final
    assert 'proof != original["proof"]' in final
    assert 'original["authorityFiles"]' in final
    assert "postgres-memory-regression" in final and "frontend-native-continuity" in final
    upload = _step("Upload exact source validation receipt")["with"]
    assert upload["name"] == "plg-source-validation-${{ github.run_id }}-${{ github.run_attempt }}"
    assert upload["path"] == "$" + "{{ runner.temp }}/plg-source-validation/acceptance.json"
    assert upload["if-no-files-found"] == "error"
