#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

"""PR Validation restores the large build caches; only main saves them.

GitHub scopes an Actions cache to the ref that saved it. A pull_request run
saves under refs/pull/<N>/merge, which no other pull request can restore, and
every pull request can restore main's entries. All entries share one 10GB
budget. PR-scoped saves of the Swift package clone (~4.5GB each) evicted the
npm cache until that cache was removed on 2026-09-27, and at 20:00Z on
2026-10-14 PR-scoped Next.js entries were 5.50GB of a 10.65GB budget.

So PR Validation restores the Next.js, Swift package, and Playwright caches
and never saves them, and trusted Main-owned workflows save each. Both ways
this breaks are silent, so this test checks them:

* a PR lane saves again (``actions/cache@`` instead of
  ``actions/cache/restore@``), which brings the eviction back;
* a restore stops looking up what its saver writes (path, key, restore-keys,
  or a step or env value the key is built from), which makes every restore a
  miss.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
CI = ".github/workflows/ci.yml"
SMOKE = ".github/workflows/main-post-merge-smoke.yml"
SPM_SAVER = ".github/workflows/ios-swift-package-cache.yml"

# (cache path, the PR Validation job that restores it, the workflow that saves it)
CACHES = (
    ("hushh-webapp/.next/cache", "web-core-check", SMOKE),
    ("${{ runner.temp }}/spm", "ios-native-check", SPM_SAVER),
    ("~/.cache/ms-playwright", "web-targeted-check", SPM_SAVER),
)
MAIN_ONLY = "github.ref == 'refs/heads/main'"
# The Xcode version in the Swift package key must be the Xcode that resolved.
XCODE_FROM_KEY = "xcode-version: ${{ env.XCODE_VERSION }}"

STEP_FIELD = re.compile(r"^(?:      - |        )(uses|id|if): (.*)$", re.M)
WITH_FIELD = re.compile(r"^          (path|key|lookup-only): (.*)$", re.M)
RESTORE_KEYS = re.compile(r"^          restore-keys: \|\n((?:            .*\n?)+)", re.M)


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _job(workflow: str, job: str) -> str:
    start = workflow.index(f"\n  {job}:\n")
    following = re.search(r"\n  [\w-]+:\n", workflow[start + 1 :])
    return workflow[start : start + 1 + following.start()] if following else workflow[start:]


def _steps(block: str) -> list[dict[str, str]]:
    steps = []
    for chunk in re.split(r"\n(?=      - )", block)[1:]:
        step = {key: value.strip() for key, value in STEP_FIELD.findall(chunk)}
        step.update({key: value.strip() for key, value in WITH_FIELD.findall(chunk)})
        restore_keys = RESTORE_KEYS.search(chunk)
        step["restore-keys"] = restore_keys.group(1).strip() if restore_keys else ""
        step["text"] = "\n".join(
            line.rstrip()
            for line in chunk.splitlines()
            if line.strip() and not line.strip().startswith("#")
        )
        steps.append(step)
    return steps


def _env(workflow: str, block: str, name: str) -> set[str]:
    pattern = re.compile(rf"^\s+{re.escape(name)}: (.+?)\s*$", re.M)
    head = workflow.split("\njobs:\n", 1)[0]
    return set(pattern.findall(head)) | set(pattern.findall(block))


def cache_scope_errors(read: Callable[[str], str] = _read) -> list[str]:
    errors: list[str] = []
    ci = read(CI)
    ci_cache_steps = [step for step in _steps(ci) if step.get("uses", "").startswith("actions/cache")]
    for cache_path, job, saver_path in CACHES:
        for step in ci_cache_steps:
            if step.get("path") == cache_path and not step["uses"].startswith("actions/cache/restore@"):
                errors.append(
                    f"{CI}: {cache_path} must use actions/cache/restore; a pull_request "
                    f"save is PR-scoped and only spends the shared 10GB budget"
                )

        block = _job(ci, job)
        restores = [step for step in _steps(block) if step.get("path") == cache_path]
        saver = read(saver_path)
        saver_steps = [step for step in _steps(saver) if step.get("path") == cache_path]
        lookups = [step for step in saver_steps if step.get("uses", "").startswith("actions/cache/restore@")]
        saves = [step for step in saver_steps if step.get("uses", "").startswith("actions/cache/save@")]
        if len(restores) != 1 or len(lookups) != 1 or len(saves) != 1:
            errors.append(
                f"{cache_path}: expected one restore in {CI} {job} and one lookup plus one save "
                f"in {saver_path}; found {len(restores)}, {len(lookups)}, {len(saves)}"
            )
            continue
        restore, lookup, save = restores[0], lookups[0], saves[0]

        if cache_path == "~/.cache/ms-playwright" and lookup.get("lookup-only") != "true":
            errors.append(f"{saver_path}: Playwright cache lookup must not download a cache it only checks")
        if cache_path == "~/.cache/ms-playwright":
            key = lookup.get("key", "")
            for key_part in (
                "${{ runner.os }}",
                "${{ runner.arch }}",
                "hashFiles('hushh-webapp/package-lock.json')",
            ):
                if key_part not in key:
                    errors.append(f"{cache_path}: Playwright cache key must include {key_part}")

        for field in ("key", "restore-keys"):
            if restore.get(field, "") != lookup.get(field, ""):
                errors.append(f"{cache_path}: {field} differs between {CI} {job} and {saver_path}")
        if save.get("key") != f"${{{{ steps.{lookup.get('id')}.outputs.cache-primary-key }}}}":
            errors.append(f"{saver_path}: save {cache_path} under the key its lookup step resolved")
        saver_job_name = {
            "hushh-webapp/.next/cache": "smoke-gate",
            "${{ runner.temp }}/spm": "save",
            "~/.cache/ms-playwright": "warm-playwright",
        }[cache_path]
        saver_job = _job(saver, saver_job_name)
        job_if = re.search(r"^    if: (.*)$", saver_job, re.M)
        if cache_path == "~/.cache/ms-playwright":
            if not (job_if and MAIN_ONLY in job_if.group(1)):
                errors.append(f"{saver_path}: warm-playwright job only runs from main ({MAIN_ONLY})")
            if MAIN_ONLY not in save.get("if", ""):
                errors.append(f"{saver_path}: save {cache_path} only from main ({MAIN_ONLY})")
        elif MAIN_ONLY not in save.get("if", "") and not (job_if and MAIN_ONLY in job_if.group(1)):
            errors.append(f"{saver_path}: save {cache_path} only from main ({MAIN_ONLY})")

        key = restore.get("key", "")
        for step_id in re.findall(r"steps\.([\w-]+)\.outputs", key):
            ours = [step["text"] for step in _steps(block) if step.get("id") == step_id]
            theirs = [step["text"] for step in _steps(saver) if step.get("id") == step_id]
            if len(ours) != 1 or ours != theirs:
                errors.append(f"{cache_path}: step {step_id}, part of the key, differs between {CI} and {saver_path}")
        for name in re.findall(r"env\.([A-Z0-9_]+)", key):
            ours_env, theirs_env = _env(ci, block, name), _env(saver, saver, name)
            if len(ours_env) != 1 or ours_env != theirs_env:
                errors.append(
                    f"{cache_path}: {name}, part of the key, is {sorted(ours_env)} in {CI} {job} "
                    f"but {sorted(theirs_env)} in {saver_path}"
                )
            if name == "XCODE_VERSION" and not (XCODE_FROM_KEY in block and XCODE_FROM_KEY in saver):
                errors.append(f"{cache_path}: both jobs must select Xcode with `{XCODE_FROM_KEY}`")
    return errors


def test_build_caches_are_saved_on_main_and_only_restored_by_prs() -> None:
    errors = cache_scope_errors()
    assert errors == [], "\n".join(errors)

    saver = _read(SPM_SAVER)
    spm_job = _job(saver, "save")
    spm_condition = re.search(r"^    if: (.*)$", spm_job, re.M)
    assert spm_condition and "github.event_name == 'schedule'" in spm_condition.group(1)
    assert "github.event_name == 'workflow_dispatch'" in spm_condition.group(1)
    triggers = saver.split("\njobs:\n", 1)[0]
    assert "  push:\n    branches: [main]" in triggers
    assert '      - "hushh-webapp/package-lock.json"' in triggers
    assert '      - ".github/workflows/ios-swift-package-cache.yml"' in triggers
    assert "\n  pull_request:" not in triggers
    browser_warm = _job(saver, "warm-playwright")
    assert "continue-on-error: true" in browser_warm, (
        "browser cache warming must not affect iOS cache or release checks"
    )
    assert "steps.playwright-browsers.outcome == 'success'" in browser_warm


def test_guard_rejects_a_pr_save_and_a_drifted_key() -> None:
    """Negative control: each mutation is a regression the guard must catch."""

    real = {path: _read(path) for path in (CI, SMOKE, SPM_SAVER)}

    def errors_after(path: str, old: str, new: str) -> list[str]:
        assert real[path].count(old) == 1, f"mutation anchor is not unique in {path}: {old!r}"
        mutated = dict(real)
        mutated[path] = real[path].replace(old, new)
        return cache_scope_errors(mutated.__getitem__)

    spm_restore = "uses: actions/cache/restore@v5\n        with:\n          path: ${{ runner.temp }}/spm"
    errors = errors_after(CI, spm_restore, spm_restore.replace("cache/restore@", "cache@"))
    assert any("must use actions/cache/restore" in error for error in errors), errors

    errors = errors_after(SPM_SAVER, 'XCODE_VERSION: "26.3"', 'XCODE_VERSION: "26.4"')
    assert any("XCODE_VERSION, part of the key" in error for error in errors), errors

    errors = errors_after(SMOKE, "date -u +%Y%m%d", "date -u +%Y%W")
    assert any("step nextjs-cache-day, part of the key" in error for error in errors), errors

    errors = errors_after(SMOKE, f"if: {MAIN_ONLY} && ", "if: ")
    assert any("only from main" in error for error in errors), errors

    errors = errors_after(
        SPM_SAVER,
        f"if: {MAIN_ONLY} && steps.playwright-cache.outputs.cache-hit != 'true'",
        "if: steps.playwright-cache.outputs.cache-hit != 'true'",
    )
    assert any("only from main" in error for error in errors), errors

    playwright_lookup = """path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-${{ runner.arch }}-playwright-${{ hashFiles('hushh-webapp/package-lock.json') }}
          lookup-only: true"""
    errors = errors_after(
        SPM_SAVER,
        playwright_lookup,
        playwright_lookup.replace("lookup-only: true", "lookup-only: false"),
    )
    assert any("must not download" in error for error in errors), errors

    lock_hash = "hashFiles('hushh-webapp/package-lock.json')"
    static_keys = dict(real)
    for path in (CI, SPM_SAVER):
        assert real[path].count(lock_hash) == 1, f"lock hash anchor is not unique in {path}"
        static_keys[path] = real[path].replace(lock_hash, "static-key")
    errors = cache_scope_errors(static_keys.__getitem__)
    assert any("Playwright cache key must include" in error for error in errors), errors


def test_browser_setup_plan_is_fail_closed_and_draft_fidelity_is_advisory_only() -> None:
    ci = _read(CI)
    browser_job = _job(ci, "web-targeted-check")
    plan_step = re.search(
        r"(?ms)^      - name: Plan browser checks\n(?P<step>.*?)(?=^      - |\Z)",
        browser_job,
    )
    assert plan_step, "browser shards must plan selection before browser setup"
    assert re.search(r"^        continue-on-error: true$", plan_step["step"], re.M), (
        "a failed plan must fall through to the complete browser path"
    )
    assert "WEB_TARGETED_PLAN_ONLY: \"1\"" in plan_step["step"]
    assert "steps.browser-plan.outputs.browser_required != 'false'" in browser_job
    assert "steps.browser-plan.outputs.selection_known != 'true'" in browser_job

    advisory = _job(ci, "merge-fidelity-gate")
    condition = re.search(r"^    if: (.*)$", advisory, re.M)
    assert condition, "advisory merge-fidelity job must retain its event/base guard"
    assert "github.event.pull_request.draft != true" in condition.group(1), (
        "draft PRs should not spend a runner on this non-required advisory"
    )
    assert "merge-fidelity-gate" not in _job(ci, "ci-status"), (
        "merge-fidelity must remain outside the required aggregate"
    )


def main() -> int:
    tests = (
        test_build_caches_are_saved_on_main_and_only_restored_by_prs,
        test_guard_rejects_a_pr_save_and_a_drifted_key,
        test_browser_setup_plan_is_fail_closed_and_draft_fidelity_is_advisory_only,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
