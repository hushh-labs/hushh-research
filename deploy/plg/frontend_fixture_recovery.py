"""Fixed private fixture recovery capability; no independent release authority."""

from __future__ import annotations

import frontend_fixture_runtime as runtime
import frontend_release as release

from frontend_fixture_io import write, load, folder_for, fingerprint
from frontend_fixture_request_state import requesting


def recovery_intent(attempt, origin):
    import frontend_fixture_acceptance as accepted
    import frontend_fixture_history as history
    import frontend_fixture_candidate as native
    import frontend_fixture_iam as iam

    client, _run, _job = accepted.current(
        attempt.environment, "Prepare fixture recovery intent", []
    )
    state = history.check(
        attempt.environment, purpose="recover", origin=origin, github=client
    )
    staged = accepted.stage_intent(attempt.environment, *origin, github=client)
    accepted.verify_build(staged["document"], attempt.environment)
    cloud = native.Cloud(attempt.environment)
    current = state["previousService"]
    release.require(current is not None, "Fixture recovery outcome absent or uncertain")
    policy = cloud.policy()
    native.private(current, policy, attempt.project)
    native.continuity(current, staged["document"])
    permission = iam.verify(attempt)
    native.revision_matches(
        cloud.revision(
            staged["document"]["serviceDocument"]["spec"]["template"]["metadata"][
                "name"
            ]
        ),
        staged["document"]["serviceDocument"],
    )
    folder = folder_for(attempt)
    folder.mkdir(mode=0o700)
    write(
        folder,
        "recovery-intent",
        {
            "kind": "plg-fixture-route-recovery-intent-v1",
            "origin": {"runId": origin[0], "attempt": origin[1]},
            "stageIntent": {
                key: staged[key] for key in ("artifactId", "artifactDigest")
            },
            "before": fingerprint(current),
            "privatePolicySha256": runtime.digest(runtime.encode(policy)),
            "iam": permission,
            "productionTrafficAuthorized": False,
        },
    )


def recover(attempt, folder, origin):
    import frontend_fixture_acceptance as accepted
    import frontend_fixture_history as history
    import frontend_fixture_candidate as native
    import frontend_fixture_iam as iam

    client, run, job = accepted.current(
        attempt.environment, accepted.RECOVER_STEP, [accepted.RECOVER_UPLOAD]
    )
    _item, intent = accepted.artifact(
        client,
        run,
        job,
        attempt.environment,
        "recovery-intent",
        accepted.RECOVER_UPLOAD,
        "recovery-intent.json",
    )
    release.require(
        intent == load(folder, "recovery-intent")
        and intent["origin"] == {"runId": origin[0], "attempt": origin[1]},
        "Fixture recovery publication changed",
    )
    state = history.check(
        attempt.environment, purpose="recover", origin=origin, github=client
    )
    document = state["stageDocument"]["serviceDocument"]
    current = state["previousService"]
    release.require(
        fingerprint(current) == intent["before"],
        "Fixture recovery CAS baseline changed",
    )
    cloud = native.Cloud(attempt.environment)
    native.continuity(current, state["stageDocument"])
    policy = cloud.policy()
    native.private(current, policy, attempt.project)
    release.require(
        runtime.digest(runtime.encode(policy)) == intent["privatePolicySha256"]
        and iam.verify(attempt) == intent["iam"],
        "Fixture recovery IAM changed",
    )
    try:
        native.route(current, document)
    except release.Refused:
        native.partial_owned(current, state["stageDocument"])

        def checkpoint(value):
            requesting()
            write(folder, "recovery-operation", value)

        native.finish_route(
            cloud,
            document,
            current,
            checkpoint=checkpoint,
        )
    observed = native.observe(cloud, document)
    release.require(
        cloud.policy() == policy and iam.verify(attempt) == intent["iam"],
        "Fixture recovery IAM changed after readback",
    )
    write(
        folder,
        "recovery",
        {
            "kind": "plg-fixture-retained-recovery-v1",
            "origin": intent["origin"],
            "stageIntent": intent["stageIntent"],
            "candidate": observed,
            "productionTrafficAuthorized": False,
        },
    )
