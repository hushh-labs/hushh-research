# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""GitHub-backed cadence ledger, scoped dispatch authority and exact-run gates."""
from __future__ import annotations

import io
import json
import os
import re
import subprocess
import time
import zipfile
from pathlib import Path

from release_cadence import (
    CONTROLLER,
    WORKFLOWS,
    UnsafeRelease,
    account,
    adopt_cadence,
    cadence_at,
    dispatch_inputs,
    marker,
    milestone_lanes,
    new_state,
    require,
    source_receipt,
    state_digest,
    trusted_run,
    verified_uat,
    verify_child,
    verify_dispatch_inputs,
)

ROOT = Path(__file__).resolve().parents[2]


def api(path: str, data: dict | None = None, *, method: str | None = None, binary: bool = False):
    command = ["gh", "api", path, "-H", "X-GitHub-Api-Version: 2026-03-10"]
    if method or data is not None:
        command += ["--method", method or "POST"]
    if data is not None:
        command += ["--input", "-"]
    result = subprocess.run(command, input=json.dumps(data).encode() if data is not None else None,
                            capture_output=True, timeout=60, check=False)
    if result.returncode:
        if data is None and "HTTP 404" in result.stderr.decode(errors="replace"):
            return None
        raise UnsafeRelease(f"GitHub request failed: {method or ('POST' if data else 'GET')} {path}; inspect before retrying a dispatch")
    return result.stdout if binary else (json.loads(result.stdout) if result.stdout.strip() else {})


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def ancestor(older: str, newer: str) -> bool:
    return subprocess.run(["git", "merge-base", "--is-ancestor", older, newer], cwd=ROOT,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0


def configuration() -> tuple[dict, dict]:
    policy = json.loads((ROOT / "config/release-cadence.json").read_text())
    require(policy.get("testflight_every") == 2 and policy.get("production_every") == 4,
            "Unexpected release cadence policy")
    require(re.fullmatch(r"automation/[a-z0-9-]+", policy.get("state_branch", "")), "Invalid state ref")
    require(all(type(policy.get(k)) is bool for k in ("enabled", "submit_for_review", "release_after_approval")),
            "Invalid cadence switches")
    require(not policy["release_after_approval"] or policy["submit_for_review"], "Publication needs review submission")
    governance = json.loads((ROOT / "config/ci-governance.json").read_text())
    return policy, governance


class Ledger:
    """A state-only branch. Fast-forward-only updates provide compare-and-swap."""

    def __init__(self, repository: str, branch: str):
        require(re.fullmatch(r"[\w.-]+/[\w.-]+", repository), "Invalid repository")
        self.repository, self.branch = repository, branch
        self.base = f"repos/{repository}"
        ref = api(f"{self.base}/git/ref/heads/{branch}")
        self.head = ref["object"]["sha"] if ref else None
        self.tree = None
        self.state = None
        if self.head:
            commit = api(f"{self.base}/git/commits/{self.head}")
            self.tree = commit["tree"]["sha"]
            tree = api(f"{self.base}/git/trees/{self.tree}")
            entries = [item for item in tree["tree"] if item["path"] == "state.json" and item["type"] == "blob"]
            require(len(entries) == 1, "Cadence ledger has no unique state")
            blob = api(f"{self.base}/git/blobs/{entries[0]['sha']}")
            import base64
            self.state = json.loads(base64.b64decode(blob["content"]))
            require(self.state.get("schema_version") == 1, "Unsupported cadence ledger")
        self.saved_digest = state_digest(self.state) if self.state else None

    def verify_checkpoint(self) -> dict | None:
        # A writable Git ref is a locator, never production authorization. Bind
        # it to the newest immutable artifact published by the MAIN controller;
        # this rejects both forged state and replay of an older valid counter.
        artifacts = api(f"{self.base}/actions/artifacts?name=release-cadence-authority&per_page=100")["artifacts"]
        latest = None
        for artifact in sorted(artifacts, key=lambda a: a["created_at"], reverse=True):
            if artifact["expired"]:
                continue
            run = run_info(self.repository, artifact["workflow_run"]["id"])
            if trusted_run(run, self.repository, CONTROLLER):
                latest = artifact_json(self.repository, run["id"], "release-cadence-authority", "checkpoint.json")
                break
        if latest is None:
            require(self.state is None, "Cadence ledger has no immutable controller checkpoint")
            return
        require(self.head == latest["ledger_sha"] and state_digest(self.state) == latest["state_sha256"],
                "Cadence ledger differs from its newest immutable controller checkpoint; inspect state recovery")
        return latest

    def save(self, *, force: bool = False) -> None:
        # Quiet hourly checks do not create Git commits or artifact snapshots.
        # The weekly full replay refreshes the certificate before it expires.
        if not force and self.head and state_digest(self.state) == self.saved_digest:
            return
        self.state["writer_run_id"] = int(os.environ["GITHUB_RUN_ID"])
        blob = api(f"{self.base}/git/blobs", {"content": json.dumps(self.state, sort_keys=True), "encoding": "utf-8"})
        tree_data = {"tree": [{"path": "state.json", "mode": "100644", "type": "blob", "sha": blob["sha"]}]}
        if self.tree:
            tree_data["base_tree"] = self.tree
        tree = api(f"{self.base}/git/trees", tree_data)
        commit = api(f"{self.base}/git/commits", {
            "message": f"Record release cadence at successful UAT deployment {self.state['count']}",
            "tree": tree["sha"], "parents": [self.head] if self.head else [],
        })
        if self.head:
            api(f"{self.base}/git/refs/heads/{self.branch}", {"sha": commit["sha"], "force": False}, method="PATCH")
        else:
            api(f"{self.base}/git/refs", {"ref": f"refs/heads/{self.branch}", "sha": commit["sha"]})
        self.head, self.tree = commit["sha"], tree["sha"]
        self.saved_digest = state_digest(self.state)
        from datetime import datetime, timezone
        directory = Path(os.environ["RUNNER_TEMP"], "release-cadence-authority")
        directory.mkdir(exist_ok=True)
        (directory / "checkpoint.json").write_text(json.dumps({
            "ledger_sha": self.head, "state_sha256": state_digest(self.state),
            "checkpoint_at": datetime.now(timezone.utc).isoformat(),
        }, sort_keys=True))


def artifact_json(repository: str, run_id: int, name: str, filename: str, *, optional: bool = False) -> dict | None:
    result = api(f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100")
    candidates = [a for a in result["artifacts"] if a["name"] == name and not a["expired"]]
    if optional and not candidates:
        return None
    require(len(candidates) == 1, f"Missing unique {name} artifact for run {run_id}")
    data = api(f"repos/{repository}/actions/artifacts/{candidates[0]['id']}/zip", binary=True)
    require(len(data) < 64 * 1024 * 1024, "Release artifact exceeds admission bound")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        matches = [item for item in archive.infolist() if item.filename == filename]
        require(len(matches) == 1 and matches[0].file_size < 16 * 1024 * 1024, "Invalid release receipt")
        return json.loads(archive.read(matches[0]))


def receipt(repository: str, run_id: int, prefix: str, *, optional: bool = False) -> dict | None:
    return artifact_json(repository, run_id, f"{prefix}-release-{run_id}", f"{prefix}-release-status.json", optional=optional)


def runs(repository: str, workflow: str, since: str, *, until: str | None = None) -> list[dict]:
    from datetime import datetime, timezone
    from urllib.parse import urlencode
    end = until or datetime.now(timezone.utc).isoformat()
    result = []
    for page in range(1, 11):
        query = urlencode({"branch": "main", "created": f"{since}..{end}", "per_page": 100, "page": page})
        response = api(f"repos/{repository}/actions/workflows/{workflow}/runs?{query}")
        if response["total_count"] >= 1000:
            start_at = datetime.fromisoformat(since.replace("Z", "+00:00"))
            end_at = datetime.fromisoformat(end.replace("Z", "+00:00"))
            require((end_at - start_at).total_seconds() > 1, "Filtered run history reaches GitHub's 1,000-run cap in one second")
            midpoint = (start_at + (end_at - start_at) / 2).isoformat()
            halves = runs(repository, workflow, since, until=midpoint) + runs(repository, workflow, midpoint, until=end)
            return list({run["id"]: run for run in halves}.values())
        batch = response["workflow_runs"]
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise UnsafeRelease("History exceeds reconciliation bound; do not silently skip deployments")


def run_info(repository: str, run_id: int) -> dict:
    run = api(f"repos/{repository}/actions/runs/{run_id}")
    require(run, "Missing workflow run")
    return run


def verify_controller(run: dict, repository: str, governance: dict, event: dict | None = None) -> None:
    require(trusted_run(run, repository, CONTROLLER), "Controller must run from main in this repository")
    require(run.get("event") in {"workflow_run", "workflow_dispatch", "schedule", "repository_dispatch"},
            "Unsupported controller event")
    if run["event"] == "workflow_dispatch":
        require(run["actor"]["login"] in governance["production"]["manual_dispatch_users"],
                "Ungoverned reconciliation actor")
    if run["event"] == "repository_dispatch":
        require(run["actor"]["login"] == "github-actions[bot]", "Clock controller requires the repository bot")
        # Historical run metadata has no dispatch action. Its immutable
        # checkpoint certifies execution through this protected-main guard.
        if event is not None:
            require(event.get("action") == "capacity-maintenance-clock", "Wrong cadence clock event")
    if event is not None and run.get("run_attempt", 1) > 1:
        require((run.get("triggering_actor") or {}).get("login") in governance["production"]["manual_dispatch_users"],
                "Rerunning the controller requires a production operator")


def recorded_authority(repository: str, run: dict, state: dict | None = None) -> tuple[dict, str]:
    policy, _ = configuration()
    if state is None:
        ledger = Ledger(repository, policy["state_branch"])
        require(ledger.state, "Automation has no durable authority")
        require(ledger.verify_checkpoint(), "Automation has no immutable controller authority")
        state = ledger.state
    require(state, "Automation has no durable authority")
    for ordinal, request in state["requests"].items():
        if any(child.get("run_id") == run.get("id") for child in request["lanes"].values()):
            request, lane = verify_child(state, run, repository, ordinal, str(request["origin_run_id"]))
            origin = run_info(repository, request["origin_run_id"])
            _, governance = configuration()
            verify_controller(origin, repository, governance)
            source = state["sources"][request["sha"]]
            source_run = run_info(repository, source["run_id"])
            verified_uat(source_run, source["receipt"], repository, governance["uat"]["manual_dispatch_users"])
            return request, lane
    raise UnsafeRelease("Run is not bound to an authorized cadence request")


def authorize_current(surface: str, actor: str) -> dict | None:
    """Keep manual cohorts unchanged; a bot needs a recorded exact child run."""
    policy, governance = configuration()
    require(policy["enabled"], "Automatic releases are disabled")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    inputs = event.get("inputs") or {}
    origin, ordinal = inputs.get("cadence_origin", ""), inputs.get("cadence_ordinal", "")
    if not origin and not ordinal:
        require(actor in governance[surface]["manual_dispatch_users"], f"Actor is not governed for {surface}")
        return None
    require(actor == "github-actions[bot]" and str(origin).isdigit() and str(ordinal).isdigit(),
            "Invalid automatic release identity")
    require(os.environ.get("GITHUB_REF_NAME") == "main" and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
            "Automatic releases require a main dispatch")
    repository, run_id = os.environ["GITHUB_REPOSITORY"], int(os.environ["GITHUB_RUN_ID"])
    # Dispatch returns the run ID before the child starts, but allow its CAS
    # receipt a short propagation interval. A missing binding never authorizes.
    deadline = time.monotonic() + 660
    while True:
        try:
            current_run = run_info(repository, run_id)
            if current_run.get("run_attempt", 1) > 1:
                require((current_run.get("triggering_actor") or {}).get("login") in governance[surface]["manual_dispatch_users"],
                        "Rerunning an automatic release requires a governed operator")
            request, lane = recorded_authority(repository, current_run)
            break
        except UnsafeRelease:
            if time.monotonic() >= deadline:
                raise
            time.sleep(2)
    expected_surface = "uat" if lane == "testflight" else "production"
    require(governance[surface].get("automatic_release_workflow") == CONTROLLER, "Automatic surface is not governed")
    require(str(request["ordinal"]) == ordinal, "Wrong automatic deployment ordinal")
    require(surface == expected_surface and origin == str(request["origin_run_id"]), "Wrong automation surface")
    expected = dispatch_inputs(str(ordinal), request, lane)
    verify_dispatch_inputs(inputs, expected, lane)
    return request


def verify_recovery(ledger: Ledger, reviewed_head: str, controller: dict, governance: dict, policy: dict) -> None:
    """A governed operator can recertify an exact reviewed interrupted state."""
    require(controller.get("event") == "workflow_dispatch" and controller["actor"]["login"]
            in governance["production"]["manual_dispatch_users"], "Checkpoint recovery requires a production operator")
    require(reviewed_head == ledger.head and ledger.state, "Reviewed recovery head does not match the ledger")
    state = ledger.state
    require(state["count"] == len(state["sources"]), "Recovery counter does not match its sources")
    require(sorted(s["ordinal"] for s in state["sources"].values()) == list(range(1, state["count"] + 1)),
            "Recovery source ordinals are not contiguous")
    cadence_at(state, state["count"] + 1)
    expected_requests = {str(n) for n in range(1, state["count"] + 1) if milestone_lanes(n, cadence_at(state, n))}
    require(set(state["requests"]) == expected_requests, "Recovery milestones are incomplete")
    if state.get("cadence"):
        transition = run_info(ledger.repository, state["cadence"]["origin_run_id"])
        verify_controller(transition, ledger.repository, governance)
    for sha, source in state["sources"].items():
        require(ancestor(state["activation_sha"], sha), "Recovery source predates activation")
        observed = run_info(ledger.repository, source["run_id"])
        actual = receipt(ledger.repository, source["run_id"], "uat")
        require(verified_uat(observed, actual, ledger.repository, governance["uat"]["manual_dispatch_users"]) == sha,
                "Recovery source differs from its independently read UAT receipt")
        require(source["receipt"] == source_receipt(actual), "Recovery stored receipt has been altered")
    for ordinal, request in state["requests"].items():
        source = state["sources"].get(request["sha"], {})
        require(source.get("ordinal") == int(ordinal) == request.get("ordinal") and
                source.get("run_id") == request["uat_run_id"], "Recovery milestone source mismatch")
        expected_lanes = set(milestone_lanes(int(ordinal), cadence_at(state, int(ordinal))))
        require(set(request["lanes"]) == expected_lanes, "Recovery milestone lane mismatch")
        require(type(request["submit_for_review"]) is bool and type(request["release_after_approval"]) is bool and
                request["submit_for_review"] <= policy["submit_for_review"] and
                request["release_after_approval"] <= policy["release_after_approval"], "Recovery broadens publication policy")
        origin = run_info(ledger.repository, request["origin_run_id"])
        verify_controller(origin, ledger.repository, governance)
        for child in request["lanes"].values():
            if child.get("run_id"):
                verify_child(state, run_info(ledger.repository, child["run_id"]), ledger.repository,
                             ordinal, str(request["origin_run_id"]))


def reconcile(repository: str, controller_id: int, event: dict, full: bool = False, recovery_head: str = "") -> dict:
    policy, governance = configuration()
    require(policy["enabled"], "Release cadence is disabled")
    controller = run_info(repository, controller_id)
    verify_controller(controller, repository, governance, event)
    if controller["event"] == "repository_dispatch":
        require(not full and not recovery_head, "Clock events cannot request full replay or checkpoint recovery")
    ledger = Ledger(repository, policy["state_branch"])
    try:
        ledger.verify_checkpoint()
    except UnsafeRelease:
        require(recovery_head, "Checkpoint is inconsistent; a production operator must review its exact head before recovery")
        verify_recovery(ledger, recovery_head, controller, governance, policy)
        ledger.save(force=True)
    if ledger.state is None:
        anchor = git("log", "-1", "--format=%H", "--", "config/release-cadence.json")
        activated = git("show", "-s", "--format=%cI", anchor)
        ledger.state = new_state(anchor, activated)
        ledger.save()
    state = ledger.state
    adopt_cadence(state, controller_id, policy)
    since = state["activated_at"] if full else state.get("scan_after", state["activated_at"])
    inventory = runs(repository, "deploy-uat.yml", since)
    trigger = event.get("workflow_run") or {}
    if trigger.get("path") == ".github/workflows/deploy-uat.yml" and trigger.get("created_at", "") >= state["activated_at"]:
        inventory.append(run_info(repository, trigger["id"]))
    inventory = list({run["id"]: run for run in inventory}.values())
    seen_ids = {source["run_id"] for source in state["sources"].values()} | set(state.get("noops", []))
    for run in sorted(inventory, key=lambda r: (r.get("updated_at", ""), r["id"])):
        if run["id"] in seen_ids or run.get("conclusion") != "success" or not trusted_run(run, repository, "deploy-uat.yml"):
            continue
        # Never count old releases or rollbacks to a pre-policy source.
        if not ancestor(state["activation_sha"], run["head_sha"]):
            continue
        source = receipt(repository, run["id"], "uat", optional=True)
        if source is None:
            jobs = api(f"repos/{repository}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
            by_name = {job["name"]: job for job in jobs["jobs"]}
            require(jobs["total_count"] == len(jobs["jobs"]) and
                    by_name.get("Deploy UAT Scope", {}).get("conclusion") == "skipped" and
                    any(step.get("name") == "Summarize unchanged UAT target" and step.get("conclusion") == "success"
                        for step in by_name.get("Select UAT target", {}).get("steps", [])),
                    "Successful UAT run lacks both a release receipt and verified NO_OP proof")
            state.setdefault("noops", []).append(run["id"])
            continue
        sha = verified_uat(run, source, repository, governance["uat"]["manual_dispatch_users"])
        if not ancestor(state["activation_sha"], sha):
            continue
        account(state, run, source, sha, controller_id, policy)
    if inventory:
        unfinished = [r["created_at"] for r in inventory if r.get("status") != "completed"]
        state["scan_after"] = min(unfinished) if unfinished else max(r["created_at"] for r in inventory)
    ledger.save()
    reconcile_children(ledger, trigger.get("id"))
    dispatch_pending(ledger)
    if full:
        ledger.save(force=True)
    return state


def reconcile_children(ledger: Ledger, trigger_run_id: int | None = None) -> None:
    failures = {"failure", "cancelled", "timed_out", "action_required"}
    unresolved = [child for request in ledger.state["requests"].values() for child in request["lanes"].values()
                  if child["state"] in failures]
    require(len(unresolved) <= 20, "More than 20 unresolved release failures; operator recovery is required")
    for ordinal, request in ledger.state["requests"].items():
        for lane, child in request["lanes"].items():
            if child.get("run_id"):
                # A governed retry keeps the same recorded ID. Poll unresolved
                # failures too, so recovery does not depend on a completion hook.
                if child["state"] not in {"running"} | failures and child["run_id"] != trigger_run_id:
                    continue
                run = run_info(ledger.repository, child["run_id"])
                verify_child(ledger.state, run, ledger.repository, ordinal, str(request["origin_run_id"]))
                if run.get("run_attempt", 1) > child.get("run_attempt", 1):
                    _, governance = configuration()
                    surface = "uat" if lane == "testflight" else "production"
                    require((run.get("triggering_actor") or {}).get("login") in governance[surface]["manual_dispatch_users"],
                            "Release retry actor is not governed")
                child["run_attempt"] = run.get("run_attempt", 1)
                child["state"] = run.get("conclusion") if run["status"] == "completed" else "running"
                if lane == "appstore" and child["state"] == "success":
                    deferred = artifact_json(ledger.repository, run["id"], "ios-appstore-deferred", "ios-appstore-deferred.json", optional=True)
                    if deferred:
                        from datetime import datetime, timedelta, timezone
                        require(deferred.get("sha") == request["sha"] and deferred.get("reason") == "apple_review_pending",
                                "Deferred App Store receipt mismatch")
                        child.update(state="deferred", retry_after=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
                    else:
                        jobs = api(f"{ledger.base}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
                        require(jobs["total_count"] == len(jobs["jobs"]) and any(
                            job.get("name") == "Process and prepare uploaded App Store build" and job.get("conclusion") == "success"
                            and any(step.get("name") == "Prepare App Store version (set What's New, attach build; one-click submit)"
                                    and step.get("conclusion") == "success" for step in job.get("steps", []))
                            for job in jobs["jobs"]), "No positive App Store completion proof; a deferred receipt may have expired")
            elif child["state"] == "dispatching":
                matches = [r for r in runs(ledger.repository, WORKFLOWS[lane], child["intent_at"])
                           if r.get("display_title") == marker(ordinal, request, lane)]
                require(len(matches) == 1, "Dispatch outcome uncertain; inspect the cadence marker before recovery")
                child["run_id"] = matches[0]["id"]
                verify_child(ledger.state, matches[0], ledger.repository, ordinal, str(request["origin_run_id"]))
                child["state"] = "running"
    ledger.save()


def uat_busy(repository: str) -> bool:
    # Query each nonterminal status, not a recent unfiltered page: an older
    # queued deployment still has priority over a new release. These queries
    # observe this repository, not the organization's shared runner quota.
    for status in ("requested", "queued", "pending", "waiting", "in_progress"):
        result = api(f"repos/{repository}/actions/workflows/deploy-uat.yml/runs?status={status}&per_page=1")
        require(isinstance(result, dict) and type(result.get("total_count")) is int
                and result["total_count"] >= 0, "Cannot establish UAT release admission")
        if result["total_count"]:
            return True
    return False


def defer_release(message: str) -> None:
    summary = f"Release admission deferred: {message}. Pending work stays in the ledger; no runner waits.\n"
    print(summary, end="")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as handle:
            handle.write(summary)


def dispatch_pending(ledger: Ledger) -> None:
    from datetime import datetime, timezone
    requests = ledger.state["requests"]
    newest_production = max((int(ordinal) for ordinal, request in requests.items() if "deploy" in request["lanes"]), default=0)
    for ordinal, request in requests.items():
        child = request["lanes"].get("appstore", {})
        if child.get("state") == "deferred":
            if int(ordinal) < newest_production:
                child["state"] = "superseded"
            elif child["retry_after"] <= datetime.now(timezone.utc).isoformat():
                child.setdefault("deferred_runs", []).append(child.pop("run_id"))
                child["state"] = "pending"
    # Coalesce only work that has never started. An active production deploy
    # and its app remain a unit; a newer UAT release never cancels either.
    groups = (("deploy", "appstore"), ("testflight",))
    for lanes in groups:
        pending = sorted((ordinal for ordinal, request in requests.items()
                          if lanes[0] in request["lanes"] and request["lanes"][lanes[0]]["state"] == "pending"), key=int)
        for ordinal in pending[:-1]:
            for lane in lanes:
                requests[ordinal]["lanes"][lane]["state"] = "superseded"
    ledger.save()

    active = {(ordinal, "production" if lane in {"deploy", "appstore"} else lane)
              for ordinal, request in requests.items() for lane, child in request["lanes"].items()
              if child["state"] in {"running", "dispatching"}}

    def admit() -> bool:
        if uat_busy(ledger.repository):
            defer_release("UAT is queued or running")
            return False
        return True

    # Recover the second half even if the controller stopped immediately after
    # recording the production deployment. It yields to UAT and other active
    # bundles without losing the exact production run or redeploying it.
    for ordinal, request in sorted(requests.items(), key=lambda item: int(item[0])):
        children = request["lanes"]
        if ("deploy" in children and children["deploy"].get("run_id") and
                children["appstore"]["state"] == "pending"):
            if children["deploy"]["state"] in {"failure", "cancelled", "timed_out", "action_required"}:
                children["appstore"]["state"] = "blocked"
                ledger.save()
            else:
                if active - {(ordinal, "production")}:
                    defer_release("another release bundle is active")
                    return
                if not admit():
                    return
                dispatch_child(ledger, ordinal, request, "appstore")
                return
    if active:
        if any(child["state"] == "pending" for request in requests.values() for child in request["lanes"].values()):
            defer_release("another release bundle is active")
        return
    # A production deployment plus its archive is one bundle and remains
    # parallel. TestFlight waits for that bundle to finish, outside Actions.
    # Recorded starts keep continuous production milestones from starving
    # TestFlight, without adding scheduling state to the certified ledger.
    last_started = {lane: max((int(ordinal) for ordinal, request in requests.items()
                              if request["lanes"].get(lane, {}).get("run_id")), default=0)
                    for lane in ("deploy", "testflight")}
    if last_started["deploy"] > last_started["testflight"]:
        groups = tuple(reversed(groups))
    for lanes in groups:
        pending = [(ordinal, request) for ordinal, request in requests.items()
                   if lanes[0] in request["lanes"] and request["lanes"][lanes[0]]["state"] == "pending"]
        if not pending:
            continue
        ordinal, request = max(pending, key=lambda pair: int(pair[0]))
        for lane in lanes:
            # UAT can arrive between the two dispatches. Persist the half-pair
            # and resume later rather than posting another competing workflow.
            if not admit():
                return
            dispatch_child(ledger, ordinal, request, lane)
        return


def dispatch_child(ledger: Ledger, ordinal: str, request: dict, lane: str) -> None:
    from datetime import datetime, timezone
    child = request["lanes"][lane]
    child.update(state="dispatching", intent_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat())
    ledger.save()  # Write intent BEFORE the non-idempotent dispatch.
    response = api(f"{ledger.base}/actions/workflows/{WORKFLOWS[lane]}/dispatches",
                   {"ref": "main", "inputs": dispatch_inputs(ordinal, request, lane)})
    run_id = response.get("workflow_run_id")
    require(type(run_id) is int and run_id > 0 and response.get("html_url") ==
            f"https://github.com/{ledger.repository}/actions/runs/{run_id}", "Dispatch identity is uncertain")
    child.update(run_id=run_id, state="running")
    ledger.save()


def wait_production(repository: str, run_id: int, sha: str, timeout: int = 3600) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        run = run_info(repository, run_id)
        require(trusted_run(run, repository, WORKFLOWS["deploy"]) and run.get("event") == "workflow_dispatch",
                "Untrusted production deployment run")
        if run["status"] == "completed":
            break
        require(time.monotonic() < deadline, "Timed out waiting for production; upload remains blocked")
        time.sleep(15)
    _, governance = configuration()
    if (run.get("actor") or {}).get("login") not in governance["production"]["manual_dispatch_users"]:
        authority_deadline = min(deadline, time.monotonic() + 180)
        while True:
            try:
                request, lane = recorded_authority(repository, run)
                break
            except UnsafeRelease:
                require(time.monotonic() < authority_deadline, "Production controller authority is unavailable; upload blocked")
                time.sleep(5)
        require(lane == "deploy" and request["sha"] == sha, "Wrong automatic production source")
    require(run.get("conclusion") == "success", "Production deployment did not succeed; upload blocked")
    result = receipt(repository, run_id, "prod")
    require(result.get("status") == "healthy" and result.get("sha") == sha, "Production receipt is not healthy for this source")
    final, candidate = result.get("final", {}), result.get("candidate", {})
    require(final.get("backend_revision") and final["backend_revision"] == candidate.get("backend_revision") and
            result.get("verification", {}).get("backend_provenance") == "success" and
            result.get("verification", {}).get("backend_health") == "success", "Production backend receipt mismatch")
    return result
