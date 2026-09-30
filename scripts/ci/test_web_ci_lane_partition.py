#!/usr/bin/env python3
"""The split web lanes must still run everything the unsplit lanes ran.

PR Validation runs two web lanes as matrices to shorten the critical path:

* ``Web Targeted Contracts`` as a ``node`` leg and a ``browser`` leg
  (``WEB_TARGETED_PART``), and
* ``Web Full Suite (Vitest)`` as Vitest shards (``WEB_FULL_SUITE_SHARD``).
* 100 KB editor latency as a required macOS browser job, outside Linux's
  software-rendered WebKit layout pack.

A split is only safe while it is a partition: every matched pack runs in exactly
one leg, the legs together run what a single ``all`` run does, every shard of
the matrix is scheduled, and the contract verifiers run exactly once. This
drives the real scripts with a stub ``npm`` that records what would have run,
so the assertion is about the scripts' behaviour, not about their text.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
TARGETED = ROOT / "scripts/ci/web-targeted-check.sh"
FULL_SUITE = ROOT / "scripts/ci/web-full-suite-check.sh"
PACKAGE_JSON = ROOT / "hushh-webapp/package.json"

STUB_NPM = """#!/usr/bin/env bash
if [ "${1:-}" = "run" ]; then
  printf '%s\\n' "$*" >> "$NPM_STUB_LOG"
fi
exit 0
"""


def _job_block(workflow: str, job: str, next_job: str) -> str:
    start = workflow.index(f"  {job}:\n")
    end = workflow.index(f"\n  {next_job}:\n", start)
    return workflow[start:end]


def _run(script: Path, env_overrides: dict[str, str]) -> tuple[int, list[str], str]:
    with tempfile.TemporaryDirectory() as tmp:
        stub_dir = Path(tmp) / "bin"
        stub_dir.mkdir()
        npm = stub_dir / "npm"
        npm.write_text(STUB_NPM, encoding="utf-8")
        npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
        log = Path(tmp) / "npm.log"
        log.touch()
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{stub_dir}{os.pathsep}{env['PATH']}",
                "NPM_STUB_LOG": str(log),
                "WEB_CI_DEPS_INSTALLED": "1",
                "HUSHH_WEB_TEST_MAX_WORKERS": "2",
            }
        )
        env.update(env_overrides)
        proc = subprocess.run(
            ["bash", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        calls = [line for line in log.read_text(encoding="utf-8").splitlines() if line]
        return proc.returncode, calls, proc.stdout + proc.stderr


def _one_matching_file_per_pack() -> str:
    """A changed-file list that schedules every pack whose paths exist today."""

    tracked = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    patterns = re.findall(r"has_match '([^']+)'", TARGETED.read_text(encoding="utf-8"))
    assert patterns, "web-targeted-check.sh has no has_match packs"
    chosen: list[str] = []
    for pattern in patterns:
        # Mermaid rendering is a direct browser command, outside run_check's
        # npm packs. Exercise its leg separately below without Chromium here.
        if "render-doc-mermaid" in pattern:
            continue
        regex = re.compile(pattern)
        hit = next((path for path in tracked if regex.search(path)), None)
        if hit is not None:
            chosen.append(hit)
    return "\n".join(sorted(set(chosen)))


def _reaches_playwright(script: str, scripts: dict[str, str], seen: set[str]) -> bool:
    if script in seen or script not in scripts:
        return False
    seen.add(script)
    body = scripts[script]
    if re.search(r"\bplaywright\b", body):
        return True
    return any(
        _reaches_playwright(ref, scripts, seen) for ref in re.findall(r"npm run ([\w:.-]+)", body)
    )


def test_targeted_legs_partition_the_matched_packs() -> None:
    changed = _one_matching_file_per_pack()
    runs: dict[str, list[str]] = {}
    for part in ("all", "node", "browser"):
        code, calls, output = _run(
            TARGETED, {"WEB_TARGETED_PART": part, "WEB_TARGETED_CHANGED_FILES": changed}
        )
        assert code == 0, f"web-targeted-check.sh ({part}) exited {code}:\n{output[-2000:]}"
        runs[part] = calls

    all_calls, node, browser = runs["all"], runs["node"], runs["browser"]
    assert node and browser, "the fixture must schedule packs in both legs"
    assert not set(node) & set(browser), f"packs ran in both legs: {set(node) & set(browser)}"
    assert sorted(node + browser) == sorted(all_calls), (
        "the node and browser legs together must run exactly what `all` runs"
    )

    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    for call in browser:
        name = call.split()[1]
        assert _reaches_playwright(name, scripts, set()), f"{name} ran in the browser leg"
    for call in node:
        name = call.split()[1]
        assert not _reaches_playwright(name, scripts, set()), f"{name} needs a browser"


def test_targeted_rejects_an_unknown_part() -> None:
    code, calls, _ = _run(TARGETED, {"WEB_TARGETED_PART": "chromium"})
    assert code == 2 and not calls


def test_node_leg_leaves_diagram_rendering_to_browser_leg() -> None:
    code, calls, output = _run(
        TARGETED, {"WEB_TARGETED_PART": "node", "WEB_TARGETED_CHANGED_FILES": "docs/README.md"}
    )
    assert code == 0, output[-2000:]
    assert not calls and "Rendered " not in output


def test_full_suite_shards_run_verifiers_once() -> None:
    code, unsharded, output = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": ""})
    assert code == 0, output[-2000:]
    verifiers = [call for call in unsharded if not call.startswith("run test:ci")]
    assert unsharded == [*verifiers, "run test:ci -- --maxWorkers=2"] and verifiers

    shard_calls: list[list[str]] = []
    for index in (1, 2, 3):
        code, calls, output = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": f"{index}/3"})
        assert code == 0, output[-2000:]
        assert calls[-1] == f"run test:ci -- --shard={index}/3 --maxWorkers=2", calls
        shard_calls.append(calls[:-1])
    assert shard_calls[0] == verifiers, "shard 1 must run every contract verifier"
    assert shard_calls[1] == [] and shard_calls[2] == [], "only shard 1 runs the verifiers"

    for bad in ("0/3", "4/3", "1/0", "a/b", "1", "1/3/3"):
        code, calls, _ = _run(FULL_SUITE, {"WEB_FULL_SUITE_SHARD": bad})
        assert code == 2 and not calls, f"shard spec {bad!r} was accepted"


def test_workflow_schedules_every_leg_and_shard() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    job_ids = re.findall(r"^  ([a-z][a-z0-9-]*):$", workflow, re.M)
    assert len(job_ids) == len(set(job_ids)), "CI workflow has duplicate job IDs"

    targeted = _job_block(workflow, "web-targeted-check", "web-full-suite-check")
    assert "part: [node, browser]" in targeted
    assert "WEB_TARGETED_PART: ${{ matrix.part }}" in targeted
    assert "fail-fast: false" in targeted

    editor_perf = _job_block(workflow, "web-editor-performance-check", "web-full-suite-check")
    assert "runs-on: macos-15" in editor_perf
    assert "npm run test:layout-editor-performance" in editor_perf
    scripts = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]
    assert "test:layout-editor-performance" not in scripts["test:layout-contracts"]

    full = _job_block(workflow, "web-full-suite-check", "ios-native-check")
    shards = re.search(r"shard: \[([0-9, ]+)\]", full)
    assert shards, "web-full-suite-check has no shard matrix"
    indexes = [int(value) for value in shards.group(1).split(",")]
    count = len(indexes)
    assert indexes == list(range(1, count + 1)), f"shards must be 1..N, got {indexes}"
    assert f"WEB_FULL_SUITE_SHARD: ${{{{ matrix.shard }}}}/{count}" in full
    assert f"${{{{ matrix.shard }}}}/{count}\"" in full, "the job name must show the shard count"
    assert "fail-fast: false" in full

    gate = workflow[workflow.index('name: "CI Status Gate"') :]
    assert '[ "$WEB_FULL_SUITE" != "success" ]' in gate
    assert "WEB_TARGETED=\"${{ needs['web-targeted-check'].result }}\"" in gate
    assert "WEB_EDITOR_PERF=\"${{ needs['web-editor-performance-check'].result }}\"" in gate
    assert '[ "$WEB_EDITOR_PERF" != "success" ]' in gate


def main() -> int:
    tests = (
        test_targeted_legs_partition_the_matched_packs,
        test_targeted_rejects_an_unknown_part,
        test_node_leg_leaves_diagram_rendering_to_browser_leg,
        test_full_suite_shards_run_verifiers_once,
        test_workflow_schedules_every_leg_and_shard,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
