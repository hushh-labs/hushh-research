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


def _assert_targeted_node(workflow: str) -> None:
    node = _job_block(workflow, "web-targeted-check")
    _assert_job_name(node, "Web Targeted Contracts (node)")
    assert "WEB_TARGETED_PART: node" in node
    assert "run: bash scripts/ci/orchestrate.sh web-targeted" in node
    assert "playwright install" not in workflow
    assert "web-targeted-browser:" not in workflow
    assert "document-webkit-check:" not in workflow
    assert "WEB_BROWSER" not in workflow and "DOCUMENT_WEBKIT" not in workflow
    assert "run: bash scripts/ci/integration-check.sh --ci-core" in workflow


def _assert_unit_job(workflow: str) -> None:
    unit = _job_block(workflow, "web-full-suite-check")
    _assert_job_name(unit, "Web Unit Contracts")
    assert "fail-fast: false" in unit and "max-parallel: 3" in unit
    assert "needs: [preflight-gate, repo-governance]" in unit
    assert "fromJSON(needs.repo-governance.outputs.unit_matrix" in unit
    assert "WEB_FULL_SUITE_SHARD: ${{ matrix.shard }}" in unit
    assert "run: bash scripts/ci/orchestrate.sh web-full-suite" in unit
    for shard in ("1/1", "1/3", "2/3", "3/3"):
        assert f"name: Verify unit shard ({shard})" in unit
        assert f"if: matrix.shard == '{shard}'" in unit
    governance = _job_block(workflow, "repo-governance")
    assert "unit_matrix: ${{ steps.unit-plan.outputs.matrix }}" in governance
    assert "affected-tests.mjs unit-matrix" in governance
    assert 'CI_ACCOUNT_DELETION_CLIENT_OWNED: "1"' in governance


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
        "web-full-suite-check",
        "protocol-database-check",
        "protocol-database-check-two",
    )
    needs = gate.split("    needs:\n", 1)[1].split("\n    if:", 1)[0]
    for job in required_jobs:
        assert f"- {job}" in needs, f"ci-status must need {job}"
    assert 'WEB_TARGETED="${{ needs[\'web-targeted-check\'].result }}"' in gate
    assert 'WEB_FULL_SUITE="${{ needs[\'web-full-suite-check\'].result }}"' in gate
    assert 'PROTOCOL_DATABASE="${{ needs[\'protocol-database-check\'].result }}"' in gate
    assert (
        "PROTOCOL_DATABASE_TWO=\"${{ needs['protocol-database-check-two'].result }}\""
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


def assert_web_lane_topology(
    workflow: str, scripts: Mapping[str, str], playwright: str
) -> None:
    job_ids = re.findall(r"^  ([a-z][a-z0-9-]*):$", workflow, re.M)
    assert len(job_ids) == len(set(job_ids)), "CI workflow has duplicate job IDs"
    _assert_targeted_node(workflow)
    _assert_unit_job(workflow)
    _assert_database_pair(workflow)
    _assert_status_gate(workflow)
    assert "test:layout-editor-performance" not in scripts["test:layout-contracts"]
