"""Keep dry-run native artifacts tied to one gated main commit without store upload."""

import os
import plistlib
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def _workflow(name: str) -> dict:
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text(encoding="utf-8"))


def _steps(workflow: dict, job: str) -> list[dict]:
    return workflow["jobs"][job]["steps"]


def _named(steps: list[dict], name: str) -> dict:
    return next(step for step in steps if step.get("name") == name)


def test_android_dry_run_builds_and_retains_the_exact_green_main_sha() -> None:
    workflow = _workflow("ship-android-playstore-v1.yml")
    # PyYAML 1.1 treats the unquoted Actions `on` key as a boolean.
    assert set(workflow.get("on", workflow.get(True))) == {"workflow_dispatch"}
    assert workflow["permissions"]["checks"] == "read"

    steps = _steps(workflow, "ship")
    assert all("${{" not in step.get("run", "") for step in steps)
    names = [step["name"] for step in steps]
    assert names.index("Resolve release SHA") < names.index("Check out exact release SHA")
    assert names.index("Check out exact release SHA") < names.index("Assert source SHA")
    assert names.index("Assert source SHA") < names.index("Verify matching UAT backend revision")
    assert names.index("Verify matching UAT backend revision") < names.index(
        "Publish .aab as workflow artifact"
    )
    assert names.index("Assert source SHA") < names.index(
        "Build static export & sync Capacitor Android"
    )

    resolve = _named(steps, "Resolve release SHA")
    assert resolve["env"]["REQUIRE_CI_SUCCESS"] == "1"
    assert resolve["env"]["REQUIRED_CHECK_NAME"] == "Main Post-Merge Smoke Gate"
    assert resolve["env"]["REQUESTED_SHA"] == "${{ inputs.sha }}"
    assert resolve["env"]["REQUESTED_TRACK"] == "${{ inputs.track }}"
    assert "internal|alpha|beta|production" in resolve["run"]
    assert "^[0-9a-f]{40}$" in resolve["run"]
    assert 'require-deploy-sha-on-main.sh "$SHA"' in resolve["run"]

    checkout = _named(steps, "Check out exact release SHA")
    assert checkout["with"]["ref"] == "${{ steps.resolve.outputs.sha }}"
    assert "git rev-parse HEAD" in _named(steps, "Assert source SHA")["run"]
    backend = _named(steps, "Verify matching UAT backend revision")
    assert backend["env"]["EXPECTED_SHA"] == "${{ steps.resolve.outputs.sha }}"
    assert "resolve-cloud-run-serving-state.py" in backend["run"]
    assert "metadata.labels.deploy-sha" in backend["run"]
    assert 'test "$actual_sha" = "$EXPECTED_SHA"' in backend["run"]
    signing = _named(steps, "Hydrate Android Release Keystore")
    assert "RELEASE_KEYSTORE_PASSWORD" in signing["env"]
    assert "secrets." not in signing["run"]
    assert "exit 1" in signing["run"]
    assert (
        "inputs.dry_run != true" in _named(steps, "Hydrate Google Play Service Account Key")["if"]
    )
    artifact = _named(steps, "Publish .aab as workflow artifact")
    assert "${{ steps.resolve.outputs.sha }}" in artifact["with"]["name"]
    assert artifact["with"]["path"].endswith("app-release.aab")
    assert artifact["with"]["if-no-files-found"] == "error"
    upload = _named(steps, "Upload .aab to Google Play Console")
    assert "github.event_name == 'workflow_dispatch'" in upload["if"]
    assert "inputs.dry_run != true" in upload["if"]
    summary = _named(steps, "Publish job summary")
    assert summary["env"]["TARGET_TRACK"] == "${{ inputs.track }}"
    assert "printf -- '- **Target Track**: `%s`" in summary["run"]
    assert "cat <<EOF" not in summary["run"]


def test_android_dry_run_versioning_never_passes_play_credentials(tmp_path: Path) -> None:
    steps = _steps(_workflow("ship-android-playstore-v1.yml"), "ship")
    versioning = _named(steps, "Resolve next monotonic Android versionCode")
    assert versioning["env"]["DRY_RUN"] == "${{ inputs.dry_run }}"

    fake_python = tmp_path / "play-venv/bin/python"
    fake_python.parent.mkdir(parents=True)
    fake_python.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TRACE_PATH\"\nprintf '42\\n'\n",
        encoding="utf-8",
    )
    fake_python.chmod(0o700)
    service_account = tmp_path / "play-account.json"
    service_account.write_text("{}", encoding="utf-8")
    trace = tmp_path / "args.txt"

    for dry_run in ("true", "false"):
        # The command is checked-in workflow code; all dynamic paths are test-owned.
        subprocess.run(  # noqa: S603
            ["bash", "-e", "-c", versioning["run"]],
            cwd=ROOT,
            env={
                **os.environ,
                "DRY_RUN": dry_run,
                "GITHUB_OUTPUT": str(tmp_path / "output.txt"),
                "PLAY_SERVICE_ACCOUNT_PATH": str(service_account),
                "RUNNER_TEMP": str(tmp_path),
                "TRACE_PATH": str(trace),
            },
            capture_output=True,
            check=True,
            text=True,
        )
        arguments = trace.read_text(encoding="utf-8").splitlines()
        assert ("--service-account-json" in arguments) is (dry_run == "false")


def test_ios_dry_run_retains_ipa_without_requiring_upload_receipts() -> None:
    workflow = _workflow("ship-ios-testflight.yml")
    preflight = _steps(workflow, "preflight")
    resolve = _named(preflight, "Resolve exact green release SHA")
    assert resolve["env"]["REQUIRED_CHECK_NAME"] == "Main Post-Merge Smoke Gate"
    assert 'require-deploy-sha-on-main.sh "$SHA"' in resolve["run"]

    steps = _steps(workflow, "ship")
    checkout = _named(steps, "Check out exact release SHA")
    assert checkout["with"]["ref"] == "${{ needs.preflight.outputs.release_sha }}"
    assert "git rev-parse HEAD" in _named(steps, "Assert source SHA")["run"]

    export = _named(steps, "Export and upload TestFlight build")
    assert 'if [ "${{ inputs.dry_run }}" = "true" ]' in export["run"]
    assert "Set :destination export" in export["run"]
    assert '-exportPath "$RUNNER_TEMP/export"' in export["run"]
    assert '-authenticationKeyPath "$RUNNER_TEMP/asc.p8"' in export["run"]
    signing = _named(steps, "Create signing keychain")
    assert "APPSTORE_DISTRIBUTION_CERT_P12_B64" in signing["run"]
    assert "security import" in signing["run"]
    export_options = plistlib.loads(
        (ROOT / "hushh-webapp/ios/ExportOptions/AppStoreConnect.plist").read_bytes()
    )
    assert export_options["destination"] == "upload"
    assert export_options["method"] == "app-store-connect"
    assert export_options["signingStyle"] == "automatic"
    ipa = _named(steps, "Preserve dry-run UAT IPA")
    assert "inputs.dry_run == true" in ipa["if"]
    assert ipa["with"]["path"] == "${{ runner.temp }}/export/*.ipa"
    assert ipa["with"]["if-no-files-found"] == "error"
    assert "${{ needs.preflight.outputs.release_sha }}" in ipa["with"]["name"]

    for name in (
        "Preserve uploaded build identity for recovery",
        "Upload recovery receipt before Apple processing",
        "Wait for valid TestFlight processing",
        "Attach the same valid build to both TestFlight groups",
        "Upload redacted release evidence",
    ):
        assert "inputs.dry_run != true" in _named(steps, name)["if"]
