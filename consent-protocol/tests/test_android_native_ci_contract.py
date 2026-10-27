"""Android CI and release tooling preserve native compile and source contracts."""

import os
import subprocess
from pathlib import Path

import pathspec
import yaml

ROOT = Path(__file__).resolve().parents[2]


def _jobs():
    return yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]


def test_android_filter_covers_native_contract_and_fixture_changes():
    jobs = _jobs()
    step = next(
        step
        for step in jobs["paths"]["steps"]
        if str(step.get("uses", "")).startswith("dorny/paths-filter")
    )
    patterns = yaml.safe_load(step["with"]["filters"])["android"]
    spec = pathspec.PathSpec.from_lines("gitignore", patterns)
    for path in (
        "hushh-webapp/android/app/src/main/java/com/hussh/app/plugins/HushhAuth/HushhAuthPlugin.kt",
        "hushh-webapp/android/app/src/test/java/com/hussh/app/plugins/HushhAuth/GoogleIdentityReauthenticationFenceTest.kt",
        "hushh-webapp/lib/capacitor/index.ts",
        "hushh-webapp/scripts/native/verify-native-plugin-contracts.mjs",
        "hushh-webapp/__tests__/fixtures/native/google-services.compile-only.json",
        "hushh-webapp/capacitor.config.ts",
        "hushh-webapp/package-lock.json",
        ".github/workflows/ci.yml",
    ):
        assert (ROOT / path).is_file()
        assert spec.match_file(path), path
    assert not spec.match_file("docs/unrelated.md")
    assert "steps.resolve.outputs.android" in jobs["paths"]["outputs"]["android"]
    assert "needs.paths.outputs.android" in jobs["preflight-gate"]["outputs"]["android"]
    assert "outputs.android" in jobs["android-native-check"]["if"]


def test_android_is_a_required_compile_unit_lane_without_release_authority():
    jobs = _jobs()
    lane = jobs["android-native-check"]
    assert "environment" not in lane
    assert "secrets." not in str(lane)
    steps = lane["steps"]
    java = next(step for step in steps if "setup-java" in str(step.get("uses", "")))
    assert str(java["with"]["java-version"]) == "21"
    commands = "\n".join(step.get("run", "") for step in steps)
    assert ":app:testDebugUnitTest --no-daemon" in commands
    assert "google-services.compile-only.json" in commands
    assert "cap update android" in commands
    assert "bundleRelease" not in commands
    assert "connectedAndroidTest" not in commands
    assert "android-native-check" in jobs["ci-status"]["needs"]
    gate = jobs["ci-status"]["steps"][0]["run"]
    assert "needs.paths.outputs.android" in gate
    assert '[ "$ANDROID_NATIVE" != "success" ]' in gate
    assert '"$IOS_NATIVE" "$ANDROID_NATIVE"' in gate


def test_android_dry_run_still_queries_play_for_the_version_floor(tmp_path: Path) -> None:
    workflow = yaml.safe_load(
        (ROOT / ".github/workflows/ship-android-playstore-v1.yml").read_text(encoding="utf-8")
    )
    steps = workflow["jobs"]["ship"]["steps"]
    preserve = next(
        step for step in steps if step.get("name") == "Preserve workflow-owned version resolver"
    )
    versioning = next(
        step for step in steps if step.get("name") == "Resolve next monotonic Android versionCode"
    )
    github_env = tmp_path / "github_env"
    subprocess.run(  # noqa: S603
        ["bash", "-e", "-c", preserve["run"]],
        cwd=ROOT,
        env={**os.environ, "RUNNER_TEMP": str(tmp_path), "GITHUB_ENV": str(github_env)},
        capture_output=True,
        check=True,
        text=True,
    )
    name, resolver_path = github_env.read_text(encoding="utf-8").strip().split("=", 1)
    assert name == "ANDROID_VERSION_RESOLVER_PATH"
    assert (
        Path(resolver_path).read_bytes()
        == (ROOT / "scripts/ci/resolve-android-build-number.py").read_bytes()
    )

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
            "ANDROID_VERSION_RESOLVER_PATH": resolver_path,
        },
        capture_output=True,
        check=True,
        text=True,
    )
    arguments = trace.read_text(encoding="utf-8").splitlines()
    assert arguments[0] == resolver_path
    assert "--service-account-json" in arguments
    assert str(service_account) in arguments
    assert "--update-gradle" in arguments
