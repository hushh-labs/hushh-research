"""Keep dry-run native artifacts tied to one gated main commit without store upload."""

import hashlib
import json
import os
import plistlib
import re
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


def test_android_release_is_green_main_uat_backed_play_production_and_fail_closed() -> None:
    workflow = _workflow("ship-android-playstore-v1.yml")
    # PyYAML 1.1 treats the unquoted Actions `on` key as a boolean.
    assert set(workflow.get("on", workflow.get(True))) == {"workflow_dispatch"}
    inputs = workflow.get("on", workflow.get(True))["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"sha", "dry_run", "notes"}
    assert workflow["permissions"]["checks"] == "read"
    assert workflow["env"]["GCP_PROJECT_ID"] == "hushh-pda-uat"
    assert workflow["env"]["TARGET_TRACK"] == "production"
    assert workflow["jobs"]["ship"]["environment"] == "uat"
    # Negative control: the lane never reads, authenticates to, or names the
    # production project; the binary is pointed at UAT only.
    raw = (ROOT / ".github/workflows/ship-android-playstore-v1.yml").read_text(encoding="utf-8")
    assert "PROD_" not in raw
    assert not re.search(r"hushh-pda(?!-uat)", raw)

    steps = _steps(workflow, "ship")
    assert all("${{" not in step.get("run", "") for step in steps)
    names = [step["name"] for step in steps]
    assert names.index("Resolve release SHA") < names.index("Check out exact release SHA")
    assert names.index("Check out exact release SHA") < names.index("Assert source SHA")
    assert names.index("Assert source SHA") < names.index(
        "Authenticate to GCP with UAT workload identity"
    )
    assert names.index("Authenticate to GCP with UAT workload identity") < names.index(
        "Verify matching UAT backend revision"
    )
    assert names.index("Verify matching UAT backend revision") < names.index(
        "Materialize UAT frontend contract"
    )
    assert names.index("Verify matching UAT backend revision") < names.index(
        "Build static export & sync Capacitor Android"
    )
    assert names.index("Verify matching UAT backend revision") < names.index(
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
    uat_auth = _named(steps, "Authenticate to GCP with UAT workload identity")
    assert uat_auth["with"]["project_id"] == "${{ env.GCP_PROJECT_ID }}"
    assert (
        uat_auth["with"]["workload_identity_provider"]
        == "${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}"
    )
    scope = _named(steps, "Assert UAT project scope")
    assert 'gcloud config set project "$GCP_PROJECT_ID"' in scope["run"]

    checkout = _named(steps, "Check out exact release SHA")
    assert checkout["with"]["ref"] == "${{ steps.resolve.outputs.sha }}"
    assert "git rev-parse HEAD" in _named(steps, "Assert source SHA")["run"]
    backend = _named(steps, "Verify matching UAT backend revision")
    assert backend["env"]["EXPECTED_SHA"] == "${{ steps.resolve.outputs.sha }}"
    assert "verify-cloudrun-revision-provenance.py" in backend["run"]
    assert '--project "$GCP_PROJECT_ID"' in backend["run"]
    assert "--expected-env uat" in backend["run"]
    assert "--expected-source deploy-uat" in backend["run"]
    assert '--expected-sha "$EXPECTED_SHA"' in backend["run"]

    materialize = _named(steps, "Materialize UAT frontend contract")
    assert 'put APP_RUNTIME_PROFILE "uat"' in materialize["run"]
    assert 'put NEXT_PUBLIC_APP_ENV "uat"' in materialize["run"]
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
    runtime = _named(steps, "Verify bundled Android UAT runtime")
    assert "capacitor.config.json" in runtime["run"]
    assert "hushh-native-runtime-contract.json" in runtime["run"]
    assert names.index("Verify bundled Android UAT runtime") < names.index(
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


UAT_BACKEND = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
PRODUCTION_BACKEND = "https://consent-protocol-1006304528804.us-central1.run.app"


def _run_step(step: dict, *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    # The command is checked-in workflow code; all dynamic paths are test-owned.
    return subprocess.run(  # noqa: S603
        ["bash", "-e", "-c", step["run"]],
        cwd=cwd,
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        check=False,
    )


def test_android_uat_contract_refuses_every_non_uat_backend(tmp_path: Path) -> None:
    step = _named(
        _steps(_workflow("ship-android-playstore-v1.yml"), "ship"),
        "Materialize UAT frontend contract",
    )
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    for name in (
        "NEXT_PUBLIC_FIREBASE_API_KEY",
        "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
        "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
        "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
        "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
        "NEXT_PUBLIC_FIREBASE_APP_ID",
        "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
    ):
        (secrets / name).write_text("test-value", encoding="utf-8")
    gcloud = tmp_path / "bin/gcloud"
    gcloud.parent.mkdir()
    gcloud.write_text(
        '#!/bin/sh\nfor a in "$@"; do case "$a" in --secret=*) n="${a#--secret=}";; esac; done\n'
        'cat "$FAKE_SECRETS/$n" 2>/dev/null || exit 1\n',
        encoding="utf-8",
    )
    gcloud.chmod(0o700)

    def run(backend_url: str, app_origin: str = "https://uat.one.hushh.ai"):
        (secrets / "BACKEND_URL").write_text(backend_url, encoding="utf-8")
        (secrets / "APP_FRONTEND_ORIGIN").write_text(app_origin, encoding="utf-8")
        github_env = tmp_path / "github_env"
        github_env.write_text("", encoding="utf-8")
        result = _run_step(
            step,
            cwd=tmp_path,
            env={
                "PATH": f"{gcloud.parent}:{os.environ['PATH']}",
                "FAKE_SECRETS": str(secrets),
                "GCP_PROJECT_ID": "hushh-pda-uat",
                "GITHUB_ENV": str(github_env),
            },
        )
        return result, github_env.read_text(encoding="utf-8")

    accepted, exported = run(UAT_BACKEND)
    assert accepted.returncode == 0, accepted.stderr
    assert "APP_RUNTIME_PROFILE=uat\n" in exported
    assert "NEXT_PUBLIC_APP_ENV=uat\n" in exported
    assert f"NEXT_PUBLIC_BACKEND_URL={UAT_BACKEND}\n" in exported

    for refused in (
        PRODUCTION_BACKEND,
        "https://api.hushh.ai",
        UAT_BACKEND.replace("https:", "http:"),
        "https://localhost:8000",
        "https://10.0.2.2:8000",
    ):
        result, exported = run(refused)
        assert result.returncode != 0, refused
        assert "NEXT_PUBLIC_BACKEND_URL" not in exported, refused
    result, _ = run(UAT_BACKEND, app_origin="http://uat.one.hushh.ai")
    assert result.returncode != 0


def test_android_bundle_verifier_accepts_only_a_uat_bundle(tmp_path: Path) -> None:
    step = _named(
        _steps(_workflow("ship-android-playstore-v1.yml"), "ship"),
        "Verify bundled Android UAT runtime",
    )

    def bundle(*, origin: str, app_env: str, plugin_url: str) -> None:
        assets = tmp_path / "hushh-webapp/android/app/src/main/assets"
        (assets / "public").mkdir(parents=True, exist_ok=True)
        (assets / "capacitor.config.json").write_text(
            json.dumps({"plugins": {"Hushh": {"backendUrl": plugin_url}}}), encoding="utf-8"
        )
        contract = {
            "schema_version": 1,
            "backend_origin": origin,
            "app_env": app_env,
            "plaid_sandbox_proof": False,
            "dist_dir": ".next-native-android",
        }
        contract["bundle_attestation"] = hashlib.sha256(
            json.dumps(contract, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        (assets / "public/hushh-native-runtime-contract.json").write_text(
            json.dumps(contract), encoding="utf-8"
        )

    def verify(expected_url: str) -> subprocess.CompletedProcess:
        return _run_step(step, cwd=tmp_path, env={"NEXT_PUBLIC_BACKEND_URL": expected_url})

    bundle(origin=UAT_BACKEND, app_env="uat", plugin_url=UAT_BACKEND)
    assert verify(UAT_BACKEND).returncode == 0

    # Each of these must fail; any one passing would let a non-UAT binary be signed.
    bundle(origin=PRODUCTION_BACKEND, app_env="production", plugin_url=PRODUCTION_BACKEND)
    assert verify(PRODUCTION_BACKEND).returncode != 0
    bundle(origin=UAT_BACKEND, app_env="production", plugin_url=UAT_BACKEND)
    assert verify(UAT_BACKEND).returncode != 0
    bundle(origin=UAT_BACKEND, app_env="uat", plugin_url=PRODUCTION_BACKEND)
    assert verify(UAT_BACKEND).returncode != 0
    bundle(origin=PRODUCTION_BACKEND, app_env="uat", plugin_url=UAT_BACKEND)
    assert verify(UAT_BACKEND).returncode != 0
    # Internally consistent but pointed at production while claiming `uat`: only
    # the UAT-host requirement stops this one.
    bundle(origin=PRODUCTION_BACKEND, app_env="uat", plugin_url=PRODUCTION_BACKEND)
    assert verify(PRODUCTION_BACKEND).returncode != 0


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
