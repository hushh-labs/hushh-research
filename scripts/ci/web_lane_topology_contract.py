"""Pure CI topology assertions shared by the existing lane-partition gate."""
from collections.abc import Mapping
import re

def _job_block(workflow: str, job: str, next_job: str) -> str:
    start = workflow.index(f"  {job}:\n")
    end = workflow.index(f"\n  {next_job}:\n", start)
    return workflow[start:end]


def assert_web_lane_topology(workflow: str, scripts: Mapping[str, str], playwright: str) -> None:

    job_ids = re.findall(r"^  ([a-z][a-z0-9-]*):$", workflow, re.M)
    assert len(job_ids) == len(set(job_ids)), "CI workflow has duplicate job IDs"

    targeted = _job_block(workflow, "web-targeted-check", "web-full-suite-check")
    entries = re.findall(
        r'- part: (node|browser)\n\s+label: ([\w-]+)\n\s+shard: "([^"]*)"', targeted
    )
    assert [(part, shard) for part, _, shard in entries] == [
        ("node", ""), ("browser", "1/4"), ("browser", "2/4"),
        ("browser", "3/4"), ("browser", "4/4")
    ], "run node once and all four browser shards"
    assert len({label for _, label, _ in entries}) == 5, "matrix names must be unique"
    assert 'name: "Web Targeted Contracts (${{ matrix.label }})"' in targeted
    assert "name: web-targeted-npm-audit-report-${{ matrix.label }}" in targeted
    assert "WEB_TARGETED_PART: ${{ matrix.part }}" in targeted
    assert "PLAYWRIGHT_SHARD: ${{ matrix.shard }}" in targeted
    assert 'process.env.PLAYWRIGHT_LINE_REPORTER === "1"' in playwright
    assert '[["github"], ["line"]]' in playwright
    execution = targeted.split("      - name: Run targeted web contract checks\n", 1)[1].split("\n      - name:", 1)[0]
    assert execution.count("PLAYWRIGHT_SHARD:") == 1, "duplicate PLAYWRIGHT_SHARD environment key"
    assert (
        "PLAYWRIGHT_LINE_REPORTER: ${{ matrix.part == 'browser' && '1' || '0' }}"
        in execution
    )
    assert "timeout-minutes: ${{ matrix.part == 'browser' && 40 || 30 }}" in targeted
    assert "fail-fast: false" in targeted

    editor_perf = _job_block(
        workflow, "web-editor-performance-check", "web-full-suite-check"
    )
    assert "runs-on: macos-15" in editor_perf
    assert "npm run test:layout-editor-performance" in editor_perf
    assert "test:layout-editor-performance" not in scripts["test:layout-contracts"]
    # Absolute motion timing remains mandatory on macOS in both engines;
    # Linux keeps the companion semantic/geometry case, not a disabled test.
    motion = scripts["test:layout-editor-performance"]
    assert "e2e/history-motion.layout.spec.ts" in motion
    assert "100 KB paste|@motion-performance" in motion
    assert "--project=chromium --project=webkit" in motion
    assert "--workers=1" in motion
    assert r"/history-motion\.layout\.spec\.ts/" in playwright
    assert "e2e/history-motion.layout.spec.ts" not in scripts["test:connections-layout"]

    full = _job_block(workflow, "web-full-suite-check", "ios-native-check")
    shards = re.search(r"shard: \[([0-9, ]+)\]", full)
    assert shards, "web-full-suite-check has no shard matrix"
    indexes = [int(value) for value in shards.group(1).split(",")]
    count = len(indexes)
    assert indexes == list(range(1, count + 1)), f"shards must be 1..N, got {indexes}"
    assert f"WEB_FULL_SUITE_SHARD: ${{{{ matrix.shard }}}}/{count}" in full
    assert f'${{{{ matrix.shard }}}}/{count}"' in full, (
        "the job name must show the shard count"
    )
    assert "fail-fast: false" in full

    gate = workflow[workflow.index("  ci-status:") :]
    assert '[ "$WEB_FULL_SUITE" != "success" ]' in gate
    assert "WEB_TARGETED=\"${{ needs['web-targeted-check'].result }}\"" in gate
    assert '[ "$WEB_TARGETED" != "success" ]' in gate
    assert (
        "WEB_EDITOR_PERF=\"${{ needs['web-editor-performance-check'].result }}\""
        in gate
    )
    assert '[ "$WEB_EDITOR_PERF" != "success" ]' in gate

