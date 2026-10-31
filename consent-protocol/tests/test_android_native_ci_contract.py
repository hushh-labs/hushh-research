"""Android auth bridge edits must compile before the required CI gate succeeds."""

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
