"""Qualify one current UAT checkpoint-guard refusal as pre-mutation, without authority.

Under the reviewed maintenance owner, an --apply pass calls
assert_checkpoint_publication before restore_state or any provider mutation, and
every accepted diagnostic is raised only through that guard. The cleanup job saves
a checkpoint whenever the prepare step published checkpoint_ready, which the owner
does before any provider mutation, so the skipped save (not a transcript token) is
the publication evidence. A complete raw job transcript whose prepare step ends
with exactly one accepted diagnostic, plus only the walk's own proof records for
older attempts, therefore proves only that this attempt left revision-cleanup
custody unchanged. Profiles pin the owner, workflow and publication bodies; code
the owner imports from other modules is reviewed, not pinned, so adding a provider
call before the guard there needs the same review as a new profile. Nothing here
grants cleanup, traffic or reconciliation authority; older custody is still walked,
and unknown evidence remains a refusal. Historical sources keep their own proof in
retention_preflight_evidence.
"""

from __future__ import annotations

import json
import re

import retention_preflight_evidence as base

ENVIRONMENT = "uat"
PUBLICATION = "scripts/ci/retention_publication.py"
SOURCE_PATHS = (base.OWNER, base.WORKFLOW, PUBLICATION)
PREPARE_COMMAND = (
    "##[group]Run set -euo pipefail",
    "set -euo pipefail",
    "flags=()",
    'if [ "$APPLY" = true ]; then flags=(--apply); fi',
    'if [[ "$GITHUB_EVENT_NAME" = workflow_dispatch ]]; then flags+=(--force-inspection); fi',
    "python3 scripts/ci/uat-retention-maintenance.py --environment uat \\",
    '  --release-run-id "$RELEASE_RUN_ID" \\',
    '  --state-dir "$RUNNER_TEMP/uat-retention-state" "${flags[@]}"',
)
# assert_checkpoint_publication raises the first; the publication walk it runs raises
# the others. The third stopped attempt 41105484094/1, although the same history
# walks cleanly when read again.
DIAGNOSTICS = frozenset(
    {
        "Hosted maintenance stopped: Maintenance publication proof is unavailable or invalid",
        base._DIAGNOSTIC,
        "Hosted maintenance stopped: maintenance cleanup invocation is missing",
    }
)
# Verified with git rev-parse <commit>:<path> and git cat-file -s. The first profile is
# Main 177fceb0, the checkout of failed attempt 41105484094/1 and the attempts it
# froze; the second differs only by this change's publication body. In both, --apply
# reaches these diagnostics only through assert_checkpoint_publication, before
# restore_state, the first checkpoint or any provider mutation.
SOURCE_PROFILES = (
    {
        base.OWNER: ("1e7f8973cea0f5fea7ada3033935856bb4428f37", 87255),
        base.WORKFLOW: ("8f0660ff9a8ec42747dc338e56ad83e3dde98ce5", 20685),
        PUBLICATION: ("98e190df4afcfac18f093abfe77dc3cbe242d831", 18042),
    },
    {
        base.OWNER: ("1e7f8973cea0f5fea7ada3033935856bb4428f37", 87255),
        base.WORKFLOW: ("8f0660ff9a8ec42747dc338e56ad83e3dde98ce5", 20685),
        PUBLICATION: ("939f07cd6f1330375544983279d5e801e4e5a260", 18759),
    },
)
# Frozen Main 0db317e source: static mode steps and content-free stage diagnostic.
STATIC_PROFILE = {
    base.OWNER: ("971f115232da088a1036b671cac91357fb5b0dda", 94181),
    base.WORKFLOW: ("0d2e1df0f677c39bc39d78ef3230f99b7545d168", 21386),
    PUBLICATION: ("bafacd6c02ddca13af0fed45199dff8e2a284148", 22947),
    "scripts/ci/retention_pass_diagnostics.py": ("d5d8181a7bbb60bd544753575dda74f1f92806c0", 5439),
}
SOURCE_PROFILES += (STATIC_PROFILE,)
OWNER_BLOBS = frozenset(profile[base.OWNER][0] for profile in SOURCE_PROFILES)
# retention_publication prints one record per older attempt it qualified; stdout
# may flush them after the stderr diagnostic. More records than this refuse.
PROOF_PREFIX = "maintenance_publication_proof="
MAX_PROOF_RECORDS = 100
_PROOF_KEYS = frozenset(
    {"run_id", "attempt", "job_id", "checkout_sha", "qualification"}
)


def _guard_failure(rows, job, *, static=False) -> bool:
    if static:
        steps = {step["name"]: step for step in job["steps"]}
        prepare = base._step_rows(rows, steps[base._PREPARE])
        markers = [i for i, body in enumerate(prepare) if body.startswith('##[group]Run echo "Cleanup:')]
        if markers:
            prepare = prepare[:markers[0]]
    else:
        prepare = base._prepare_segment(rows, job)
    width = len(PREPARE_COMMAND)
    positions = [
        index
        for index in range(len(prepare))
        if tuple(prepare[index : index + width]) == PREPARE_COMMAND
    ]
    if len(positions) != 1 or prepare.count("  APPLY: true") != 1:
        return False
    grouped = prepare[positions[0] :]
    if grouped.count("##[endgroup]") != 1:
        return False
    tail = grouped[grouped.index("##[endgroup]") + 1 :]
    stops = [body for body in tail[:-1] if not _proof_record(body)]
    diagnostics = [
        body for _, body in rows if body.startswith("Hosted maintenance stopped:")
    ]
    errors = [body for _, body in rows if "##[error]" in body]
    return (
        2 <= len(tail) <= MAX_PROOF_RECORDS + 2
        and tail[-1] == base._EXIT
        and len(stops) == 1
        and stops[0] in (DIAGNOSTICS | {"Hosted maintenance stopped: stage=publication_guard kind=safety_refusal"} if static else DIAGNOSTICS)
        and diagnostics == stops
        and errors == [base._EXIT]
    )


def _proof_record(body) -> bool:
    """Recognize the walk's own record of an older qualified attempt; it grants nothing."""
    if not isinstance(body, str) or not body.startswith(PROOF_PREFIX):
        return False
    try:
        value = json.loads(body[len(PROOF_PREFIX) :])
    except (TypeError, ValueError):
        return False
    return (
        isinstance(value, dict)
        and set(value) == _PROOF_KEYS
        and body == PROOF_PREFIX + json.dumps(value, sort_keys=True)
        and all(
            type(value[key]) is int and 0 < value[key] < 2**63
            for key in ("run_id", "attempt", "job_id")
        )
        and isinstance(value["checkout_sha"], str)
        and re.fullmatch(r"[0-9a-f]{40}", value["checkout_sha"]) is not None
        and value["qualification"] == "no_provider_mutation"
    )


def _reviewed(source_blobs, workflow_blob) -> bool:
    for profile in SOURCE_PROFILES:
        expected = {
            path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()
        }
        if source_blobs == expected and workflow_blob == expected[base.WORKFLOW]:
            return True
    return False


def _static_steps(job):
    rows = job.get("steps")
    if not isinstance(rows, list) or len(rows) != 14:
        return False
    expected = ("Set up job", "Maintenance mode: inspection", "Maintenance mode: cleanup",
                base._CHECKOUT, "Start the five-minute cleanup budget", "Recheck due source under the deployment lock",
                "Authenticate to uat", "Set up Cloud SDK", base._PREPARE, base._SAVE,
                "Report cleanup independently of release health", "Post Authenticate to uat",
                "Post Checkout mutation tooling and rollback history", "Complete job")
    numbers = [step.get("number") for step in rows if isinstance(step, dict)]
    if len(numbers) != len(rows) or any(type(n) is not int for n in numbers) or numbers != sorted(set(numbers)):
        return False
    return all(isinstance(step, dict) and step.get("name") == name
               and step.get("status") == "completed" and type(step.get("number")) is int
               and step["number"] > 0
               and step.get("conclusion") == ("skipped" if name in {base._SAVE, "Maintenance mode: inspection"}
                                             else "failure" if name == base._PREPARE else "success")
               for index, (step, name) in enumerate(zip(rows, expected, strict=True)))


def qualify_guard_run(
    repository, environment, run, job, log, source_blobs, workflow_blob
):
    """One exact completed attempt may prove no custody mutation; never older custody."""
    if not isinstance(run, dict) or not isinstance(job, dict):
        return None
    if not (
        repository == base.REPOSITORY
        and environment == ENVIRONMENT
        and run.get("status") == "completed"
        and run.get("conclusion") == "failure"
        and run.get("path") == base.WORKFLOW
        and run.get("head_branch") == "main"
        and run.get("event") in {"repository_dispatch", "workflow_dispatch"}
        and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", "")))
        and all(
            type(value) is int and value > 0
            for value in (run.get("id"), run.get("run_attempt"), job.get("id"))
        )
        and run["run_attempt"] <= 10
        and all(
            (run.get(key) or {}).get("full_name") == repository
            for key in ("repository", "head_repository")
        )
        and job.get("name") in {base._JOB, "UAT revision maintenance"}
        and job.get("status") == "completed"
        and job.get("conclusion") == "failure"
        and job.get("head_branch") == "main"
        and job.get("run_id") == run["id"]
        and type(job.get("run_attempt")) is int
        and job.get("run_attempt") == run["run_attempt"]
        and job.get("head_sha") == run["head_sha"]
        and (base._steps_match(job) or _static_steps(job))
    ):
        return None
    static = job.get("name") == "UAT revision maintenance"
    rows = base._raw_rows(log, job)
    checkout = base.actual_checkout(log, job) if not static else None
    if static and rows:
        step = next(item for item in job["steps"] if item["name"] == base._CHECKOUT)
        segment = base._step_rows(rows, step)
        indexes = [i for i, body in enumerate(segment) if body == base._CHECKOUT_COMMAND]
        if len(indexes) == 1 and indexes[0] + 1 < len(segment):
            checkout = segment[indexes[0] + 1]
    if static and source_blobs != {path: {"sha": sha, "size": size} for path, (sha, size) in STATIC_PROFILE.items()}:
        return None
    if (
        rows is None
        or checkout is None
        or not _reviewed(source_blobs, workflow_blob)
        or not re.fullmatch(r"[0-9a-f]{40}", checkout or "")
        or not _guard_failure(rows, job, static=static)
    ):
        return None
    return {
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "job_id": job["id"],
        "checkout_sha": checkout,
        "qualification": "no_provider_mutation",
    }
