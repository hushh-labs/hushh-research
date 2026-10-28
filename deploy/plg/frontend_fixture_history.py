"""Reconcile only the fixed private frontend fixture under the shared writer lock.

No local receipt or callback clears a prior attempt. Closure comes from genuine
Main hosted acceptance/recovery or a native terminal build with no service step.
Unknown provider outcomes remain blocked; explicit recovery can finish a known
owned candidate route using its original published immutable stage document.
"""

from __future__ import annotations

import json
import os
import re

import frontend_fixture_github as inventory
import frontend_fixture_acceptance as acceptance
import frontend_fixture_candidate as candidate
import frontend_release as release
import yaml


def _started(job, name):
    rows = [row for row in job.get("steps", []) if row.get("name") == name]
    release.require(len(rows) == 1, "Fixture mutation step missing")
    row = rows[0]
    if row.get("status") in {"queued", "pending"} and row.get("started_at") is None:
        return False
    if (
        row.get("status") == "completed"
        and row.get("conclusion") == "skipped"
        and row.get("started_at") is None
    ):
        return False
    # A cancelled step with no start timestamp is uncertain, never absence.
    return True


def _jobs(client, run, attempt, environment):
    document = acceptance.fresh(
        client, f"runs/{run['id']}/attempts/{attempt}/jobs?per_page=100"
    )
    rows = document.get("jobs", [])
    release.require(
        document.get("total_count") == len(rows) == 1
        and rows[0].get("name") == acceptance.JOB,
        "Fixture historical jobs ambiguous",
    )
    job = rows[0]
    release.require(
        job.get("run_id") == run["id"]
        and job.get("run_attempt") == attempt
        and job.get("head_sha") == run["head_sha"]
        and job.get("status") == "completed",
        "Fixture historical job unbound",
    )
    source = yaml.safe_load(
        release.source.backend._git(
            "show", run["head_sha"] + ":" + acceptance.workflow(environment)
        )
    )
    names = {step["name"] for step in source["jobs"]["fixture"]["steps"]}
    allowed = (
        names | {"Post " + name for name in names} | {"Set up job", "Complete job"}
    )
    observed = [step.get("name") for step in job.get("steps", [])]
    release.require(
        len(observed) == len(set(observed)) and set(observed) <= allowed,
        "Fixture historical steps unreviewed",
    )
    return job


def _list(client, environment):
    def api(_repository, path):
        return acceptance.fresh(client, path)

    return inventory._history(
        acceptance.validation.transport.REPOSITORY,
        api,
        acceptance.hosted._stamp,
        None,
        workflow_name=acceptance.workflow(environment).rsplit("/", 1)[1],
    )


def _terminal_build(cloud, project, tag):
    raw = cloud.command(
        "builds",
        "list",
        "--project=" + project,
        "--filter=tags=" + tag,
        "--limit=2",
        "--format=json",
    )
    builds = json.loads(raw)
    release.require(
        isinstance(builds, list)
        and len(builds) == 1
        and builds[0].get("projectId") == project
        and builds[0].get("tags") == [tag]
        and builds[0].get("status")
        in {"SUCCESS", "FAILURE", "CANCELLED", "TIMEOUT", "EXPIRED"},
        "Fixture build outcome requires reconciliation",
    )
    return builds[0]["id"]


def never_requested(client, run, job, environment, phase, step):
    import frontend_fixture_request_state as state

    return state.never_requested(
        client, run, job, environment, phase, step, acceptance=acceptance
    )


def recovery(environment, run_id, attempt, *, github=None):
    client = acceptance.client_or(github)
    run, job = acceptance.completed(
        client,
        environment,
        run_id,
        attempt,
        [acceptance.RECOVER_UPLOAD, acceptance.RECOVER_STEP, acceptance.RECOVER_OUTPUT],
        success=True,
    )
    item, result = acceptance.artifact(
        client,
        run,
        job,
        environment,
        "recovery",
        acceptance.RECOVER_OUTPUT,
        "recovery.json",
    )
    _intent_item, intent = acceptance.artifact(
        client,
        run,
        job,
        environment,
        "recovery-intent",
        acceptance.RECOVER_UPLOAD,
        "recovery-intent.json",
    )
    origin = intent.get("origin", {})
    staged = acceptance.stage_intent(
        environment, origin.get("runId"), origin.get("attempt"), github=client
    )
    release.require(
        intent.get("kind") == "plg-fixture-route-recovery-intent-v1"
        and intent.get("stageIntent")
        == {key: staged[key] for key in ("artifactId", "artifactDigest")}
        and result.get("kind") == "plg-fixture-retained-recovery-v1"
        and result.get("origin") == origin
        and result.get("stageIntent") == intent["stageIntent"]
        and result.get("productionTrafficAuthorized") is False,
        "Fixture recovery artifact unbound",
    )
    expected = staged["document"]["serviceDocument"]
    observed = result.get("candidate", {})
    acceptance.observation(observed, staged["document"])
    release.require(
        observed.get("revision") == expected["spec"]["template"]["metadata"]["name"]
        and observed.get("imageReference")
        == staged["document"]["buildEvidence"]["imageReference"]
        and all(
            isinstance(observed.get(key), str) and observed[key]
            for key in ("serviceUid", "revisionUid", "resourceVersion")
        ),
        "Fixture recovery observation invalid",
    )
    return (
        origin,
        staged["document"],
        observed,
        {
            "runId": run_id,
            "attempt": attempt,
            "artifactId": item["id"],
            "artifactDigest": item["digest"],
        },
    )


def check(environment, *, purpose="qualify", origin=None, github=None, native=None):
    """Authenticate all prior fixture attempts; no provider write happens here."""
    release.require(
        purpose in {"qualify", "recover"}, "Fixture history purpose invalid"
    )
    client = acceptance.client_or(github)
    before = _list(client, environment)
    source_sha = os.environ.get("GITHUB_SHA", "")
    release.require(
        re.fullmatch(r"[0-9a-f]{40}", source_sha),
        "Fixture history Main authority missing",
    )
    current_id = int(os.environ.get("GITHUB_RUN_ID", "0"))
    current_attempt = int(os.environ.get("GITHUB_RUN_ATTEMPT", "0"))
    stages, closed, recoveries, unfinished_recoveries = {}, {}, [], []
    cloud = native or candidate.Cloud(environment)
    policy = json.loads((release.ROOT / "config/ci-governance.json").read_bytes())[
        environment
    ]["manual_dispatch_users"]
    for listed in before:
        _inspect_run(
            client,
            listed,
            environment,
            current_id,
            current_attempt,
            cloud,
            policy,
            stages,
            closed,
            recoveries,
            unfinished_recoveries,
        )
    _close_history(stages, closed, recoveries, unfinished_recoveries, purpose, origin)
    release.require(
        [inventory._identity(row) for row in _list(client, environment)]
        == [inventory._identity(row) for row in before],
        "Fixture history inventory changed",
    )
    latest = max(closed) if closed else None
    current = cloud.service(missing=True)
    if latest is None:
        release.require(
            current is None or purpose == "recover",
            "Fixture preexisting service unowned",
        )
    elif purpose != "recover":
        observed = candidate.observe(cloud, stages[latest]["serviceDocument"])
        release.require(
            all(
                observed.get(field) == closed[latest].get(field)
                for field in (
                    "serviceUid",
                    "revisionUid",
                    "revision",
                    "imageReference",
                    "serviceUrl",
                    "candidateUrl",
                )
            ),
            "Fixture baseline changed",
        )
    return {
        "previousService": current,
        "pendingOrigin": origin,
        "stageDocument": stages.get(origin),
        "closedOrigins": [
            {"runId": key[0], "attempt": key[1]} for key in sorted(closed)
        ],
        "productionTrafficAuthorized": False,
    }


def _inspect_run(
    client,
    listed,
    environment,
    current_id,
    current_attempt,
    cloud,
    policy,
    stages,
    closed,
    recoveries,
    unfinished_recoveries,
):
    run = acceptance.fresh(client, f"runs/{listed['id']}")
    release.require(
        inventory._identity(run) == inventory._identity(listed)
        and run.get("path") == acceptance.workflow(environment)
        and run.get("head_branch") == "main"
        and run.get("event") == "workflow_dispatch"
        and run.get("repository", {}).get("id") == acceptance.hosted.REPOSITORY_ID
        and run.get("head_repository", {}).get("id") == acceptance.hosted.REPOSITORY_ID
        and all(
            run.get(key, {}).get("login") in policy
            for key in ("actor", "triggering_actor")
        )
        and type(run.get("run_attempt")) is int
        and 1 <= run["run_attempt"] <= inventory.MAX_ATTEMPTS,
        "Fixture history run unverified",
    )
    acceptance.hosted._reviewed_authority(
        run["head_sha"], acceptance.workflow(environment)
    )
    for number in range(1, run["run_attempt"] + 1):
        if run["id"] == current_id and number == current_attempt:
            continue  # current() authenticated this attempt independently
        _inspect_attempt(
            client,
            run,
            number,
            environment,
            cloud,
            stages,
            closed,
            recoveries,
            unfinished_recoveries,
        )
    release.require(
        inventory._identity(acceptance.fresh(client, f"runs/{run['id']}"))
        == inventory._identity(run),
        "Fixture history changed",
    )


def _read_prior_attempt(client, run, number):
    attempt = acceptance.fresh(client, f"runs/{run['id']}/attempts/{number}")
    release.require(
        attempt.get("id") == run["id"]
        and attempt.get("head_sha") == run["head_sha"]
        and attempt.get("run_attempt") == number,
        "Fixture historical attempt unbound",
    )
    if number == run["run_attempt"] and run.get("status") in {
        "queued",
        "waiting",
        "pending",
    }:
        # A queued rerun never conceals any completed earlier attempt.
        queued = acceptance.fresh(
            client, f"runs/{run['id']}/attempts/{number}/jobs?per_page=100"
        )
        rows = queued.get("jobs", [])
        release.require(
            attempt.get("status") in {"queued", "waiting", "pending"}
            and queued.get("total_count") == len(rows) <= 1
            and all(
                row.get("name") == acceptance.JOB
                and row.get("status") in {"queued", "waiting", "pending"}
                and all(step.get("started_at") is None for step in row.get("steps", []))
                for row in rows
            ),
            "Fixture queued attempt may have started",
        )
        return None
    release.require(
        attempt.get("status") == "completed" and attempt.get("run_attempt") == number,
        "Fixture historical attempt still running",
    )
    return attempt


def _inspect_attempt(
    client,
    run,
    number,
    environment,
    cloud,
    stages,
    closed,
    recoveries,
    unfinished_recoveries,
):
    attempt = _read_prior_attempt(client, run, number)
    if attempt is None:
        return
    job = _jobs(client, run, number, environment)
    key = (run["id"], number)
    if _started(job, acceptance.STAGE_STEP) and not never_requested(
        client, attempt, job, environment, "stage", acceptance.STAGE_STEP
    ):
        staged = acceptance.stage_intent(environment, *key, github=client)
        stages[key] = staged["document"]
        if attempt.get("conclusion") == "success":
            acceptance.verify(environment, *key, github=client)
            _item, result = acceptance.artifact(
                client,
                attempt,
                job,
                environment,
                "acceptance",
                acceptance.ACCEPT_UPLOAD,
                "acceptance.json",
            )
            closed[key] = result["candidate"]
    elif _started(job, acceptance.BUILD_STEP) and not never_requested(
        client, attempt, job, environment, "build", acceptance.BUILD_STEP
    ):
        attempt_value = release.Attempt(
            environment, run["head_sha"], str(run["id"]), str(number)
        )
        _terminal_build(cloud.gcloud, attempt_value.project, attempt_value.tag)
    if _started(job, acceptance.RECOVER_STEP) and not (
        attempt.get("conclusion") != "success"
        and never_requested(
            client,
            attempt,
            job,
            environment,
            "recover",
            acceptance.RECOVER_STEP,
        )
    ):
        if attempt.get("conclusion") == "success":
            recovered_origin, plan, observed, pin = recovery(
                environment, *key, github=client
            )
            recovered_key = (
                recovered_origin["runId"],
                recovered_origin["attempt"],
            )
            recoveries.append((recovered_key, plan, observed, pin))
        else:
            _item, recovery_intent = acceptance.artifact(
                client,
                attempt,
                job,
                environment,
                "recovery-intent",
                acceptance.RECOVER_UPLOAD,
                "recovery-intent.json",
            )
            unfinished_recoveries.append(recovery_intent.get("origin"))


def _close_history(stages, closed, recoveries, unfinished_recoveries, purpose, origin):
    for key, plan, observed, _pin in recoveries:
        release.require(
            key in stages and stages[key] == plan,
            "Fixture recovery has no matching stage",
        )
        if key in closed:
            release.require(
                all(
                    closed[key].get(field) == observed.get(field)
                    for field in (
                        "serviceUid",
                        "revisionUid",
                        "revision",
                        "imageReference",
                    )
                ),
                "Fixture recovery identity conflict",
            )
        closed[key] = observed
    pending = set(stages) - set(closed)
    if purpose == "recover":
        release.require(
            isinstance(origin, tuple) and pending == {origin},
            "Fixture recovery must target sole pending stage",
        )
    else:
        release.require(
            not pending, "Fixture service operation needs explicit recovery"
        )
    release.require(
        all(
            isinstance(value, dict)
            and (value.get("runId"), value.get("attempt"))
            in (set(closed) | ({origin} if origin else set()))
            for value in unfinished_recoveries
        ),
        "Fixture interrupted recovery unresolved",
    )
