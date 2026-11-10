#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
MAX_BODY = 256 * 1024
MAX_FILES = 128 * 1024


def _git_branch() -> str:
    result = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return (result.stdout or "").strip() or "detached-head"


def _run(
    command: list[str],
    *,
    stream_output: bool,
    env: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    child = os.environ.copy()
    for key, value in (env or {}).items():
        if value is None:
            child.pop(key, None)
        else:
            child[key] = value
    for key in ("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"):
        child.pop(key, None)
    if stream_output:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            text=True,
            check=False,
            env=child,
        )
        return {
            "command": command,
            "returncode": result.returncode,
            "ok": result.returncode == 0,
            "stdout_tail": "",
            "stderr_tail": "",
        }

    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=child,
    )
    return {
        "command": command,
        "returncode": result.returncode,
        "ok": result.returncode == 0,
        "stdout_tail": result.stdout[-4000:],
        "stderr_tail": result.stderr[-4000:],
    }


def _capture(command: list[str], env: dict[str, str | None] | None = None) -> str:
    child = os.environ.copy()
    for key, value in (env or {}).items():
        if value is None: child.pop(key, None)
        else: child[key] = value
    for key in ("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"):
        child.pop(key, None)
    result = subprocess.run(command, cwd=REPO_ROOT, capture_output=True, text=True, check=False, env=child)
    if result.returncode: raise ValueError((result.stderr or "command failed").strip()[-500:])
    return result.stdout.strip()


def _context(args: argparse.Namespace, temp: Path) -> dict[str, Any]:
    branch = _capture(["git", "branch", "--show-current"]) or "detached-head"
    head = _capture(["git", "rev-parse", "HEAD"])
    if _capture(["git", "status", "--porcelain", "--untracked-files=all"]):
        raise ValueError("pre-PR checks require a clean worktree")
    number, url = None, None
    if args.pr:
        fields = "number,state,baseRefName,baseRefOid,headRefName,headRefOid,body,author,url"
        pr = json.loads(_capture(["gh", "pr", "view", str(args.pr), "--json", fields]))
        if pr.get("number") != args.pr or str(pr.get("state", "")).lower() != "open":
            raise ValueError("PR is unavailable or closed")
        base_ref, base, head_ref, pr_head = (pr.get(k) for k in ("baseRefName", "baseRefOid", "headRefName", "headRefOid"))
        author, body, url, number = (pr.get("author") or {}).get("login"), pr.get("body"), pr.get("url"), args.pr
        if head != pr_head: raise ValueError("local HEAD differs from current PR head")
        repo_url = _capture(["git", "remote", "get-url", "origin"])
        match = re.search(r"(?:github\.com[:/])([\w.-]+/[\w.-]+?)(?:\.git)?$", repo_url)
        if not match: raise ValueError("origin does not identify a GitHub repository")
        repository = match.group(1)
    else:
        base_ref = args.base_ref.removeprefix("refs/heads/").removeprefix("origin/")
        if not base_ref or re.fullmatch(r"[a-f0-9]{40}", base_ref): raise ValueError("--base-ref must be a target branch name")
        _capture(["git", "check-ref-format", "--branch", base_ref])
        base = _capture(["git", "rev-parse", "--verify", "--end-of-options", f"{args.base_ref}^{{commit}}"])
        head_ref, author, body, repository = branch, _capture(["gh", "api", "user", "--jq", ".login"]), None, ""
        if args.body_file:
            path = Path(args.body_file)
            path = path if path.is_absolute() else REPO_ROOT / path
            if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BODY:
                raise ValueError("--body-file must be a regular file below 256 KiB")
            body = path.read_text(encoding="utf-8")
    if not all(isinstance(x, str) and x for x in (base_ref, base, head_ref, head, author)):
        raise ValueError("PR identity is incomplete")
    if not re.fullmatch(r"[a-f0-9]{40}", base) or not re.fullmatch(r"[a-f0-9]{40}", head):
        raise ValueError("PR base or head SHA is malformed")
    if body is not None and (not isinstance(body, str) or len(body.encode()) > MAX_BODY):
        raise ValueError("PR body exceeds 256 KiB")
    env = {"CI_IMPACT_BASE_SHA": base, "CI_IMPACT_HEAD_SHA": head, "RUNNER_TEMP": str(temp),
           "GITHUB_RUN_ID": "local", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_ENV": None}
    changed = Path(_capture(["bash", "scripts/ci/resolve-ci-changed-files.sh"], env))
    if changed.is_symlink() or changed.parent.resolve() != temp.resolve() or changed.stat().st_size > MAX_FILES:
        raise ValueError("changed-file resolver returned unsafe or oversized output")
    files = changed.read_text(encoding="utf-8").splitlines()
    if not files: raise ValueError("no changed files found for this base and source")
    lanes, lane_warning = _lanes(files, None)
    return {"branch": branch, "base_ref": base_ref, "base": base, "head": head, "head_ref": head_ref,
            "author": author, "body": body, "number": number, "url": url, "repository": repository,
            "files": files, "files_path": changed, "lanes": lanes, "lane_warning": lane_warning}


def _workflow_filters() -> dict[str, list[str]]:
    lines = (REPO_ROOT / ".github/workflows/ci.yml").read_text().splitlines()
    marks = [i for i, line in enumerate(lines) if re.fullmatch(r"\s*filters:\s*\|\s*", line)]
    if len(marks) != 1: raise ValueError("CI path filter block is not unique")
    i, indent, filters, current = marks[0], len(lines[marks[0]]) - len(lines[marks[0]].lstrip()), {}, ""
    for line in lines[i + 1:]:
        text = line.strip()
        if not text or text.startswith("#"): continue
        spaces, text = len(line) - len(line.lstrip()), line.lstrip()
        if spaces <= indent: break
        if spaces == indent + 2 and text.endswith(":"):
            current = text[:-1]; filters[current] = []
        elif spaces == indent + 4 and text.startswith("- ") and current:
            raw = text[2:].strip()
            if not re.fullmatch(r"'[A-Za-z0-9_./!*+{},?\[\]-]+'", raw): raise ValueError("unsupported path-filter syntax")
            pattern = raw[1:-1]
            plain = pattern.removeprefix("!")
            if current in {"frontend", "backend"} and any(char in plain.removesuffix("/**") for char in "*?[]{}"):
                raise ValueError("unsupported path-filter glob; selecting both app lanes")
            filters[current].append(pattern)
        else: raise ValueError("unsupported path-filter syntax")
    if not filters.get("frontend") or not filters.get("backend"): raise ValueError("frontend/backend filters missing")
    return filters


def _lanes(files: list[str], plan_error: str | None) -> tuple[dict[str, bool], str | None]:
    try:
        filters = _workflow_filters()
        if plan_error:
            raise ValueError(plan_error)
        def matches(patterns: list[str]) -> bool:
            include = [p for p in patterns if not p.startswith("!")]
            exclude = [p[1:] for p in patterns if p.startswith("!")]
            return any(any(fnmatch.fnmatchcase(path, p) for p in include) and
                       not any(fnmatch.fnmatchcase(path, p) for p in exclude) for path in files)
        return {name: matches(filters[name]) for name in ("frontend", "backend")}, None
    except (OSError, ValueError) as exc:
        return {"frontend": True, "backend": True}, str(exc)


def _protected(c: dict[str, Any]) -> tuple[bool, str]:
    ci = REPO_ROOT / "scripts/ci"
    sys.path.insert(0, str(ci))
    spec = importlib.util.spec_from_file_location("protected_edit_guard", ci / "verify-protected-pipeline-edits.py")
    if spec is None or spec.loader is None:
        raise ValueError("protected edit guard could not be loaded")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    policy = json.loads(_capture(["git", "show", f"{c['base']}:config/ci-governance.json"]))
    if c["base_ref"] in {"dev", "uat"} and policy.get("authorization", {}).get("native_teams") is True:
        from queue_combined_result import authority_policy
        _, policy = authority_policy("hushh-labs/hushh-research", c["base_ref"], c["base"])
    if policy.get("authorization", {}).get("native_teams"):
        from github_team_authority import local_policy
        policy = local_policy(policy)
    main_policy = policy.get("main")
    if not isinstance(main_policy, dict):
        raise ValueError("base protected-pipeline policy is missing")
    allowed = guard.resolve_allowed_users(main_policy)
    protected_paths = main_policy.get("protected_pipeline_paths") or guard.DEFAULT_PROTECTED_PATHS
    approvals = []
    touches_protected = any(
        guard._matches(path, protected) for path in c["files"] for protected in protected_paths
    )
    if c["number"] and c["author"] not in allowed and touches_protected:
        def read(path: str) -> Any:
            return json.loads(_capture(["gh", "api", path]))
        approvals = guard._owner_approvals(
            c["repository"], c["number"], c["head"], allowed, read=read
        )
    code, message = guard.evaluate(
        changed_files=c["files"], actor=c["author"], allowed_users=allowed,
        protected_paths=protected_paths, owner_approvals=approvals,
    )
    return code == 0, message


def _focused(args: argparse.Namespace, c: dict[str, Any], temp: Path, *, stream: bool) -> tuple[OrderedDict, list[str]]:
    event_path = temp / "event.json"
    event_path.write_text(json.dumps({"number": c["number"] or 1, "pull_request": {
        "number": c["number"] or 1, "body": c["body"] or "", "user": {"login": c["author"]},
        "base": {"ref": c["base_ref"], "sha": c["base"]}, "head": {"ref": c["head_ref"], "sha": c["head"]}}}), encoding="utf-8")
    event_path.chmod(0o600)
    checks, commands = OrderedDict(), []
    def run(name: str, argv: list[str], env: dict[str, str | None] | None = None) -> None:
        commands.append(" ".join(argv))
        checks[name] = _run(argv, stream_output=stream, env=env)
    run("base_policy", ["python3", "scripts/ci/verify-pr-base-policy.py", "--base-ref", c["base_ref"],
        "--head-ref", c["head_ref"], "--actor", c["author"]])
    try:
        ok, message = _protected(c)
        checks["protected_edits"] = {"ok": ok, "stdout_tail": message}
    except (OSError, ValueError, ImportError, json.JSONDecodeError) as exc:
        checks["protected_edits"] = {"ok": False, "stderr_tail": str(exc)}
    run("dco", ["bash", "scripts/ci/check-dco-signoff.sh"])
    event_env = {"GITHUB_EVENT_NAME": "pull_request" if c["body"] is not None else "local",
                 "GITHUB_EVENT_PATH": str(event_path) if c["body"] is not None else None,
                 "GITHUB_REPOSITORY": c["repository"] or None, "GITHUB_RUN_ATTEMPT": "1",
                 "SECRET_SCAN_PR_NUMBER": None}
    run("secret_scan", ["bash", "scripts/ci/orchestrate.sh", "secret"], event_env)
    common = {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES_FILE": str(c["files_path"]),
              "CI_CHANGED_FILES": None, "CI_IMPACT_BASE_SHA": c["base"], "CI_IMPACT_HEAD_SHA": c["head"],
              "GITHUB_EVENT_NAME": "local", "GITHUB_EVENT_PATH": None, "GITHUB_TOKEN": None, "GH_TOKEN": None}
    run("governance", ["bash", "scripts/ci/repo-governance-check.sh"], common)
    web = {**common, "WEB_TARGETED_CHANGED_FILES": "\n".join(c["files"]), "CI_ACCOUNT_DELETION_CLIENT_OWNED": "0", "WEB_TARGETED_PART": "node"}
    stages = (["web-core", "web-targeted", "web-full-suite"] if c["lanes"]["frontend"] else [])
    if c["lanes"]["backend"]: stages += ["protocol", "mcp-package"]
    for stage in stages:
        stage_env = dict(web)
        if stage == "protocol":
            # Match the CI parallel owner with synthetic fixture authority;
            # database services remain separate hosted checks.
            stage_env.update(TESTING="true", PROTOCOL_TEST_PARTITION="parallel",
                             APP_SIGNING_KEY="test_secret_key_for_ci_only_32chars_min",
                             VAULT_DATA_KEY="0" * 64,
                             HUSHH_DEVELOPER_TOKEN="test_hushh_developer_token_for_ci")
        run(stage.replace("-", "_"), ["bash", "scripts/ci/orchestrate.sh", stage], stage_env)
    return checks, commands


def _render_text(payload: dict[str, Any]) -> str:
    lines = [
        f"Workflow: {payload['workflow_id']}",
        f"Status: {payload['status']}",
        f"Branch: {payload['branch']}",
        f"Diagnostic: {payload.get('diagnostic', False)}",
        f"Checks represented: {', '.join(payload['mirrors_workflows'])}",
        f"Browser: {payload.get('browser_validation', 'diagnostic mode')}",
        f"Hosted checks still required: {', '.join(payload.get('hosted_required', [])) or 'see selected workflow'}",
        "Commands:",
    ]
    for command in payload["commands"]:
        lines.append(f"- {command}")
    if payload.get("checks"):
        lines.append("Checks:")
        for name, check in payload["checks"].items():
            status = "passing" if check["ok"] else "failing"
            lines.append(f"- {name}: {status}")
    if payload.get("next_actions"):
        lines.append("Next actions:")
        for item in payload["next_actions"]:
            lines.append(f"- {item}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run focused pre-PR checks, or opt in to the full historical local diagnostic mirror."
    )
    parser.add_argument("--base-ref", help="Target branch used to select focused local checks.")
    parser.add_argument("--pr", type=int, help="Read the current PR metadata and body from GitHub.")
    parser.add_argument("--body-file", help="Read optional PR review context; structural memory checks do not depend on prose.")
    parser.add_argument("--diagnostic", action="store_true", help="Run the full historical local CI mirror.")
    parser.add_argument("--include-advisory", action="store_true", help="Include advisory checks in diagnostic mode.")
    parser.add_argument("--report-path", help="Optional path for a machine-readable report.")
    parser.add_argument("--json", action="store_true", help="Emit JSON output.")
    parser.add_argument("--text", action="store_true", help="Emit text output (default).")
    args = parser.parse_args()

    if args.diagnostic:
        if args.base_ref or args.pr or args.body_file:
            parser.error("--diagnostic cannot be combined with focused PR inputs")
        return _diagnostic(args)
    if bool(args.base_ref) == bool(args.pr):
        parser.error("choose exactly one of --base-ref or --pr")
    if args.pr and args.body_file:
        parser.error("--body-file is only used with --base-ref")
    if args.include_advisory:
        parser.error("--include-advisory is only available with --diagnostic")

    try:
        with tempfile.TemporaryDirectory(prefix="hushh-pre-pr-") as temp_dir:
            temp = Path(temp_dir)
            c = _context(args, temp)
            checks, commands = _focused(args, c, temp, stream=not bool(args.json))
            if c["lane_warning"]:
                checks["lane_selection_fallback"] = {"ok": False, "stderr_tail": c["lane_warning"]}
            ok = all(check.get("ok", False) for check in checks.values())
            payload: OrderedDict[str, Any] = OrderedDict(
                workflow_id="pre-pr-readiness", status="passing" if ok else "failing",
                branch=c["branch"], base_ref=c["base_ref"], base_sha=c["base"], head_sha=c["head"],
                pr=c["number"], pr_url=c["url"], changed_files=c["files"],
                mirrors_workflows=["affected local checks"], diagnostic=False,
                hosted_required=["exact-head PR admission and selected native checks"] +
                    (["cross-surface Integration"] if any(c["lanes"].values()) else []) +
                    (["Protocol Database (1/2)", "Protocol Database (2/2)"] if c["lanes"]["backend"] else []),
                browser_validation="explicit diagnostic only; not executed locally",
                include_advisory=False, commands=commands, checks=checks,
                next_actions=["Open or update the pull request after all focused checks pass." if ok
                              else "Resolve the reported failed checks before proceeding."],
            )
            if args.report_path:
                report_path = Path(args.report_path)
                report_path.parent.mkdir(parents=True, exist_ok=True)
                report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                payload["report_path"] = str(report_path)
            print(json.dumps(payload, indent=2) if args.json else _render_text(payload))
            return 0 if ok else 1
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        payload = {"workflow_id": "pre-pr-readiness", "status": "failing",
                   "diagnostic": False, "error": str(exc)}
        print(json.dumps(payload, indent=2) if args.json else f"Pre-PR readiness blocked: {exc}")
        return 2


def _diagnostic(args: argparse.Namespace) -> int:
    """Run the full historical local mirror when explicitly requested."""

    json_mode = bool(args.json)
    dco_command = ["bash", "scripts/ci/check-dco-signoff.sh"]
    ci_command = ["./bin/hushh", "ci"]
    if args.include_advisory:
        ci_command.append("--include-advisory")

    if not json_mode:
        print("Running the local PR mirror before opening or updating a pull request.")
        print(f"Command: {' '.join(dco_command)}")
        print(f"Command: {' '.join(ci_command)}")

    dco_result = _run(dco_command, stream_output=not json_mode)
    if dco_result["ok"]:
        ci_result = _run(ci_command, stream_output=not json_mode)
    else:
        ci_result = {
            "command": ci_command,
            "returncode": 1,
            "ok": False,
            "stdout_tail": "",
            "stderr_tail": "Skipped because the local DCO signoff gate failed.",
        }
    ok = dco_result["ok"] and ci_result["ok"]
    payload: OrderedDict[str, Any] = OrderedDict(
        workflow_id="pre-pr-readiness",
        status="passing" if ok else "failing",
        branch=_git_branch(),
        mirrors_workflows=["PR Validation", "CI Status Gate"],
        include_advisory=args.include_advisory,
        commands=[" ".join(dco_command), " ".join(ci_command)],
        reports=OrderedDict(),
        checks=OrderedDict(
            dco=OrderedDict(
                ok=dco_result["ok"],
                returncode=dco_result["returncode"],
                stdout_tail=dco_result["stdout_tail"],
                stderr_tail=dco_result["stderr_tail"],
            ),
            local_pr_mirror=OrderedDict(
                ok=ci_result["ok"],
                returncode=ci_result["returncode"],
                stdout_tail=ci_result["stdout_tail"],
                stderr_tail=ci_result["stderr_tail"],
            ),
        ),
        command_result=OrderedDict(
            returncode=dco_result["returncode"] if not dco_result["ok"] else ci_result["returncode"],
            stdout_tail=dco_result["stdout_tail"] if not dco_result["ok"] else ci_result["stdout_tail"],
            stderr_tail=dco_result["stderr_tail"] if not dco_result["ok"] else ci_result["stderr_tail"],
        ),
        next_actions=[
            "Open or update the pull request once the local mirror is green."
            if ok
            else "Fix the failing local check before opening or updating the pull request.",
            "Use ./bin/hushh agents ci-status --watch after the PR opens so GitHub reaches a terminal state.",
        ],
    )

    if args.report_path:
        report_path = Path(args.report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        payload["reports"]["report_path"] = str(report_path)

    if json_mode:
        print(json.dumps(payload, indent=2))
    else:
        print(_render_text(payload))

    return 0 if ok else int(dco_result["returncode"] if not dco_result["ok"] else ci_result["returncode"])


if __name__ == "__main__":
    raise SystemExit(main())
