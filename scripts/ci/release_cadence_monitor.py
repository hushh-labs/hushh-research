# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""GitHub-only observations; never grants release authority or dispatches work."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from release_cadence import (
    CONTROLLER,
    UnsafeRelease,
    require,
    trusted_run,
    verify_child,
)
from release_cadence_github import (
    api,
    artifact_json,
    configuration,
    git,
    receipt,
    run_info,
    runs,
)

TITLE = "UAT release monitor"
MARKER = "<!-- uat-release-monitor:v1 -->"
STATE = re.compile(r"<!-- uat-release-monitor-state:([A-Za-z0-9_=-]+) -->")
FAILURES = {"failure", "cancelled", "timed_out", "action_required", "startup_failure"}


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def read_journal(body: str) -> dict:
    match = STATE.search(body)
    return json.loads(base64.urlsafe_b64decode(match[1])) if match else {}


def evidence(repository: str, state: dict, ordinal: str, lane: str, child: dict, run: dict) -> str:
    request, actual_lane = verify_child(state, run, repository, ordinal, str(state["requests"][ordinal]["origin_run_id"]))
    require(actual_lane == lane, "Monitor child lane differs")
    sha, identity = request["sha"], child["run_id"]
    require(run["status"] == "completed" and run["conclusion"] == "success", "Monitor child is not successful")
    if lane == "deploy":
        value = receipt(repository, identity, "prod")
        require(value.get("sha") == sha and value.get("status") == "healthy" and
                value.get("verification", {}).get("backend_provenance") == "success" and
                value.get("verification", {}).get("backend_health") == "success", "Production receipt mismatch")
        return "Production deployment is healthy for the pinned source."
    if lane == "testflight":
        upload = artifact_json(repository, identity, "testflight-upload-receipt", "testflight-upload-receipt.json")
        require(upload.get("source_sha") == sha and upload.get("build_number"), "TestFlight upload source mismatch")
        distribution = artifact_json(repository, identity, f"one-voice-testflight-evidence-{sha}", "testflight-distribution.json")
        require(distribution.get("internal") == "active", "TestFlight internal distribution is not active")
        return "TestFlight upload and internal distribution verified; external Beta App Review may remain pending."
    deferred = artifact_json(repository, identity, "ios-appstore-deferred", "ios-appstore-deferred.json", optional=True)
    if deferred:
        require(deferred.get("sha") == sha and deferred.get("reason") == "apple_review_pending",
                "App Store deferral source mismatch")
        return "App Store candidate deferred while Apple review is pending; no publication claimed."
    value = artifact_json(repository, identity, f"ios-appstore-redacted-evidence-{identity}", "ios-appstore-release-evidence.json")
    require(value.get("source_sha") == sha and value.get("backend_target") == "production"
            and value.get("dry_run") is False and value.get("export_outcome") == "success"
            and value.get("appstore_outcome") == "success", "App Store build evidence mismatch")
    apple = value.get("appstore_state") or {}
    if request["submit_for_review"]:
        require(apple.get("submission_attempted") is True and apple.get("submission_id")
                and apple.get("submission_state") in {"WAITING_FOR_REVIEW", "IN_REVIEW"},
                "Apple review submission is not confirmed")
    if request["release_after_approval"]:
        require(apple.get("release_type") == "AFTER_APPROVAL", "Automatic publication policy mismatch")
    return ("Production-backed build and Apple review submission verified; publication still depends on Apple approval."
            if request["submit_for_review"] else "Production-backed build prepared; no review submission or publication claimed.")


def observations(repository: str, state: dict | None, event: dict, previous: dict, healthy: bool) -> tuple[dict, list[str]]:
    """Reuse certified accounting; bounded incremental reads supply observations."""
    observed = json.loads(json.dumps(previous))
    seen = observed.setdefault("seen", {})
    notices = []

    def note(key: str, signature: str, message: str) -> None:
        if seen.get(key) != signature:
            notices.append(message)
        seen[key] = signature

    if not healthy:
        note("controller-health", "failure", "Cadence accounting or checkpoint publication failed. Inspect the controller run before recovery.")
    else:
        if seen.get("controller-health") == "failure":
            notices.append("Cadence accounting and checkpoint publication recovered.")
        seen["controller-health"] = "healthy"
    trigger = event.get("workflow_run") or {}
    since = observed.get("scan_after") or git("log", "-1", "--format=%cI", "--", "scripts/ci/release_cadence_monitor.py")
    inventory = runs(repository, "deploy-uat.yml", since)
    if trusted_run(trigger, repository, "deploy-uat.yml"):
        inventory.append(run_info(repository, trigger["id"]))
    inventory = list({item["id"]: item for item in inventory}.values())
    highwater, pending_uat = previous.get("uat_highwater", 0), set(previous.get("pending_uat", []))
    inventory = [item for item in inventory if item["id"] > highwater or item["id"] in pending_uat
                 or item["id"] == trigger.get("id") or item.get("status") != "completed"]
    for run in inventory:
        if not trusted_run(run, repository, "deploy-uat.yml"):
            continue
        identity, attempt = run["id"], run.get("run_attempt", 1)
        url = f"https://github.com/{repository}/actions/runs/{identity}"
        if run.get("conclusion") in FAILURES:
            note(f"uat:{identity}", f"{attempt}:{run['conclusion']}",
                 f"UAT [run {identity}]({url}), attempt {attempt}: {run['conclusion']}. It does not advance the cadence counter.")
    # Keep the oldest unfinished creation boundary. Completion events also
    # explicitly include reruns whose original creation predates this cursor.
    if inventory:
        unfinished = [item["created_at"] for item in inventory if item.get("status") != "completed"]
        observed["scan_after"] = min(unfinished) if unfinished else max(item["created_at"] for item in inventory)
        observed["pending_uat"] = [item["id"] for item in inventory if item.get("status") != "completed"]
        observed["uat_highwater"] = max([highwater] + [item["id"] for item in inventory if item.get("status") == "completed"])
    intervals = observed.setdefault("release_intervals", {})
    if state is not None and healthy:
        for ordinal, request in state["requests"].items():
            for lane, child in request["lanes"].items():
                identity = child.get("run_id")
                key = f"release:{ordinal}:{lane}"
                if (int(ordinal) <= previous.get("release_highwater", 0) and
                        key not in previous.get("pending_releases", []) and child["state"] not in FAILURES
                        and identity != trigger.get("id")):
                    continue
                if not identity or child["state"] in {"superseded", "pending"}:
                    continue
                signature = f"{identity}:{child.get('run_attempt', 1)}:{child['state']}"
                if child["state"] == "running" or seen.get(key) != signature:
                    run = run_info(repository, identity)
                    verify_child(state, run, repository, ordinal, str(request["origin_run_id"]))
                    intervals[str(identity)] = {"id": identity, "created_at": run["created_at"],
                                                "completed_at": run.get("updated_at") if run["status"] == "completed" else None}
                    if seen.get(key) != signature:
                        message = f"Milestone {ordinal}, {lane}, source {request['sha']}: {child['state']}. [Exact run](https://github.com/{repository}/actions/runs/{identity})."
                        if child["state"] in {"success", "deferred"}:
                            try:
                                message += " " + evidence(repository, state, ordinal, lane, child, run)
                            except UnsafeRelease as exc:
                                message += f" Verification failed: {exc}."
                                signature += ":verification-failed"
                        note(key, signature, message)
        observed["release_highwater"] = max([previous.get("release_highwater", 0)] +
                                           [int(ordinal) for ordinal in state["requests"]])
        observed["pending_releases"] = [f"release:{ordinal}:{lane}" for ordinal, request in state["requests"].items()
                                       for lane, child in request["lanes"].items()
                                       if child["state"] in {"pending", "running", "dispatching", "deferred"} | FAILURES]
    recent = sorted(intervals.values(), key=lambda item: item["created_at"], reverse=True)
    observed["release_intervals"] = {str(item["id"]): item for index, item in enumerate(recent)
                                     if index < 40 or not item["completed_at"]}
    # Job timestamps are observational only. No queue or provider is mutated.
    # Completed UAT events prove overlap; hourly checks can flag long queues.
    for run in inventory:
        if not intervals or not trusted_run(run, repository, "deploy-uat.yml"):
            continue
        attempt = run.get("run_attempt", 1)
        key = f"overlap:{run['id']}:{attempt}"
        if seen.get(key) == "observed":
            continue
        now = datetime.now(UTC)
        overlapping = [child for child in intervals.values()
                       if timestamp(child["created_at"]) <= (timestamp(run["updated_at"]) if run["status"] == "completed" else now)
                       and (not child["completed_at"] or timestamp(child["completed_at"]) >= timestamp(run["created_at"]))]
        if not overlapping:
            continue
        jobs = api(f"repos/{repository}/actions/runs/{run['id']}/attempts/{attempt}/jobs?per_page=100")
        require(jobs["total_count"] == len(jobs["jobs"]), "UAT job evidence is truncated")
        starts = [job["started_at"] for job in jobs["jobs"] if job.get("started_at")]
        if starts:
            start = timestamp(min(starts))
            overlapping = [child for child in overlapping if timestamp(child["created_at"]) <= start and
                           (not child["completed_at"] or timestamp(child["completed_at"]) >= start)]
            if overlapping:
                note(key, "observed", f"UAT run {run['id']} started while recorded release runs "
                     f"{', '.join(str(child['id']) for child in overlapping)} were active. "
                     "This demonstrates progress for this overlap, not reserved runner capacity.")
            elif seen.get(key) == "queue-warning":
                note(key, "observed", f"UAT run {run['id']} has started after its earlier queue warning. "
                     "A release overlap at its start was not demonstrated; no causal delay claim is made.")
        elif run["status"] != "completed" and attempt == 1 and (now - timestamp(run["created_at"])).total_seconds() > 600:
            note(key, "queue-warning", f"UAT run {run['id']} has no started job after 10 minutes while recorded releases are active. "
                 "Possible shared-runner contention; UAT concurrency and other organization jobs may also explain the delay.")
    # Watermarks, plus explicit unfinished runs, prevent replay when old final
    # fingerprints leave this bounded window. Rerun completion events override
    # the watermark and still receive fresh verification.
    retained = set(list(seen)[-160:]) | set(observed.get("pending_releases", []))
    observed["seen"] = {key: value for key, value in seen.items() if key in retained}
    return observed, notices


def find_issue(repository: str) -> dict | None:
    matches = []
    for page in range(1, 6):
        batch = api(f"repos/{repository}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page={page}")
        matches.extend(item for item in batch if item.get("title") == TITLE and MARKER in (item.get("body") or "")
                       and item.get("user", {}).get("login") == "github-actions[bot]" and not item.get("pull_request"))
        if len(batch) < 100:
            require(len(matches) <= 1, "Multiple release monitor issues; inspect before reporting")
            return matches[0] if matches else None
    raise UnsafeRelease("Release monitor issue inventory is truncated")


def issue_body(state: dict | None, journal: dict, controller: int) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps(journal, sort_keys=True).encode()).decode()
    require(len(encoded) < 55000, "Release monitor journal needs archival before GitHub's body limit")
    count = str(state["count"]) if state else "unavailable"
    lines = [MARKER, "# Automatic UAT release monitoring", "",
             f"Verified UAT count: {count}. TestFlight every 2; production every 4.",
             "Completion events and the existing hourly fallback run in GitHub; no laptop is needed.",
             "UAT has separate dependencies and locks. Shared runner capacity is best effort.", "",
             f"Last controller: {controller}. Run links and verified milestones appear in comments."]
    if state:
        retained = sorted(state["requests"], key=int)
        visible = set(retained[-12:]) | {ordinal for ordinal in retained
                  if any(child["state"] in {"pending", "running", "dispatching", "deferred"}
                         for child in state["requests"][ordinal]["lanes"].values())}
        for ordinal in retained:
            if ordinal not in visible:
                continue
            request = state["requests"][ordinal]
            lanes = ", ".join(f"{lane}: {child['state']}" for lane, child in request["lanes"].items())
            lines.append(f"- Milestone {ordinal}, source {request['sha']}: {lanes}.")
    body = "\n".join(lines) + f"\n\n<!-- uat-release-monitor-state:{encoded} -->\n"
    require(len(body) < 60000, "Release monitor issue needs archival before GitHub's body limit")
    return body


def publish(repository: str, issue: dict | None, state: dict | None, journal: dict, notices: list[str],
            controller: int, assignee: str) -> None:
    base = f"repos/{repository}/issues"
    if issue is None:
        issue = api(base, {"title": TITLE, "body": issue_body(state, {}, controller), "assignees": [assignee]})
    path = f"{base}/{issue['number']}"
    old = read_journal(issue.get("body") or "")
    # A persisted outbox makes an accepted-but-lost comment recoverable without
    # blindly posting a second alert. Only a bot-authored marker acknowledges it.
    pending = old.get("pending_notice")
    if pending:
        last_page = max(1, (issue.get("comments", 0) + 99) // 100)
        comments = []
        for page in sorted({max(1, last_page - 1), last_page}):
            comments += api(f"{path}/comments?per_page=100&page={page}")
        found = any(pending["marker"] in (comment.get("body") or "") and
                    comment.get("user", {}).get("login") == "github-actions[bot]" for comment in comments)
        if not found:
            # Notification transport has no deployment authority. Recheck the
            # marker before one controlled retry; do not permanently lose alerts
            # after a definite or ambiguous notification failure.
            api(f"{path}/comments", {"body": pending["body"]})
        # Acknowledge the prior alert, then still report this event. No alert
        # transport operation ever changes the certified release ledger.
        api(path, {"body": issue_body(state, pending["journal"], controller)}, method="PATCH")
        old = pending["journal"]
    if notices:
        text = "\n\n".join(notices)
        marker = "<!-- uat-release-notice:" + hashlib.sha256(text.encode()).hexdigest() + " -->"
        comment = marker + "\n\n" + text + f"\n\n[Controller run](https://github.com/{repository}/actions/runs/{controller})"
        pending = {"marker": marker, "journal": journal, "body": comment}
        api(path, {"body": issue_body(state, {**old, "pending_notice": pending}, controller), "state": "open"}, method="PATCH")
        api(f"{path}/comments", {"body": comment})
    body = issue_body(state, journal, controller)
    if body != issue.get("body"):
        api(path, {"body": body}, method="PATCH")
    print(f"Release monitoring: https://github.com/{repository}/issues/{issue['number']}")


def main() -> int:
    repository, controller = os.environ["GITHUB_REPOSITORY"], int(os.environ["GITHUB_RUN_ID"])
    require(os.environ["GITHUB_REF_NAME"] == "main", "Monitor requires protected main")
    require(trusted_run(run_info(repository, controller), repository, CONTROLLER), "Untrusted monitor controller")
    policy, governance = configuration()
    assignee = policy["monitor_issue_assignee"]
    require(assignee in governance["production"]["manual_dispatch_users"], "Monitor recipient is not governed")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    path = Path(os.environ["RUNNER_TEMP"], "release-cadence-monitor.json")
    state = json.loads(path.read_text()) if path.exists() else None
    issue = find_issue(repository)
    previous = read_journal(issue.get("body") or "") if issue else {}
    previous = previous.get("pending_notice", {}).get("journal", previous)
    if issue is None and state is not None:
        previous["release_highwater"] = state["count"]
        previous["pending_releases"] = [f"release:{ordinal}:{lane}" for ordinal, request in state["requests"].items()
                                       for lane, child in request["lanes"].items()
                                       if child["state"] in {"pending", "running", "dispatching", "deferred"}]
    healthy = state is not None and os.environ.get("CHECKPOINT_OUTCOME") == "success"
    journal, notices = observations(repository, state, event, previous, healthy)
    publish(repository, issue, state, journal, notices, controller, assignee)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (UnsafeRelease, ValueError, KeyError) as exc:
        raise SystemExit(f"Release monitor could not verify/report: {exc}") from exc
