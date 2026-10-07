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


def test_android_release_is_green_main_production_only_and_fail_closed() -> None:
    workflow = _workflow("ship-android-playstore-v1.yml")
    # PyYAML 1.1 treats the unquoted Actions `on` key as a boolean.
    assert set(workflow.get("on", workflow.get(True))) == {"workflow_dispatch"}
    inputs = workflow.get("on", workflow.get(True))["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"sha", "dry_run", "notes"}
    assert workflow["permissions"]["checks"] == "read"
    assert workflow["env"]["PROD_GCP_PROJECT_ID"] == "hushh-pda"
    assert workflow["env"]["GCP_PROJECT_ID"] == "hushh-pda-uat"
    assert workflow["env"]["TARGET_TRACK"] == "production"
    assert workflow["jobs"]["ship"]["environment"] == "production"

    steps = _steps(workflow, "ship")
    assert all("${{" not in step.get("run", "") for step in steps)
    names = [step["name"] for step in steps]
    assert names.index("Resolve release SHA") < names.index("Check out exact release SHA")
    assert names.index("Check out exact release SHA") < names.index("Assert source SHA")
    assert names.index("Assert source SHA") < names.index("Read production routing contract")
    assert names.index("Read production routing contract") < names.index(
        "Verify matching production backend revision"
    )
    assert names.index("Verify matching production backend revision") < names.index(
        "Authenticate to Google Cloud (release secrets)"
    )
    assert names.index("Authenticate to Google Cloud (release secrets)") < names.index(
        "Materialize production frontend contract"
    )
    assert names.index("Verify matching production backend revision") < names.index(
        "Preserve signed AAB in private UAT bucket"
    )
    assert names.index("Assert source SHA") < names.index(
        "Build static export & sync Capacitor Android"
    )

    resolve = _named(steps, "Resolve release SHA")
    assert resolve["env"]["REQUIRE_CI_SUCCESS"] == "1"
    assert resolve["env"]["REQUIRED_CHECK_NAME"] == "Main Post-Merge Smoke Gate"
    assert resolve["env"]["REQUESTED_SHA"] == "${{ inputs.sha }}"
    assert "^[0-9a-f]{40}$" in resolve["run"]
    assert 'require-deploy-sha-on-main.sh "$SHA"' in resolve["run"]

    actor = _named(steps, "Authorize production dispatch actor")
    assert "--surface production" in actor["run"]
    production_auth = _named(steps, "Authenticate to Google Cloud (production contract)")
    assert production_auth["with"]["project_id"] == "${{ env.PROD_GCP_PROJECT_ID }}"
    routing = _named(steps, "Read production routing contract")
    assert "PROD_BACKEND_URL" in routing["run"]
    assert "PROD_FB_PROJECT_ID" in routing["run"]
    assert "*uat*" in routing["run"]

    checkout = _named(steps, "Check out exact release SHA")
    assert checkout["with"]["ref"] == "${{ steps.resolve.outputs.sha }}"
    assert "git rev-parse HEAD" in _named(steps, "Assert source SHA")["run"]
    backend = _named(steps, "Verify matching production backend revision")
    assert backend["env"]["EXPECTED_SHA"] == "${{ steps.resolve.outputs.sha }}"
    assert "verify-cloudrun-revision-provenance.py" in backend["run"]
    assert "--expected-env production" in backend["run"]
    assert "--expected-source deploy-production" in backend["run"]
    assert '--expected-sha "$EXPECTED_SHA"' in backend["run"]

    secrets_auth = _named(steps, "Authenticate to Google Cloud (release secrets)")
    assert secrets_auth["with"]["credentials_json"] == "${{ secrets.GCP_SA_KEY_UAT }}"
    materialize = _named(steps, "Materialize production frontend contract")
    assert 'put APP_RUNTIME_PROFILE "prod"' in materialize["run"]
    assert 'put NEXT_PUBLIC_APP_ENV "production"' in materialize["run"]
    assert "PROD_FB_PROJECT_ID" in materialize["run"]
    firebase = _named(steps, "Hydrate and verify Android Firebase config")
    assert "project_info" in firebase["run"]
    assert "ANDROID_PACKAGE_NAME" in firebase["run"]

    signing = _named(steps, "Hydrate Android Release Keystore")
    assert "RELEASE_KEYSTORE_PASSWORD" in signing["env"]
    assert "secrets." not in signing["run"]
    assert "exit 1" in signing["run"]
    play_key = _named(steps, "Hydrate Google Play Service Account Key")
    assert "if" not in play_key
    assert "exit 1" in play_key["run"]
    versioning = _named(steps, "Resolve next monotonic Android versionCode")
    assert "DRY_RUN" not in versioning.get("env", {})
    assert '--service-account-json "$PLAY_SERVICE_ACCOUNT_PATH"' in versioning["run"]

    build = _named(steps, "Build static export & sync Capacitor Android")
    assert "bootstrap_profiles.sh" not in build["run"]
    assert "use_profile.sh" not in build["run"]
    assert "--platform android" in build["run"]
    assert "APP_RUNTIME_PROFILE" in build["run"]
    assert "NEXT_PUBLIC_APP_ENV" in build["run"]
    runtime = _named(steps, "Verify bundled Android production runtime")
    assert "capacitor.config.json" in runtime["run"]
    assert "hushh-native-runtime-contract.json" in runtime["run"]
    assert 'contract.get("app_env") != "production"' in runtime["run"]
    assert names.index("Verify bundled Android production runtime") < names.index(
        "Compile Android App Bundle (.aab)"
    )
    assert names.index("Compile Android App Bundle (.aab)") < names.index(
        "Verify signed Android App Bundle"
    )
    signature = _named(steps, "Verify signed Android App Bundle")["run"]
    assert "jarsigner -verify -strict" in signature
    assert '-keystore "$ANDROID_KEYSTORE_PATH"' in signature
    assert "-storepass:env ANDROID_KEYSTORE_PASSWORD" in signature
    assert '"$AAB" "$ANDROID_KEY_ALIAS"' in signature

    # The signed AAB goes to the private UAT bucket; Actions keeps only a
    # redacted receipt, never the AAB itself.
    private = _named(steps, "Preserve signed AAB in private UAT bucket")
    assert "if" not in private
    assert private["env"]["RELEASE_SHA"] == "${{ steps.resolve.outputs.sha }}"
    assert "upload-private-native-artifact.py" in private["run"]
    assert "outputs/bundle/release/app-release.aab" in private["run"]
    assert '--source-sha "$RELEASE_SHA"' in private["run"]
    assert "--platform android-playstore" in private["run"]
    receipt = _named(steps, "Upload redacted private AAB receipt")
    assert "${{ steps.resolve.outputs.sha }}" in receipt["with"]["name"]
    assert receipt["with"]["path"].endswith("private-native-artifact-receipt.json")
    assert receipt["with"]["if-no-files-found"] == "error"
    assert not any(
        str(step.get("with", {}).get("path", "")).endswith(".aab")
        for step in steps
        if str(step.get("uses", "")).startswith("actions/upload-artifact")
    )
    assert names.index("Preserve signed AAB in private UAT bucket") < names.index(
        "Upload .aab to Google Play Console"
    )
    upload = _named(steps, "Upload .aab to Google Play Console")
    assert "github.event_name == 'workflow_dispatch'" in upload["if"]
    assert "inputs.dry_run != true" in upload["if"]
    assert upload["with"]["tracks"] == "production"
    assert upload["with"]["status"] == "completed"
    summary = _named(steps, "Publish job summary")
    assert "printf -- '- **Target Track**: `%s`" in summary["run"]
    assert "NEXT_PUBLIC_BACKEND_URL" in summary["run"]
    assert "cat <<EOF" not in summary["run"]


def test_android_dry_run_still_queries_play_for_the_version_floor(tmp_path: Path) -> None:
    steps = _steps(_workflow("ship-android-playstore-v1.yml"), "ship")
    versioning = _named(steps, "Resolve next monotonic Android versionCode")

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

    # The command is checked-in workflow code; all dynamic paths are test-owned.
    subprocess.run(  # noqa: S603
        ["bash", "-e", "-c", versioning["run"]],
        cwd=ROOT,
        env={
            **os.environ,
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
    assert "--service-account-json" in arguments
    assert str(service_account) in arguments
    assert "--update-gradle" in arguments


def test_android_dispatcher_has_no_test_track_or_confirmation_bypass() -> None:
    dispatcher = (ROOT / "scripts/release/dispatch-android-playstore.mjs").read_text(
        encoding="utf-8"
    )
    assert "--track" not in dispatcher
    assert "--yes" not in dispatcher
    assert '"release production"' in dispatcher
    assert '"dry run"' in dispatcher
    assert "workflow_run_id" in dispatcher


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
