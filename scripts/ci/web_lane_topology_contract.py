"""Pure assertions for the required split web and database CI topology."""

from collections.abc import Mapping
import re


def _job_block(workflow: str, job: str) -> str:
    start = workflow.index(f"  {job}:\n")
    following = re.search(r"\n  [a-z][a-z0-9-]*:\n", workflow[start + 1 :])
    end = start + 1 + following.start() if following else len(workflow)
    return workflow[start:end]


def _assert_job_name(block: str, name: str) -> None:
    assert f'    name: "{name}"' in block, f"job name must be {name}"


def _assert_targeted_pair(workflow: str, playwright: str) -> None:
    node = _job_block(workflow, "web-targeted-check")
    browser = _job_block(workflow, "web-targeted-browser")
    _assert_job_name(node, "Web Targeted Contracts (node)")
    _assert_job_name(browser, "Web Targeted Contracts (browser)")
    assert "WEB_TARGETED_PART: node" in node
    assert "WEB_TARGETED_PART: browser" in browser
    assert "PLAYWRIGHT_SHARD: \"\"" in node
    assert "PLAYWRIGHT_SHARD: \"\"" in browser
    assert "strategy:" not in node and "strategy:" not in browser
    assert "steps: &web_targeted_steps" in node
    assert "steps: *web_targeted_steps" in browser
    steps = node.split("      - name: Run targeted web contract checks\n", 1)[1]
    execution = steps.split("\n      - name:", 1)[0]
    assert execution.count("PLAYWRIGHT_SHARD:") == 1, (
        "duplicate PLAYWRIGHT_SHARD environment key"
    )
    assert "WEB_TARGETED_PART: ${{ env.WEB_TARGETED_PART }}" in execution
    assert "PLAYWRIGHT_SHARD: ${{ env.PLAYWRIGHT_SHARD }}" in execution
    assert (
        "PLAYWRIGHT_LINE_REPORTER: ${{ env.WEB_TARGETED_PART == 'browser' && '1' || '0' }}"
        in execution
    )
    assert 'process.env.PLAYWRIGHT_LINE_REPORTER === "1"' in playwright
    assert '[["github"], ["line"]]' in playwright
    assert (
        "env.WEB_TARGETED_PART == 'browser' && steps.browser-plan.outputs.browser_required != 'false'"
        in node
    )
    assert (
        "env.WEB_TARGETED_PART == 'node' || steps.browser-plan.outputs.browser_required != 'false'"
        in node
    )
    assert "name: synthetic-layout-failures-${{ env.WEB_TARGETED_LABEL }}" in node
    assert "timeout-minutes: 40" in node
    assert "timeout-minutes: 40" in browser
    assert "PLAYWRIGHT_SHARD: ${{ matrix.shard }}" not in node + browser


def _assert_unit_job(workflow: str) -> None:
    unit = _job_block(workflow, "web-full-suite-check")
    _assert_job_name(unit, "Web Unit Contracts")
    assert "strategy:" not in unit
    assert "WEB_FULL_SUITE_SHARD: \"\"" in unit
    assert "run: bash scripts/ci/orchestrate.sh web-full-suite" in unit
    assert "WEB_FULL_SUITE_SHARD: ${{ matrix.shard }}" not in unit


def _assert_database_pair(workflow: str) -> None:
    first = _job_block(workflow, "protocol-database-check")
    second = _job_block(workflow, "protocol-database-check-two")
    _assert_job_name(first, "Protocol Database (1/2)")
    _assert_job_name(second, "Protocol Database (2/2)")
    assert 'CI_DATABASE_SHARD: "1"' in first
    assert 'CI_DATABASE_SHARD: "2"' in second
    assert "strategy:" not in first and "strategy:" not in second
    assert "PROTOCOL_TEST_PARTITION: database" in first
    assert 'PROTOCOL_DATABASE_SHARD_COUNT: "2"' in first
    assert "run: bash scripts/run-test-ci.sh" in first
    assert "services: *database_services" in second
    assert "steps: *database_steps" in second


def _assert_status_gate(workflow: str) -> None:
    gate = _job_block(workflow, "ci-status")
    required_jobs = (
        "web-targeted-check",
        "web-targeted-browser",
        "web-full-suite-check",
        "protocol-database-check",
        "protocol-database-check-two",
        "document-webkit-check",
    )
    needs = gate.split("    needs:\n", 1)[1].split("\n    if:", 1)[0]
    for job in required_jobs:
        assert f"- {job}" in needs, f"ci-status must need {job}"
    assert "WEB_BROWSER=\"${{ needs['web-targeted-browser'].result }}\"" in gate
    assert 'WEB_TARGETED="${{ needs[\'web-targeted-check\'].result }}"' in gate
    assert 'WEB_FULL_SUITE="${{ needs[\'web-full-suite-check\'].result }}"' in gate
    assert 'PROTOCOL_DATABASE="${{ needs[\'protocol-database-check\'].result }}"' in gate
    assert (
        "PROTOCOL_DATABASE_TWO=\"${{ needs['protocol-database-check-two'].result }}\""
        in gate
    )
    assert (
        'if [ "$FRONTEND_SELECTED" = true ] && [ "$WEB_BROWSER" != success ]; then fail=1; fi'
        in gate
    )
    assert (
        'if [ "${{ needs[\'preflight-gate\'].outputs.frontend }}" = "true" ] && [ "$WEB_TARGETED" != "success" ]; then'
        in gate
    )
    assert (
        'if [ "${{ needs[\'preflight-gate\'].outputs.frontend }}" = "true" ] && [ "$WEB_FULL_SUITE" != "success" ]; then'
        in gate
    )
    assert (
        'if [ "${{ needs[\'preflight-gate\'].outputs.backend }}" = "true" ] && [ "$PROTOCOL_DATABASE" != "success" ]; then'
        in gate
    )
    assert (
        'if [ "$BACKEND_SELECTED" = true ] && [ "$PROTOCOL_DATABASE_TWO" != success ]; then fail=1; fi'
        in gate
    )
    assert not re.search(r"^  web-editor-performance-check:$", workflow, re.M)
    assert "WEB_EDITOR_PERF" not in gate
    document = _job_block(workflow, "document-webkit-check")
    assert 'name: "Protected Document WebKit (macOS)"' in document
    assert "--ci-macos-webkit" in document and "test:layout-editor-performance" not in document
    assert '"$DOCUMENT_WEBKIT" != success' in gate


def assert_web_lane_topology(
    workflow: str, scripts: Mapping[str, str], playwright: str
) -> None:
    job_ids = re.findall(r"^  ([a-z][a-z0-9-]*):$", workflow, re.M)
    assert len(job_ids) == len(set(job_ids)), "CI workflow has duplicate job IDs"
    _assert_targeted_pair(workflow, playwright)
    _assert_unit_job(workflow)
    _assert_database_pair(workflow)
    _assert_status_gate(workflow)
    assert "test:layout-editor-performance" not in scripts["test:layout-contracts"]
