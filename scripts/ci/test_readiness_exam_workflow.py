#!/usr/bin/env python3
"""Pin the pre-merge readiness exam's trust boundary (stdlib only; governance lane).

The workflow is privileged (pull_request_target with an OIDC identity), so its
shape is a security contract: Main's checkout only, no PR refs or PR-controlled
strings in any shell, one probe environment, and paths covering every live
anchor file in the manifest. No other default-branch PR-reachable workflow may name a deploy
environment: deploy credentials belong only to dispatched, main-only jobs. The
owner setup script runs against a fake cloud to prove it
refuses a non-probe identity before granting anything. Each rule ships with a
negative control below.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/readiness-exam.yml"
MANIFEST = ROOT / "consent-protocol/config/readiness-exam-manifest.v1.json"
SETUP = ROOT / "deploy/iam/setup_readiness_exam_identity.sh"
PROBE_ENVIRONMENT = "readiness-exam"
PROTECTED_ENVIRONMENTS = {"uat", "dev", "production", "ci-security", "npm-publish"}
PR_REACHABLE = {"pull_request_target", "workflow_run", "issue_comment"}
DYNAMIC = "<dynamic>"  # An environment the file cannot state statically.
# Fail closed: any environment key in any YAML form, any mention of a PR-reachable event.
ENVIRONMENT_KEY = re.compile(r"""(?:^|[{,\s])["']?environment["']?\s*:""", re.MULTILINE)
PR_EVENT = re.compile(r"\b(?:pull_request_target|workflow_run|issue_comment)\b")
LOCAL_CALL = re.compile(r"""uses:\s*["']?\./\.github/workflows/([\w.-]+)""")
SHELL_FORBIDDEN = (
    "${{",
    "refs/pull",
    "FETCH_HEAD",
    "merge_commit_sha",
    "gh pr checkout",
    "git fetch",
    "git checkout",
    "git switch",
)
# Fork PRs get an environment the probe app does not trust (pinned exactly).
ENVIRONMENT_NAME = (
    "      name: ${{ (github.event_name == 'workflow_dispatch' || "
    "github.event.pull_request.head.repo.full_name == github.repository) "
    "&& 'readiness-exam' || 'readiness-exam-untrusted' }}\n      deployment: false\n"
)


def events(text: str) -> set[str]:
    """Trigger names written as a scalar, a flow list or a block mapping, at any indent."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"""^["']?on["']?:(.*)$""", line)
        if not match:
            continue
        value = re.sub(r"(^|\s)#.*$", "", match.group(1)).strip()
        if value.startswith("["):
            items = value.strip("[]").split(",")
            return {item.strip().strip("'\"") for item in items if item.strip()}
        if value:
            return {value.strip("'\"")}
        keys: set[str] = set()
        child = 0
        for follow in lines[index + 1 :]:
            if not follow.strip() or follow.lstrip().startswith("#"):
                continue
            indent = len(follow) - len(follow.lstrip())
            if indent == 0:
                break
            child = child or indent
            key = re.match(r"""^\s+["']?([a-z_]+)["']?\s*:""", follow)
            if indent == child and key:
                keys.add(key.group(1))
        return keys
    return set()


def run_blocks(text: str) -> list[str]:
    """Every run step's shell text, including multi-line block scalars."""
    lines, blocks = text.splitlines(), []
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)(?:- )?run:\s*(.*)$", line)
        if not match:
            continue
        indent, body = len(match.group(1)), [match.group(2)]
        if match.group(2).strip()[:1] in {"|", ">"}:
            cursor = index + 1
            while cursor < len(lines) and (
                not lines[cursor].strip()
                or len(lines[cursor]) - len(lines[cursor].lstrip()) > indent
            ):
                body.append(lines[cursor])
                cursor += 1
        blocks.append("\n".join(body))
    return blocks


def _environment_names(raw: str) -> set[str]:
    raw = re.sub(r"(^|\s)#.*$", "", raw).strip()
    if "${{" in raw:
        # An expression may select any of its literals, or anything its contexts carry.
        return {item.casefold() for item in re.findall(r"'([A-Za-z][A-Za-z0-9_-]*)'", raw)} | {
            DYNAMIC
        }
    return {raw.strip("'\"").casefold()} if raw else set()


def environments(text: str) -> set[str]:
    """Every environment a job could select, in scalar, block or flow form, quoted or not."""
    names: set[str] = set()
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^(\s+)environment:(.*)$", line)
        if not match:
            continue
        indent, value = len(match.group(1)), re.sub(r"(^|\s)#.*$", "", match.group(2)).strip()
        if value.startswith("{"):
            found = re.search(r"\bname:\s*([^,}]+)", value)
            names |= _environment_names(found.group(1)) if found else {DYNAMIC}
            continue
        if value:
            names |= _environment_names(value)
            continue
        for follow in lines[index + 1 :]:
            if follow.strip() and len(follow) - len(follow.lstrip()) <= indent:
                break
            found = re.match(r"^\s+name:(.*)$", follow)
            if found:
                names |= _environment_names(found.group(1))
    return names


def workflow_errors(text: str, live_anchor_files: set[str]) -> list[str]:
    errors = []
    if events(text) != {"pull_request_target", "workflow_dispatch"}:
        errors.append(
            f"triggers must be pull_request_target and workflow_dispatch, got {sorted(events(text))}"
        )
    triggers = re.search(r"(?ms)^on:\n(.*?)^\S", text)
    block = triggers.group(1) if triggers else ""
    if "branches: [main]" not in block:
        errors.append("pull_request_target must be limited to main")
    if not live_anchor_files <= set(re.findall(r"(?m)^      - (consent-protocol/\S+)$", block)):
        errors.append(f"paths must cover the live anchor files {sorted(live_anchor_files)}")
    top = "".join(re.findall(r"(?m)^permissions:\n(?:  .*\n)*", text))
    if "id-token" in top or "contents: read" not in top:
        errors.append("top-level permissions must be read-only without id-token")
    if text.count("\ncache-mode: read\n") != 1 or text.count("cache-mode:") != 1:
        errors.append("exactly one top-level cache-mode: read is required")
    jobs = re.search(r"(?ms)^jobs:[ \t]*\n(.*?)(?=^\S|\Z)", text)
    if not jobs or len(re.findall(r"""(?m)^  ["']?[\w-]+["']?\s*:""", jobs.group(1))) != 1:
        errors.append("the exam must be exactly one job")
    # The pinned expression is the only environment the exam may declare.
    if ENVIRONMENT_NAME not in text or len(ENVIRONMENT_KEY.findall(text)) != 1:
        errors.append(
            "the job must select the probe environment only for Main dispatches and same-repo PRs"
        )
    for rule, pattern in (
        ("timeout-minutes", r"(?m)^    timeout-minutes: \d+$"),
        ("job-only id-token", r"(?m)^      id-token: write$"),
        ("Main checkout", r"ref: \$\{\{ github\.workflow_sha \}\}\n\s+persist-credentials: false"),
    ):
        if not re.search(pattern, text):
            errors.append(f"missing {rule}")
    if text.count("actions/checkout@") != 1:
        errors.append("exactly one checkout (Main's) is allowed")
    for forbidden in ("github.head_ref", "allow-unsafe-pr-checkout", "actions/cache"):
        if forbidden in text:
            errors.append(f"forbidden reference: {forbidden}")
    if re.search(r"github\.event\.pull_request\.(?!number\b|head\.repo\.full_name\b)", text):
        errors.append("only the PR number and head repository may be read outside Main's script")
    for block_text in run_blocks(text):
        found = [item for item in SHELL_FORBIDDEN if item in block_text]
        if found:
            errors.append(f"a run step uses {found}; pass data through files, never PR refs")
    return errors


def environment_errors(workflows: dict[str, str]) -> list[str]:
    """Only the exam may use the probe environment; no other PR-reachable job uses any.

    Fail closed: a workflow that mentions a PR-reachable event anywhere counts as
    PR-reachable, and then no job of it, nor any local workflow it calls, may declare
    an environment in any form.
    """
    errors = []
    for name, text in sorted(workflows.items()):
        if PROBE_ENVIRONMENT in environments(text) and name != WORKFLOW.name:
            errors.append(f"{name}: only {WORKFLOW.name} may use {PROBE_ENVIRONMENT}")
        if name == WORKFLOW.name or not (events(text) & PR_REACHABLE or PR_EVENT.search(text)):
            continue
        if ENVIRONMENT_KEY.search(text):
            errors.append(f"{name}: a PR-reachable workflow may run no job in an environment")
        for callee in LOCAL_CALL.findall(text):
            if ENVIRONMENT_KEY.search(workflows.get(callee, "environment: unknown")):
                errors.append(f"{name}: a PR-reachable workflow calls {callee}, which uses one")
    return errors


def live_anchor_files() -> set[str]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {
        anchor["file"]
        for case in manifest["cases"]
        if case["pre_merge"] == "live"
        for anchor in case["anchors"]
    }


# PR-reachable workflows that must be refused; each names an environment some way.
ENVIRONMENT_LEAKS = {
    "block trigger": "on:\n  pull_request_target:\njobs:\n  x:\n    environment: uat\n",
    "scalar trigger": "on: pull_request_target\njobs:\n  x:\n    environment:\n      name: production\n",
    "flow-list trigger": "on: [push, workflow_run]\njobs:\n  x:\n    environment: dev\n",
    "issue_comment trigger": "on:\n  issue_comment:\njobs:\n  x:\n    environment: uat\n",
    "quoted name": "on: pull_request_target\njobs:\n  x:\n    environment: 'uat'\n",
    "flow mapping": 'on: [workflow_run]\njobs:\n  x:\n    environment: {name: "uat"}\n',
    "url before name": (
        "on:\n  pull_request_target:\njobs:\n  x:\n    environment:\n"
        "      url: https://x\n      name: production\n"
    ),
    "commented trigger": (
        "on: # PRs\n    pull_request_target:\njobs:\n  x:\n    environment: dev\n"
    ),
    "dynamic name": (
        "on:\n  pull_request_target:\njobs:\n  x:\n    environment: ${{ vars.TARGET }}\n"
    ),
    "PR-chosen name": (
        "on: pull_request_target\njobs:\n  x:\n    environment: ${{ github.head_ref || 'none' }}\n"
    ),
    "block-sequence trigger": "on:\n  - pull_request_target\njobs:\n  x:\n    environment: uat\n",
    "flow-mapping trigger": (
        "on: {pull_request_target: {branches: [main]}}\njobs:\n  x:\n    environment: uat\n"
    ),
    "value on the next line": (
        "on: pull_request_target\njobs:\n  x:\n    environment:\n      uat\n"
    ),
    "quoted key": 'on: pull_request_target\njobs:\n  x:\n    "environment": uat\n',
    "flow-mapping job": (
        "on: pull_request_target\njobs:\n  x: {runs-on: ubuntu-24.04, environment: uat}\n"
    ),
    "upper-case name": "on: pull_request_target\njobs:\n  x:\n    environment: UAT\n",
    "called deploy workflow": (
        "on: pull_request_target\njobs:\n  x:\n    uses: ./.github/workflows/callee.yml\n"
    ),
}
DEPLOY_CALLEE = "on: workflow_call\njobs:\n  x:\n    environment: uat\n"


def self_test(text: str, anchors: set[str], workflows: dict[str, str]) -> list[str]:
    """Negative controls: each known-bad edit must be refused."""
    step = "      - name: Grade anchored instruction text with Main's exam\n"
    injected_block = step.replace(
        "      - name:",
        '      - name: Inject\n        run: |\n          echo "${{ github.event.pull_request.title }}"\n\n      - name:',
    )
    fetched = step.replace(
        "      - name:",
        "      - name: Fetch\n        run: git fetch origin refs/pull/1/merge && git checkout FETCH_HEAD\n\n      - name:",
    )
    mutations = {
        "PR head checkout": text.replace(
            "${{ github.workflow_sha }}", "${{ github.event.pull_request.head.sha }}"
        ),
        "kept credentials": text.replace("persist-credentials: false", "persist-credentials: true"),
        "multi-line run interpolation": text.replace(step, injected_block),
        "PR ref fetch": text.replace(step, fetched),
        "pull_request trigger": text.replace("  pull_request_target:", "  pull_request:"),
        "stale paths": text.replace(
            "      - consent-protocol/hushh_mcp/one_adk/tavily_search.py\n", ""
        ),
        "top-level id-token": text.replace(
            "  pull-requests: read\n\ncache-mode",
            "  pull-requests: read\n  id-token: write\n\ncache-mode",
        ),
        "forks in the probe environment": text.replace(
            ENVIRONMENT_NAME, "      name: readiness-exam\n      deployment: false\n"
        ),
        "second flow-style job": text + "  second: {runs-on: ubuntu-24.04, environment: uat}\n",
        "merge ref in shell": text.replace(
            step,
            step.replace(
                "      - name:",
                "      - name: Merge\n        run: echo merge_commit_sha\n\n      - name:",
            ),
        ),
    }
    failures = [
        name for name, mutated in mutations.items() if not workflow_errors(mutated, anchors)
    ]
    for name, leaky in ENVIRONMENT_LEAKS.items():
        if not environment_errors({**workflows, "leaky.yml": leaky, "callee.yml": DEPLOY_CALLEE}):
            failures.append(name)
    return failures


# A stateful stand-in for `az` and `gh`. It answers only the exact queries the
# setup script must send (any other --query exits), and logs every call so the
# test can audit grants.
FAKE_CLOUD = r"""
import json, os, sys
path, log = os.environ["FAKE_STATE"], os.environ["FAKE_LOG"]
state, argv = json.load(open(path)), sys.argv[1:]
line = " ".join(argv)
open(log, "a").write(os.path.basename(sys.argv[0]) + " " + line + "\n")
EXACT = ("length([?name=='github-readiness-exam' && issuer=='https://token.actions."
         "githubusercontent.com' && subject=='repo:hushh-labs/hushh-research:environment:"
         "readiness-exam' && length(audiences) == `1` && audiences[0]=='api://AzureADTokenExchange'])")
ALLOWED = {"tenantId", "id", "appId", "[0].appId", "[0].id", "[].id", "length(@)", "length(value)",
           "[?properties.customSubDomainName=='oai-x'].id | [0]", "length([?scope=='/r/oai-x'])",
           "sum([length(passwordCredentials), length(keyCredentials), length(requiredResourceAccess)])",
           "sum([length(passwordCredentials), length(keyCredentials)])", EXACT}
query = argv[argv.index("--query") + 1] if "--query" in argv else None
if query is not None and query not in ALLOWED and not query.startswith("{publicNetworkAccess"):
    sys.exit("unexpected query: " + query)
app, sp = (state["apps"] or [None])[0], state["sp"]
def say(value): print(value)
def fail_if(flag):
    if state.get(flag): sys.exit(flag)
if os.path.basename(sys.argv[0]) == "gh":
    policies = state.get("policies", "branch:main")
    if "select(.type" in line: say("\n".join(p.split(":", 1)[1] for p in policies.split(",")))
    elif "join" in line: say(policies)
    else: say("{}")
elif line.startswith("account show"): say(state["tenant"])
elif line.startswith("account list"): say("sub-1")
elif line.startswith("ad signed-in-user show"): say("admin")
elif line.startswith("cognitiveservices account list"): say(state["resource"])
elif line.startswith("cognitiveservices account show"): say("{}")
elif line.startswith("ad app list"):
    say(len(state["apps"]) if query == "length(@)" else app["appId"] if app else "")
elif line.startswith("ad app create"):
    state["apps"] = [{"appId": "probe-app", "owners": ["admin"], "secrets": 0}]; say("probe-app")
elif line.startswith("ad sp list"): say(sp["id"] if sp else "")
elif line.startswith("ad sp create"):
    state["sp"] = {"id": "probe-sp", "owners": [], "secrets": 0}; say("probe-sp")
elif line.startswith("ad app owner list"): fail_if("owner_list_fails"); say("\n".join(app["owners"]))
elif line.startswith("ad sp owner list"): say("\n".join(sp["owners"]))
elif line.startswith("ad app show"): say(app["secrets"])
elif line.startswith("ad sp show"): say(sp["secrets"])
elif line.startswith("rest"):
    say(sp.get(next(k for k in ("appRoleAssignments", "oauth2PermissionGrants", "transitiveMemberOf") if k in line), 0))
elif line.startswith("ad app federated-credential list"):
    say(len(state["credentials"]) if query == "length(@)" else state["credentials"].count("exact"))
elif line.startswith("ad app federated-credential create"): state["credentials"].append("exact")
elif line.startswith("ad app federated-credential delete"):
    fail_if("credential_delete_fails"); state["credentials"].pop()
elif line.startswith("role assignment list"):
    say(len(state["roles"]) if "--include-groups" in argv else state["roles"].count("exact"))
elif line.startswith("role assignment create"):
    state["roles"].append(state.get("granted", "exact")); say("role-1")
elif line.startswith("role assignment delete"): fail_if("role_delete_fails"); state["roles"].pop()
else: sys.exit("unexpected call: " + line)
json.dump(state, open(path, "w"))
"""


def run_setup(state: dict) -> tuple[int, list[str]]:
    """Run the real setup script in a throwaway repo against the fake cloud."""
    with tempfile.TemporaryDirectory() as work:
        root, bin_dir = Path(work, "repo"), Path(work, "bin")
        config = root / "consent-protocol/config/managed-ai-runtime.json"
        config.parent.mkdir(parents=True)
        bin_dir.mkdir()
        account = {
            "tenant_id": "tenant",
            "client_id": "runtime-app",
            "primary_endpoint": "https://oai-x.openai.azure.com/openai/v1/",
        }
        config.write_text(json.dumps({"managed_azure_accounts": {"accounts": {"trial": account}}}))
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        for name in ("az", "gh"):
            tool = bin_dir / name
            tool.write_text(f"#!{sys.executable}\n{FAKE_CLOUD}")
            tool.chmod(0o755)
        state_path, log = Path(work, "state.json"), Path(work, "calls.log")
        state_path.write_text(json.dumps({"tenant": "tenant", "resource": "/r/oai-x", **state}))
        env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_STATE": str(state_path),
            "FAKE_LOG": str(log),
        }
        result = subprocess.run(
            ["bash", str(SETUP), "trial"],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode, log.read_text().splitlines() if log.exists() else []


def _grants(calls: list[str]) -> list[str]:
    return [c for c in calls if "federated-credential create" in c or "role assignment create" in c]


def setup_errors() -> list[str]:
    """Refuse a non-probe identity before any grant; roll back a bad result visibly."""
    sp = {"id": "probe-sp", "owners": [], "secrets": 0}
    app = {"appId": "probe-app", "owners": ["admin"], "secrets": 0}
    fresh = {"apps": [], "sp": None, "credentials": [], "roles": []}
    reused = {"apps": [app], "sp": sp, "credentials": ["exact"], "roles": ["exact"]}
    bare = {**reused, "credentials": [], "roles": []}
    errors = []
    code, calls = run_setup(fresh)
    if code != 0 or len(_grants(calls)) != 2:
        errors.append(f"a clean setup must grant both and pass (exit {code})")
    code, calls = run_setup(reused)
    if code != 0 or any(" create" in call for call in calls if call.startswith("az")):
        errors.append("an exact reused identity must pass without creating anything")
    refusals = {
        "another app owner": {**bare, "apps": [{**app, "owners": ["admin", "intruder"]}]},
        "an app secret": {**bare, "apps": [{**app, "secrets": 1}]},
        "another principal owner": {**bare, "sp": {**sp, "owners": ["intruder"]}},
        "a principal secret": {**bare, "sp": {**sp, "secrets": 1}},
        "a granted permission": {**bare, "sp": {**sp, "appRoleAssignments": 1}},
        "a delegated grant": {**bare, "sp": {**sp, "oauth2PermissionGrants": 1}},
        "a group or directory role": {**bare, "sp": {**sp, "transitiveMemberOf": 1}},
        "another trusted subject": {**bare, "credentials": ["foreign"]},
        "another role anywhere": {**bare, "roles": ["foreign"]},
        "an unreadable owner list": {**bare, "owner_list_fails": True},
        "an environment open to other branches": {**fresh, "policies": "branch:*,branch:main"},
    }
    for name, state in refusals.items():
        code, calls = run_setup(state)
        if code == 0 or _grants(calls):
            errors.append(f"an identity with {name} must be refused before any grant")
    code, calls = run_setup({**fresh, "granted": "wrong-scope"})
    deletes = {"role assignment delete", "federated-credential delete"}
    if code == 0 or not all(any(d in call for call in calls) for d in deletes):
        errors.append("a failed proof must roll back both grants it made")
    for flag in ("role_delete_fails", "credential_delete_fails"):
        code, _ = run_setup({**fresh, "granted": "wrong-scope", flag: True})
        if code != 3:
            errors.append(f"an incomplete rollback ({flag}) must say so and exit 3 (exit {code})")
    return errors


def main() -> int:
    text = WORKFLOW.read_text(encoding="utf-8")
    anchors = live_anchor_files()
    workflows = {
        p.name: p.read_text(encoding="utf-8") for p in (ROOT / ".github/workflows").glob("*.y*ml")
    }
    errors = workflow_errors(text, anchors) + environment_errors(workflows) + setup_errors()
    errors += [
        f"negative control not refused: {name}" for name in self_test(text, anchors, workflows)
    ]
    for error in errors:
        print(f"readiness exam workflow: {error}", file=sys.stderr)
    if not errors:
        print("Readiness exam workflow trust boundary verified.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
