"""The TestFlight UAT backend provenance check must fail before macOS starts.

"Verify matching UAT backend revision" is the step that fails most often in
Ship iOS to TestFlight. It needs only gcloud, so it runs in the ubuntu
`preflight` job; in the macOS `ship` job it burned Xcode, Node and Python
setup before it could fail. The macOS job must also depend on the preflight
so no build starts until the check passes.
"""

from __future__ import annotations

import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ship-ios-testflight.yml"
CHECK = "Verify matching UAT backend revision"


def _jobs() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]


def _names(job: dict) -> list[str]:
    return [str(step.get("name") or step.get("uses") or "") for step in job["steps"]]


def test_provenance_check_runs_in_the_ubuntu_preflight_after_the_sha_resolves() -> None:
    preflight = _jobs()["preflight"]
    assert str(preflight["runs-on"]).startswith("ubuntu"), preflight["runs-on"]
    assert preflight.get("environment") == {"name": "uat", "deployment": False}
    names = _names(preflight)
    assert CHECK in names, f"{CHECK!r} left the preflight job"
    check_at = names.index(CHECK)
    assert names.index("Resolve exact green release SHA") < check_at
    assert names.index("Authenticate to Google Cloud with workload identity") < check_at

    step = preflight["steps"][check_at]
    assert step["env"]["EXPECTED_SHA"] == "${{ steps.resolve.outputs.sha }}"
    run = step["run"]
    # The resolver comes from the release SHA, as it did in the ship job.
    assert 'git show "$EXPECTED_SHA:scripts/ci/resolve-cloud-run-serving-state.py"' in run
    assert 'gcloud run services describe "$BACKEND_SERVICE"' in run
    assert "metadata.labels.deploy-sha" in run
    assert 'test "$actual_sha" = "$EXPECTED_SHA"' in run
    assert 'test "$actual_tree" = "$expected_tree"' in run
    assert 'require-deploy-sha-on-main.sh "$actual_sha"' in run


def test_macos_ship_job_waits_for_the_preflight_and_no_longer_repeats_the_check() -> None:
    ship = _jobs()["ship"]
    assert str(ship["runs-on"]).startswith("macos")
    assert "preflight" in ship["needs"]
    assert "needs.preflight.result == 'success'" in ship["if"]
    assert CHECK not in _names(ship)


def test_testflight_packaging_override_preserves_archive_and_recovery_identity(tmp_path) -> None:
    """Execute the actual workflow steps, substituting only Xcode's archive boundary."""
    steps = {step.get("name"): step for step in _jobs()["ship"]["steps"]}
    binary_dir = tmp_path / "bin"
    binary_dir.mkdir()
    xcode = binary_dir / "xcodebuild"
    xcode.write_text(
        f"#!{sys.executable}\n"
        "import os, pathlib, plistlib, sys\n"
        "settings = dict(arg.split('=', 1) for arg in sys.argv[1:] if '=' in arg)\n"
        "version = settings.get('MARKETING_VERSION', '1.4.1')\n"
        "app = pathlib.Path(os.environ['RUNNER_TEMP'], 'App.xcarchive/Products/Applications/App.app')\n"
        "for folder in (app, app / 'PlugIns/Notifications.appex'):\n"
        "    folder.mkdir(parents=True, exist_ok=True)\n"
        "    with (folder / 'Info.plist').open('wb') as handle:\n"
        "        plistlib.dump({'CFBundleShortVersionString': version, 'CFBundleVersion': settings['CURRENT_PROJECT_VERSION']}, handle)\n"
    )
    xcode.chmod(0o755)
    project = tmp_path / "project.pbxproj"
    project.write_text("MARKETING_VERSION = 1.4.1;\n")
    environment = {
        "PATH": f"{binary_dir}:{os.defpath}",
        "RUNNER_TEMP": str(tmp_path),
        "PBXPROJ": str(project),
        "GITHUB_ENV": str(tmp_path / "github-env"),
        "XCODE_PROJECT": "synthetic.xcodeproj",
        "XCODE_SCHEME": "App",
        "ASC_KEY_ID": "synthetic",
        "ASC_ISSUER_ID": "synthetic",
        "REQUESTED_MARKETING_VERSION": "1.4.3",
        "IOS_MARKETING_VERSION": "1.4.3",
        "EXPECTED_BUILD_NUMBER": "154",
        "BUILD_NUMBER": "154",
        "RELEASE_SHA": "7" * 40,
        "IOS_BUNDLE_ID": "com.hushh.app",
    }

    def run_step(name):
        command = steps[name]["run"].replace("${{ steps.build_number.outputs.next_build }}", "154")
        # Execute only the checked-in workflow, with synthetic values and an Xcode stub.
        return subprocess.run(  # noqa: S603
            ["bash", "-c", command], env=environment, capture_output=True, text=True
        )

    resolver = "Resolve TestFlight marketing version"
    if resolver in steps:
        resolved = run_step(resolver)
        assert resolved.returncode == 0, resolved.stderr
        projected = (tmp_path / "github-env").read_text().strip().split("=", 1)
        assert projected == ["IOS_MARKETING_VERSION", "1.4.3"]
        environment[projected[0]] = projected[1]
    archived = run_step("Create UAT archive")
    assert archived.returncode == 0, archived.stderr
    app = tmp_path / "App.xcarchive/Products/Applications/App.app"
    with (app / "Info.plist").open("rb") as handle:
        assert plistlib.load(handle)["CFBundleShortVersionString"] == "1.4.3"
    verified = run_step("Verify archived app and extension versions")
    assert verified.returncode == 0, verified.stderr
    receipt = run_step("Preserve uploaded build identity for recovery")
    assert receipt.returncode == 0, receipt.stderr
    assert json.loads((tmp_path / "testflight-upload-receipt.json").read_text()) == {
        "source_sha": "7" * 40,
        "build_number": "154",
        "marketing_version": "1.4.3",
        "bundle_id": "com.hushh.app",
    }

    extension = app / "PlugIns/Notifications.appex/Info.plist"
    with extension.open("wb") as handle:
        plistlib.dump({"CFBundleShortVersionString": "1.4.1", "CFBundleVersion": "154"}, handle)
    assert run_step("Verify archived app and extension versions").returncode != 0
    for invalid in ("1.4", "1.4.3\nINJECTED=value"):
        environment["REQUESTED_MARKETING_VERSION"] = invalid
        (tmp_path / "github-env").unlink(missing_ok=True)
        assert run_step(resolver).returncode != 0
        assert not (tmp_path / "github-env").exists()
