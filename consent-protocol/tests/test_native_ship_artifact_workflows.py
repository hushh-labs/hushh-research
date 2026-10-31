"""Keep dry-run native artifacts tied to one gated main commit without store upload."""

import hashlib
import json
import os
import plistlib
import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


SECURITY_STEP = "Require current-attempt deployment security"
FROZEN_REQUEST_SHA = "${{ inputs.sha || needs.deployment-security.outputs.application_sha }}"


def _workflow(name: str) -> dict:
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text(encoding="utf-8"))


def _steps(workflow: dict, job: str) -> list[dict]:
    return workflow["jobs"][job]["steps"]


def _named(steps: list[dict], name: str) -> dict:
    return next(step for step in steps if step.get("name") == name)


@pytest.mark.parametrize(
    ("workflow_name", "environment_name"),
    [("ship-ios-testflight.yml", "uat"), ("release-ios-appstore.yml", "production")],
)
def test_native_jobs_read_environment_configuration_without_hosted_deployment_records(
    workflow_name: str, environment_name: str
) -> None:
    jobs = _workflow(workflow_name)["jobs"]
    environments = [job["environment"] for job in jobs.values() if "environment" in job]
    assert len(environments) == 3
    assert all(
        environment == {"name": environment_name, "deployment": False}
        for environment in environments
    )


def test_android_release_is_green_main_uat_backed_and_fail_closed() -> None:
    workflow = _workflow("ship-android-playstore-v1.yml")
    # PyYAML 1.1 treats the unquoted Actions `on` key as a boolean.
    assert set(workflow.get("on", workflow.get(True))) == {"workflow_dispatch"}
    inputs = workflow.get("on", workflow.get(True))["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"track", "sha", "dry_run", "notes"}
    assert inputs["track"]["type"] == "choice"
    assert inputs["track"]["default"] == "internal"
    assert set(inputs["track"]["options"]) == {"internal", "production"}
    assert workflow["permissions"]["checks"] == "read"
    assert workflow["env"]["GCP_PROJECT_ID"] == "hushh-pda-uat"
    assert workflow["env"]["TARGET_TRACK"] == "${{ inputs.track }}"
    assert workflow["jobs"]["ship"]["environment"] == "uat"
    # Negative control: the lane never reads, authenticates to, or names the
    # production project; the binary is pointed at UAT only.
    raw = (ROOT / ".github/workflows/ship-android-playstore-v1.yml").read_text(encoding="utf-8")
    assert "PROD_" not in raw
    assert not re.search(r"hushh-pda(?!-uat)", raw)

    steps = _steps(workflow, "ship")
    assert all("${{" not in step.get("run", "") for step in steps)
    names = [step["name"] for step in steps]
    assert names[:2] == [SECURITY_STEP, "Validate target track"]
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
    assert resolve["env"]["REQUESTED_SHA"] == FROZEN_REQUEST_SHA
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
    assert upload["with"]["tracks"] == "${{ env.TARGET_TRACK }}"
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


def test_android_release_refuses_unsupported_tracks_before_any_upload(tmp_path: Path) -> None:
    step = _named(
        _steps(_workflow("ship-android-playstore-v1.yml"), "ship"),
        "Validate target track",
    )
    assert step["env"]["DRY_RUN"] == "${{ inputs.dry_run }}"
    for track, dry_run in (("internal", "false"), ("internal", "true"), ("production", "true")):
        result = _run_step(step, cwd=tmp_path, env={"TARGET_TRACK": track, "DRY_RUN": dry_run})
        assert result.returncode == 0, result.stderr
    for dry_run in ("false", "", "TRUE"):
        result = _run_step(
            step, cwd=tmp_path, env={"TARGET_TRACK": "production", "DRY_RUN": dry_run}
        )
        assert result.returncode != 0
        assert "Public Android upload is blocked" in result.stderr
    for track in ("", "alpha", "beta", "production,internal", "internal; echo unsafe"):
        result = _run_step(step, cwd=tmp_path, env={"TARGET_TRACK": track})
        assert result.returncode != 0
        assert "Refusing unsupported Google Play track" in result.stderr


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
    assert "NEXT_PUBLIC_PASSKEY_RP_ID=uat.one.hushh.ai\n" in exported
    assert "NEXT_PUBLIC_PASSKEY_RP_ID=one.hushh.ai\n" not in exported

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


def test_android_dispatcher_binds_selected_track_without_confirmation_bypass() -> None:
    dispatcher = (ROOT / "scripts/release/dispatch-android-playstore.mjs").read_text(
        encoding="utf-8"
    )
    assert "--track" in dispatcher
    assert 'track: "internal"' in dispatcher
    assert '["internal", "production"]' in dispatcher
    assert "track: options.track" in dispatcher
    assert "--yes" not in dispatcher
    assert "`release ${options.track}`" in dispatcher
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
    # The shared exporter owns verified export -> optional Xcode upload.
    # Its behavioral dry-run/failure gates live in test_ios_uat_passkey_config.py.
    assert "python3 scripts/ci/export-ios-distribution.py" in export["run"]
    assert '--dry-run "${{ inputs.dry_run }}"' in export["run"]
    assert '--archive "$RUNNER_TEMP/App.xcarchive"' in export["run"]
    assert '--export-path "$RUNNER_TEMP/export"' in export["run"]
    assert "--options hushh-webapp/ios/ExportOptions/AppStoreConnect.plist" in export["run"]
    assert '--p8-path "$RUNNER_TEMP/asc.p8"' in export["run"]
    signing = _named(steps, "Create signing keychain")
    assert "APPSTORE_DISTRIBUTION_CERT_P12_B64" in signing["run"]
    assert "security import" in signing["run"]
    export_options = plistlib.loads(
        (ROOT / "hushh-webapp/ios/ExportOptions/AppStoreConnect.plist").read_bytes()
    )
    assert export_options["destination"] == "upload"
    assert export_options["method"] == "app-store-connect"
    assert export_options["signingStyle"] == "automatic"
    ipa = _named(steps, "Preserve dry-run UAT IPA in private bucket")
    assert "inputs.dry_run == true" in ipa["if"]
    assert ipa["env"]["RELEASE_SHA"] == "${{ needs.preflight.outputs.release_sha }}"
    assert 'test "${#ipa_files[@]}" -eq 1' in ipa["run"]
    assert "scripts/ci/upload-private-native-artifact.py" in ipa["run"]
    assert '--file "${ipa_files[0]}"' in ipa["run"]
    assert '--source-sha "$RELEASE_SHA"' in ipa["run"]
    assert '--run-id "$GITHUB_RUN_ID"' in ipa["run"]
    receipt = _named(steps, "Upload redacted private IPA receipt")
    assert "inputs.dry_run == true" in receipt["if"]
    assert "steps.private_artifact.outcome == 'success'" in receipt["if"]
    assert receipt["with"]["path"] == "${{ runner.temp }}/private-native-artifact-receipt.json"
    assert receipt["with"]["if-no-files-found"] == "error"
    assert "${{ needs.preflight.outputs.release_sha }}" in receipt["with"]["name"]
    for step in steps:
        if str(step.get("uses", "")).startswith("actions/upload-artifact"):
            assert ".ipa" not in str(step.get("with", {}).get("path", ""))

    for name in (
        "Preserve uploaded build identity for recovery",
        "Upload recovery receipt before Apple processing",
    ):
        assert "inputs.dry_run != true" in _named(steps, name)["if"]
    distribution = workflow["jobs"]["distribute"]
    assert distribution["runs-on"] == "ubuntu-latest"
    assert distribution["needs"] == ["preflight", "ship", "deployment-security"]
    assert "needs.ship.result == 'success'" in distribution["if"]
    assert "inputs.dry_run != true" in distribution["if"]
    for name in (
        "Wait for valid TestFlight processing",
        "Attach the same valid build to both TestFlight groups",
        "Upload redacted release evidence",
    ):
        assert "inputs.dry_run != true" in _named(distribution["steps"], name)["if"]


@pytest.mark.parametrize("requested,expected", [("", "1.4.0"), ("1.4.1", "1.4.1")])
def test_appstore_packaging_version_resolves_from_exact_source_or_override(
    tmp_path: Path, requested: str, expected: str
) -> None:
    project = tmp_path / "project.pbxproj"
    project.write_text("MARKETING_VERSION = 1.4.0;", encoding="utf-8")
    output = tmp_path / "env"
    step = _named(
        _steps(_workflow("release-ios-appstore.yml"), "release"),
        "Resolve App Store marketing version",
    )
    result = _run_step(
        step,
        cwd=tmp_path,
        env={
            "PBXPROJ": str(project),
            "GITHUB_ENV": str(output),
            "REQUESTED_MARKETING_VERSION": requested,
        },
    )
    assert result.returncode == 0, result.stderr
    assert output.read_text() == f"IOS_MARKETING_VERSION={expected}\n"
    assert project.read_text() == "MARKETING_VERSION = 1.4.0;"


@pytest.mark.parametrize(
    "requested", ["1.4", "01.4.1", "1.4.1-beta", "1.4.1\nINJECTED=true", "$(touch injected)"]
)
def test_appstore_packaging_version_rejects_invalid_input_before_build(
    tmp_path: Path, requested: str
) -> None:
    project = tmp_path / "project.pbxproj"
    project.write_text("MARKETING_VERSION = 1.4.0;", encoding="utf-8")
    output = tmp_path / "env"
    step = _named(
        _steps(_workflow("release-ios-appstore.yml"), "release"),
        "Resolve App Store marketing version",
    )
    result = _run_step(
        step,
        cwd=tmp_path,
        env={
            "PBXPROJ": str(project),
            "GITHUB_ENV": str(output),
            "REQUESTED_MARKETING_VERSION": requested,
        },
    )
    assert result.returncode != 0
    assert not output.exists()
    assert not (tmp_path / "injected").exists()


@pytest.mark.parametrize(
    "wrong_target,wrong_key",
    [
        (None, None),
        ("app", "CFBundleShortVersionString"),
        ("app", "CFBundleVersion"),
        ("extension", "CFBundleShortVersionString"),
        ("extension", "CFBundleVersion"),
    ],
)
def test_appstore_archive_checks_actual_app_and_extension_versions(
    tmp_path: Path, wrong_target: str | None, wrong_key: str | None
) -> None:
    app = tmp_path / "App.xcarchive/Products/Applications/App.app"
    paths = {"app": app / "Info.plist", "extension": app / "PlugIns/Chat.appex/Info.plist"}
    for target, path in paths.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        info = {"CFBundleShortVersionString": "1.4.1", "CFBundleVersion": "144"}
        if target == wrong_target:
            info[wrong_key] = "1.4.0" if wrong_key == "CFBundleShortVersionString" else "143"
        path.write_bytes(plistlib.dumps(info))
    step = _named(
        _steps(_workflow("release-ios-appstore.yml"), "release"),
        "Verify archived app and extension versions",
    )
    result = _run_step(
        step,
        cwd=tmp_path,
        env={
            "RUNNER_TEMP": str(tmp_path),
            "IOS_MARKETING_VERSION": "1.4.1",
            "EXPECTED_BUILD_NUMBER": "144",
        },
    )
    assert (result.returncode == 0) == (wrong_target is None), result.stderr


def test_appstore_upload_receipt_keeps_source_with_effective_packaging_version(
    tmp_path: Path,
) -> None:
    steps = _steps(_workflow("release-ios-appstore.yml"), "release")
    step = _named(steps, "Preserve uploaded build identity for TestFlight distribution")
    result = _run_step(
        step,
        cwd=ROOT,
        env={
            "RUNNER_TEMP": str(tmp_path),
            "IOS_MARKETING_VERSION": "1.4.1",
            "BUILD_NUMBER": "144",
            "IOS_BUNDLE_ID": "com.hushh.app",
            "BACKEND_TARGET": "production",
        },
    )
    assert result.returncode == 0, result.stderr
    receipt = json.loads((tmp_path / "testflight-upload-receipt.json").read_text())
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()  # noqa: S603
    assert receipt == {
        "source_sha": source,
        "build_number": "144",
        "marketing_version": "1.4.1",
        "bundle_id": "com.hushh.app",
        "backend_target": "production",
    }
    assert (
        'MARKETING_VERSION="${IOS_MARKETING_VERSION}"'
        in _named(steps, "Archive with target-owned automatic signing")["run"]
    )
    assert (
        '--marketing-version "${IOS_MARKETING_VERSION}"'
        in _named(
            _steps(_workflow("release-ios-appstore.yml"), "prepare"),
            "Prepare App Store version (set What's New, attach build; one-click submit)",
        )["run"]
    )


def test_production_archive_overlaps_deploy_but_upload_joins_exact_healthy_release() -> None:
    workflow = _workflow("release-ios-appstore.yml")
    assert workflow["jobs"]["preflight"]["runs-on"] == "ubuntu-latest"
    assert workflow["jobs"]["release"]["needs"] == ["preflight", "deployment-security"]
    assert workflow["jobs"]["release"]["if"] == "needs.preflight.outputs.ready == 'true'"
    assert workflow["jobs"]["preflight"]["outputs"]["ready"] == "${{ 'true' }}"
    assert all(
        "Admit automatic App Store" not in step.get("name", "")
        for step in _steps(workflow, "preflight")
    )
    steps = _steps(workflow, "release")
    names = [step.get("name") for step in steps]
    archive = names.index("Archive with target-owned automatic signing")
    join = names.index("Join the exact parallel production deployment")
    provenance = names.index("Verify matching production backend revision")
    upload = names.index("Export & upload to App Store Connect")
    assert archive < join < provenance < upload
    assert workflow["permissions"]["actions"] == "read"
    join_step = _named(steps, "Join the exact parallel production deployment")
    assert join_step["env"]["PRODUCTION_DEPLOY_RUN_ID"] == "${{ inputs.production_deploy_run_id }}"
    assert (
        'wait-production --run-id "$PRODUCTION_DEPLOY_RUN_ID" --sha "$RELEASE_SHA"'
        in join_step["run"]
    )
    prepare = workflow["jobs"]["prepare"]
    assert prepare["runs-on"] == "ubuntu-latest"
    assert prepare["needs"] == ["release", "deployment-security"]
    assert "needs.release.result == 'success'" in prepare["if"]
    assert "inputs.dry_run != true" in prepare["if"]
    submission = _named(
        prepare["steps"],
        "Prepare App Store version (set What's New, attach build; one-click submit)",
    )
    assert "github.event.inputs.submit_for_review" in submission["run"]
    assert "SUBMIT_ARGS+=(--submit)" in submission["run"]
    assert "Public App Store submission" in submission["run"]
    assert "cadence_origin" not in (ROOT / ".github/workflows/release-ios-appstore.yml").read_text()
    testflight = _workflow("ship-ios-testflight.yml")
    assert workflow["jobs"]["release"]["concurrency"] == testflight["jobs"]["ship"]["concurrency"]
    assert workflow["jobs"]["release"]["concurrency"]["group"] == "ios-build-and-upload"
    uat = _workflow("deploy-uat.yml")
    assert "release" not in uat["jobs"] and "cadence" not in uat["jobs"]
    assert uat["jobs"]["deploy"]["concurrency"]["group"] == "deploy-uat"
