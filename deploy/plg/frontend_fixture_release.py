"""Fixed private fixture release capability; no independent release authority."""

from __future__ import annotations

import base64
import os
from pathlib import Path
import frontend_backend_pair as backend
import frontend_fixture_runtime as runtime
import frontend_hosted_preflight as preflight
import frontend_release as release

from frontend_fixture_io import write, load, inspect_inputs, fingerprint, capacity
from frontend_fixture_request_state import requesting


def audience(environment, backend_run):
    attempt = preflight.context(environment)
    release.reviewed_inputs(attempt)
    pair = backend.inspect(environment, backend_run)
    output = Path(os.environ.get("GITHUB_OUTPUT", ""))
    release.require(
        output.is_absolute() and output.is_file(), "Fixture hosted output missing"
    )
    with output.open("a", encoding="utf-8") as stream:
        stream.write("audience=" + pair["serviceUrl"] + "\n")


def prepare(environment, validation_run, backend_run, dev_run=None):
    result = preflight.prepare(
        environment,
        validation_run,
        backend_run=backend_run,
        runner_temp=os.environ.get("RUNNER_TEMP", ""),
    )
    folder = Path(result["directory"])
    attempt = preflight.context(environment)
    from frontend_fixture_acceptance import verify

    release.require(
        (environment == "dev" and dev_run is None)
        or (environment == "uat" and type(dev_run) is int and dev_run > 0),
        "Fixture predecessor required",
    )
    predecessor = None if dev_run is None else verify("dev", dev_run, live=True).pin()
    write(folder, "predecessor", {"pin": predecessor})
    write(folder, "fixture-iam-plan", runtime.iam_plan(attempt))
    write(folder, "build-intent", load(folder, "intent"))
    # This is an immutable proposal uploaded before submission, never acceptance.
    write(
        folder,
        "fixture-producer",
        {
            "environment": environment,
            "project": attempt.project,
            "workflowSha": attempt.workflow_sha,
            "runId": attempt.run_id,
            "runAttempt": attempt.run_attempt,
            "backendRun": backend_run,
            "providerVerified": False,
            "productionTrafficAuthorized": False,
        },
    )


def stage_intent(attempt, folder, token):
    import frontend_fixture_acceptance as accepted
    import frontend_fixture_history as history
    import frontend_fixture_iam as iam

    client, run, _job = accepted.current(
        attempt.environment, "Prepare fixture stage intent", [accepted.BUILD_STEP]
    )
    prior = history.check(attempt.environment, github=client)
    prepared, recipe, snapshot, _original, _overlays = inspect_inputs(attempt, folder)
    pair = prepared["backendPair"]
    release.require(
        backend.inspect(
            attempt.environment, pair["acceptance"]["runId"], id_token=token
        )
        == pair,
        "Fixture backend changed before stage intent",
    )
    permission = iam.verify(attempt)
    budget = capacity(attempt)
    document = {
        "kind": "plg-private-fixture-stage-intent-v1",
        "sourceSha": release.SOURCE,
        "environment": attempt.environment,
        "producer": {
            "runId": int(attempt.run_id),
            "attempt": int(attempt.run_attempt),
            "workflowSha": attempt.workflow_sha,
        },
        "prepared": prepared,
        "snapshot": snapshot,
        "recipeBase64": base64.b64encode(recipe).decode(),
        "buildIntent": load(folder, "intent"),
        "buildEvidence": load(folder, "build-evidence"),
        "runtimeImageReadback": load(folder, "runtime-image-readback"),
        "serviceDocument": load(folder, "candidate-plan"),
        "iam": permission,
        "capacity": budget,
        "previous": fingerprint(prior["previousService"]),
        "productionTrafficAuthorized": False,
        "beforeTraffic": None
        if prior["previousService"] is None
        else prior["previousService"]["spec"]["traffic"],
    }
    accepted.validate_intent(document, run, attempt.environment)
    accepted.verify_build(document, attempt.environment)
    release.require(
        iam.verify(attempt) == permission
        and fingerprint(
            history.check(attempt.environment, github=client)["previousService"]
        )
        == document["previous"],
        "Fixture prerequisites changed",
    )
    write(folder, "stage-intent", document)


def stage(attempt, folder, token):
    import frontend_fixture_acceptance as accepted
    import frontend_fixture_history as history
    import frontend_fixture_candidate as native
    import frontend_fixture_iam as iam

    client, run, job = accepted.current(
        attempt.environment, accepted.STAGE_STEP, [accepted.STAGE_UPLOAD]
    )
    _item, document = accepted.artifact(
        client,
        run,
        job,
        attempt.environment,
        "stage-intent",
        accepted.STAGE_UPLOAD,
        "stage-intent.json",
    )
    release.require(
        document == load(folder, "stage-intent"),
        "Fixture published service intent changed",
    )
    accepted.validate_intent(document, run, attempt.environment)
    accepted.verify_build(document, attempt.environment)
    prior = history.check(attempt.environment, github=client)
    release.require(
        fingerprint(prior["previousService"]) == document["previous"]
        and iam.verify(attempt) == document["iam"],
        "Fixture stage baseline or IAM changed",
    )
    pair = document["prepared"]["backendPair"]
    release.require(
        backend.inspect(
            attempt.environment, pair["acceptance"]["runId"], id_token=token
        )
        == pair,
        "Fixture backend pairing changed",
    )
    capacity(attempt)
    sequence = 0

    def checkpoint(value):
        nonlocal sequence
        sequence += 1
        requesting()
        write(folder, f"fixture-operation-{sequence:02}", value)

    observed = native.stage(
        native.Cloud(attempt.environment),
        document["serviceDocument"],
        checkpoint=checkpoint,
        previous=prior["previousService"],
    )
    write(folder, "candidate", observed)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
        stream.write("audience=" + observed["serviceUrl"] + "\n")


def record(attempt, folder, frontend_token, backend_token):
    import frontend_fixture_acceptance as accepted
    import frontend_fixture_candidate as native
    import frontend_fixture_iam as iam

    client, run, job = accepted.current(
        attempt.environment,
        "Verify private fixture proxy scope",
        [accepted.STAGE_STEP, accepted.STAGE_UPLOAD],
    )
    item, intent = accepted.artifact(
        client,
        run,
        job,
        attempt.environment,
        "stage-intent",
        accepted.STAGE_UPLOAD,
        "stage-intent.json",
    )
    cloud = native.Cloud(attempt.environment)
    before = native.observe(cloud, intent["serviceDocument"])
    release.require(
        before == load(folder, "candidate"), "Fixture candidate changed before checks"
    )
    pair = intent["prepared"]["backendPair"]
    release.require(
        backend.inspect(
            attempt.environment, pair["acceptance"]["runId"], id_token=backend_token
        )
        == pair,
        "Fixture backend changed before checks",
    )
    checks = native.probes(before, pair, frontend_token, backend_token)
    release.require(
        native.observe(cloud, intent["serviceDocument"]) == before
        and iam.verify(attempt) == intent["iam"],
        "Fixture candidate or IAM changed during checks",
    )
    write(
        folder,
        "acceptance",
        {
            "kind": accepted.KIND,
            "stageIntent": {"artifactId": item["id"], "artifactDigest": item["digest"]},
            "candidate": before,
            "checks": checks,
            "predecessor": load(folder, "predecessor")["pin"],
            "customerSendingVerified": False,
            "productionTrafficAuthorized": False,
        },
    )
