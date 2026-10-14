#!/usr/bin/env python3
"""Exercise queue candidate ranges and the required CI gate on merge groups."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
CONTEXT_CHECK = ROOT / "scripts/ci/validate-merge-group-context.py"
DCO_CHECK = ROOT / "scripts/ci/check-dco-signoff.sh"
WEB_COMMON = ROOT / "scripts/ci/web-common.sh"


def _git(directory: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=directory, check=True, capture_output=True, text=True
    ).stdout.strip()


def _commit(directory: Path, path: str, *, signed: bool = True) -> str:
    target = directory / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(path, encoding="utf-8")
    _git(directory, "add", path)
    args = ["commit", "-m", f"Add {path}"]
    if signed:
        args.append("-s")
    _git(directory, *args)
    return _git(directory, "rev-parse", "HEAD")


def _queue_dag(directory: Path, *, second_signed: bool = True) -> tuple[str, str, str]:
    _git(directory, "init", "-q", "-b", "main")
    _git(directory, "config", "user.name", "CI Test")
    _git(directory, "config", "user.email", "ci-test@example.invalid")
    base = _commit(directory, "README.md")
    _git(directory, "switch", "-q", "-c", "pr-a")
    _commit(directory, "hushh-webapp/app/example.tsx")
    _git(directory, "switch", "-q", "main")
    _git(directory, "merge", "--no-ff", "--no-edit", "pr-a")
    first_group = _git(directory, "rev-parse", "HEAD")
    _git(directory, "switch", "-q", "-c", "pr-b", base)
    _commit(directory, "consent-protocol/api/example.py", signed=second_signed)
    _git(directory, "switch", "-q", "main")
    _git(directory, "merge", "--no-ff", "--no-edit", "pr-b")
    stacked_group = _git(directory, "rev-parse", "HEAD")
    return base, first_group, stacked_group


def _validate(
    directory: Path, base: str, head: str, *,
    base_ref: str = "refs/heads/main", checkout_sha: str | None = None,
) -> subprocess.CompletedProcess[str]:
    output = directory / "queue-context.out"
    return subprocess.run(
        [
            "python3", str(CONTEXT_CHECK), "--base-sha", base,
            "--head-sha", head, "--checkout-sha", checkout_sha or head,
            "--base-ref", base_ref, "--github-output", str(output),
        ],
        cwd=directory, capture_output=True, text=True,
    )


def test_queue_ranges_include_merged_base_and_stacked_content() -> None:
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        base, first_group, stacked_group = _queue_dag(directory)
        _git(directory, "switch", "-q", "--detach", first_group)
        assert _validate(directory, base, first_group).returncode == 0
        _git(directory, "switch", "-q", "--detach", stacked_group)
        assert _validate(directory, base, stacked_group).returncode == 0
        assert first_group != _git(directory, "rev-parse", "main")
        # A queue entry can be built atop the preceding queue candidate while
        # the live branch already points elsewhere. Its event base is authority.
        assert _validate(directory, first_group, stacked_group, base_ref="refs/heads/integration/pr-train").returncode == 0
        changed = set(_git(directory, "diff", "--name-only", base, stacked_group).splitlines())
        assert changed == {
            "hushh-webapp/app/example.tsx",
            "consent-protocol/api/example.py",
        }
        # The synthetic merge commits have no Signed-off-by trailer. DCO must
        # inspect constituent authored commits and still reject an unsigned PR.
        result = subprocess.run(
            ["bash", str(DCO_CHECK)], cwd=directory,
            env={**os.environ, "GITHUB_EVENT_NAME": "merge_group", "GITHUB_BASE_SHA": base,
                 "GITHUB_HEAD_SHA": stacked_group, "GITHUB_SHA": stacked_group},
            capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stderr
        assert "2 commit(s)" in result.stdout
        stacked_result = subprocess.run(
            ["bash", str(DCO_CHECK)], cwd=directory,
            env={**os.environ, "GITHUB_EVENT_NAME": "merge_group", "GITHUB_BASE_SHA": first_group,
                 "GITHUB_HEAD_SHA": stacked_group, "GITHUB_SHA": stacked_group},
            capture_output=True, text=True,
        )
        assert stacked_result.returncode == 0, stacked_result.stderr
        assert "1 commit(s)" in stacked_result.stdout


def test_queue_context_and_unsigned_change_fail_closed() -> None:
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        base, first_group, stacked_group = _queue_dag(directory, second_signed=False)
        for bad_base, bad_head, bad_ref in (
            ("", stacked_group, "refs/heads/main"),
            (stacked_group, first_group, "refs/heads/main"),
            (base, stacked_group, "refs/heads/unexpected"),
            (base, "f" * 40, "refs/heads/main"),
        ):
            assert _validate(directory, bad_base, bad_head, base_ref=bad_ref).returncode != 0
        assert _validate(directory, base, stacked_group, checkout_sha=first_group).returncode != 0
        # Event fields can agree while a moving queue ref checks out an older tree.
        assert _validate(directory, base, first_group, checkout_sha=first_group).returncode != 0
        result = subprocess.run(
            ["bash", str(DCO_CHECK)], cwd=directory,
            env={**os.environ, "GITHUB_EVENT_NAME": "merge_group", "GITHUB_BASE_SHA": base,
                 "GITHUB_HEAD_SHA": stacked_group, "GITHUB_SHA": stacked_group},
            capture_output=True, text=True,
        )
        assert result.returncode != 0
        assert "Missing DCO signoff" in result.stderr


def test_contributor_merge_requires_signoff_on_pr_release_and_queue() -> None:
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        _git(directory, "init", "-q", "-b", "main")
        _git(directory, "config", "user.name", "CI Test")
        _git(directory, "config", "user.email", "ci-test@example.invalid")
        base = _commit(directory, "README.md")
        _git(directory, "switch", "-q", "-c", "contributor")
        _commit(directory, "hushh-webapp/app/one.tsx")
        _git(directory, "switch", "-q", "-c", "side", base)
        _commit(directory, "consent-protocol/api/two.py")
        _git(directory, "switch", "-q", "contributor")
        _git(directory, "merge", "--no-ff", "--no-edit", "side")
        contributor_merge = _git(directory, "rev-parse", "HEAD")
        assert "Signed-off-by:" not in _git(directory, "log", "-1", "--format=%B")

        plain_env = {key: value for key, value in os.environ.items() if not key.startswith("GITHUB_")}
        for command, env in (
            (["bash", str(DCO_CHECK), base, contributor_merge], plain_env),
            (["bash", str(DCO_CHECK)], {**plain_env, "GITHUB_EVENT_NAME": "pull_request",
                                        "GITHUB_BASE_SHA": base, "GITHUB_HEAD_SHA": contributor_merge}),
        ):
            result = subprocess.run(command, cwd=directory, env=env, capture_output=True, text=True)
            assert result.returncode != 0
            assert contributor_merge in result.stderr, result.stderr

        _git(directory, "switch", "-q", "main")
        _git(directory, "merge", "--no-ff", "--no-edit", "contributor")
        queue_head = _git(directory, "rev-parse", "HEAD")
        result = subprocess.run(
            ["bash", str(DCO_CHECK)], cwd=directory,
            env={**plain_env, "GITHUB_EVENT_NAME": "merge_group", "GITHUB_BASE_SHA": base,
                 "GITHUB_HEAD_SHA": queue_head, "GITHUB_SHA": queue_head},
            capture_output=True, text=True,
        )
        assert result.returncode != 0
        assert contributor_merge in result.stderr, result.stderr
        assert queue_head not in result.stderr


def test_targeted_web_uses_pinned_queue_range_even_if_checkout_is_dirty() -> None:
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        base, _, stacked_group = _queue_dag(directory)
        (directory / "README.md").write_text("local install noise", encoding="utf-8")

        def changed(selected_base: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["bash", "-e", "-c", 'source "$1"; web_ci_changed_files', "bash", str(WEB_COMMON)],
                cwd=directory,
                env={**os.environ, "WEB_TARGETED_BASE_SHA": selected_base, "WEB_TARGETED_HEAD_SHA": stacked_group},
                capture_output=True, text=True,
            )

        result = changed(base)
        assert result.returncode == 0, result.stderr
        assert set(result.stdout.splitlines()) == {
            "hushh-webapp/app/example.tsx",
            "consent-protocol/api/example.py",
        }
        missing = changed("f" * 40)
        assert missing.returncode != 0
        assert "Pinned web verification range is unavailable" in missing.stderr


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def test_queue_event_and_sha_inputs_reach_the_real_lanes() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    jobs = _workflow()["jobs"]
    assert "merge_group:\n    types: [checks_requested]" in source
    assert not (ROOT / ".github/workflows/queue-validation.yml").exists()
    assert jobs["ci-status"]["name"] == "CI Status Gate"
    assert all(event in jobs["dco-check"]["if"] for event in ("pull_request", "merge_group", "workflow_dispatch"))
    dco_source = DCO_CHECK.read_text(encoding="utf-8")
    assert "--no-merges" not in dco_source
    assert "--first-parent --merges" in dco_source
    for job_name, job in jobs.items():
        if job_name in {"pr-base-policy", "merge-fidelity-gate"}:
            continue
        for step in job.get("steps", []):
            if step.get("uses") == "actions/checkout@v6":
                assert "github.event.merge_group.head_sha" in step["with"]["ref"], job_name

    path_steps = jobs["paths"]["steps"]
    validator = next(step for step in path_steps if step.get("id") == "queue-context")
    assert "validate-merge-group-context.py" in validator["run"]
    assert validator["env"]["CHECKOUT_SHA"] == "${{ github.sha }}"
    assert '--checkout-sha "$CHECKOUT_SHA"' in validator["run"]
    filter_step = next(step for step in path_steps if str(step.get("uses", "")).startswith("dorny/paths-filter"))
    assert "merge_group" in filter_step["if"]
    assert "steps.queue-context.outputs.base_sha" in filter_step["with"]["base"]
    assert "steps.queue-context.outputs.head_sha" in filter_step["with"]["ref"]
    assert "github.event.repository.default_branch" in filter_step["with"]["base"]
    assert "github.sha" in filter_step["with"]["ref"]

    preflight = jobs["preflight-gate"]["outputs"]
    for key in ("base_sha", "head_sha", "base_ref"):
        assert preflight[key] == "${{ needs.paths.outputs." + key + " }}"
    for job in ("protocol-check", "web-full-suite-check"):
        lane = "\n".join(str(step) for step in jobs[job]["steps"])
        assert "${{ needs['preflight-gate'].outputs.base_sha || 'origin/main' }}" in lane
    targeted = "\n".join(str(step) for step in jobs["web-targeted-check"]["steps"])
    assert "WEB_TARGETED_BASE_SHA" in targeted and "outputs.base_sha" in targeted
    assert "WEB_TARGETED_HEAD_SHA" in targeted and "outputs.head_sha" in targeted
    integration = "\n".join(str(step) for step in jobs["integration-check"]["steps"])
    assert "outputs.base_sha" in integration and "outputs.head_sha" in integration
    freshness = jobs["main-freshness-gate"]
    assert "merge_group" in freshness["if"]
    queue_step = next(step for step in freshness["steps"] if step.get("name") == "Verify immutable merge-group base and head")
    assert queue_step["if"] == "github.event_name == 'merge_group'"
    assert "validate-merge-group-context.py" in queue_step["run"]
    assert "github.event.merge_group.head_sha" in freshness["steps"][0]["with"]["ref"]
    pr_step = next(step for step in freshness["steps"] if step.get("name") == "Verify branch freshness against PR base")
    assert pr_step["if"] == "github.event_name == 'pull_request'"
    assert "check-main-sync.sh" in pr_step["run"]


def _run_gate(event: str, *, base_ref: str = "", changes: dict[str, str] | None = None, results: dict[str, str] | None = None) -> int:
    script = _workflow()["jobs"]["ci-status"]["steps"][0]["run"]
    selected = {name: "false" for name in ("frontend", "backend", "ios", "android", "editor")}
    selected.update(changes or {})
    outcomes = {name: "success" for name in _workflow()["jobs"]}
    outcomes.update({"pr-base-policy": "skipped", "merge-fidelity-gate": "skipped"})
    outcomes.update(results or {})

    def expression(match: re.Match[str]) -> str:
        body = match.group(1).strip()
        if body == "github.event_name":
            return event
        if body == "github.base_ref":
            return base_ref
        job_result = re.fullmatch(r"needs(?:\['([^']+)'\]|\.([\w-]+))\.result", body)
        if job_result:
            return outcomes[job_result.group(1) or job_result.group(2)]
        output = re.fullmatch(r"needs\.paths\.outputs\.(frontend|backend|ios|android|editor)", body)
        if output:
            return selected[output.group(1)]
        raise AssertionError(f"unhandled CI gate expression {body!r}")

    rendered = re.sub(r"\$\{\{\s*(.*?)\s*\}\}", expression, script)
    return subprocess.run(
        ["bash", "-e", "-c", rendered],
        env={**os.environ, "EVENT_NAME": event, "BASE_REF": base_ref},
        capture_output=True, text=True,
    ).returncode


def test_merge_group_gate_requires_changed_lanes_and_authority() -> None:
    assert _run_gate("merge_group", changes={"frontend": "true", "backend": "true"}) == 0
    for invalid in (
        {"protocol-check": "skipped"},
        {"mcp-package-check": "skipped"},
        {"integration-check": "skipped"},
        {"web-targeted-check": "skipped"},
        {"paths": "skipped"},
        {"dco-check": "skipped"},
        {"main-freshness-gate": "skipped"},
    ):
        assert _run_gate("merge_group", changes={"frontend": "true", "backend": "true"}, results=invalid) != 0, invalid
    assert _run_gate("pull_request", base_ref="main", results={"pr-base-policy": "skipped"}) != 0
    assert _run_gate("merge_group", changes={"ios": "true"}, results={"ios-native-check": "skipped"}) != 0
    assert _run_gate("merge_group", changes={"android": "true"}, results={"android-native-check": "skipped"}) != 0


if __name__ == "__main__":
    test_queue_ranges_include_merged_base_and_stacked_content()
    test_queue_context_and_unsigned_change_fail_closed()
    test_contributor_merge_requires_signoff_on_pr_release_and_queue()
    test_targeted_web_uses_pinned_queue_range_even_if_checkout_is_dirty()
    test_queue_event_and_sha_inputs_reach_the_real_lanes()
    test_merge_group_gate_requires_changed_lanes_and_authority()
    print("merge-group CI workflow tests passed")
