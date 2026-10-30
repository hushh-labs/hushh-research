"""Qualify one current UAT checkpoint-guard refusal as pre-mutation, without authority.

Under the reviewed maintenance owner, an --apply pass calls
assert_checkpoint_publication before restore_state or any provider mutation, and
every accepted diagnostic is raised only through that guard. The cleanup job saves
a checkpoint whenever the prepare step published checkpoint_ready, which the owner
does before any provider mutation. A complete raw job transcript with a skipped
save and exactly one accepted diagnostic as the prepare step's final output
therefore proves only that this attempt left revision-cleanup custody unchanged.
Nothing here grants cleanup, traffic or reconciliation authority; older custody is
still walked, and unknown evidence remains a refusal. Historical sources keep their
own proof in retention_preflight_evidence.
"""

from __future__ import annotations

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
        PUBLICATION: ("96c5db46c8156252dbcc66d66307b1af18dd033c", 18520),
    },
)
OWNER_BLOBS = frozenset(profile[base.OWNER][0] for profile in SOURCE_PROFILES)


def _guard_failure(rows, job) -> bool:
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
    diagnostics = [
        body for _, body in rows if body.startswith("Hosted maintenance stopped:")
    ]
    errors = [body for _, body in rows if "##[error]" in body]
    return (
        len(tail) == 2
        and tail[0] in DIAGNOSTICS
        and tail[1] == base._EXIT
        and diagnostics == [tail[0]]
        and errors == [base._EXIT]
    )


def _reviewed(source_blobs, workflow_blob) -> bool:
    for profile in SOURCE_PROFILES:
        expected = {
            path: {"sha": sha, "size": size} for path, (sha, size) in profile.items()
        }
        if source_blobs == expected and workflow_blob == expected[base.WORKFLOW]:
            return True
    return False


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
        and job.get("name") == base._JOB
        and job.get("status") == "completed"
        and job.get("conclusion") == "failure"
        and job.get("head_branch") == "main"
        and job.get("run_id") == run["id"]
        and type(job.get("run_attempt")) is int
        and job.get("run_attempt") == run["run_attempt"]
        and job.get("head_sha") == run["head_sha"]
        and base._steps_match(job)
    ):
        return None
    rows, checkout = base._raw_rows(log, job), base.actual_checkout(log, job)
    if (
        rows is None
        or checkout is None
        or not _reviewed(source_blobs, workflow_blob)
        or not _guard_failure(rows, job)
    ):
        return None
    return {
        "run_id": run["id"],
        "attempt": run["run_attempt"],
        "job_id": job["id"],
        "checkout_sha": checkout,
        "qualification": "no_provider_mutation",
    }
