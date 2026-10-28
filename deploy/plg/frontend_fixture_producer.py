"""Main-owned fixed private Dev/UAT fixture phase dispatcher.

Build, deployment and recovery retain separate IO ports. Each phase publishes
its source-bound write-attempt state; this grants no production authority.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import frontend_release as release
import frontend_hosted_preflight as preflight
import frontend_fixture_request_state as request_state
import qualification_image as images
import frontend_build_evidence as evidence
from frontend_fixture_io import folder_for, write
from frontend_fixture_io import originals as originals, inspect_inputs as inspect_inputs
from frontend_fixture_build import build, manifest as manifest, blob as blob
from frontend_fixture_release import audience, prepare, stage_intent, stage, record
from frontend_fixture_recovery import recovery_intent, recover
from frontend_fixture_request_state import requesting as requesting

__all__ = [
    "images",
    "evidence",
    "originals",
    "inspect_inputs",
    "manifest",
    "blob",
    "requesting",
]


def execute(args, attempt, frontend_token, backend_token):
    if args.phase in {"audience", "prepare"}:
        release.require(
            type(args.backend_run) is int and args.backend_run > 0,
            "Fixture backend run missing",
        )
    if args.phase == "audience":
        audience(args.environment, args.backend_run)
    elif args.phase == "prepare":
        prepare(args.environment, args.validation_run, args.backend_run, args.dev_run)
    elif args.phase == "build":
        build(attempt, folder_for(attempt))
    elif args.phase == "stage-intent":
        stage_intent(attempt, folder_for(attempt), backend_token)
    elif args.phase == "stage":
        stage(attempt, folder_for(attempt), backend_token)
    elif args.phase == "record":
        record(attempt, folder_for(attempt), frontend_token, backend_token)
    else:
        release.require(
            isinstance(args.origin, str)
            and re.fullmatch(r"[1-9][0-9]{0,18}:[1-9][0-9]{0,5}", args.origin),
            "Fixture recovery origin invalid",
        )
        origin = tuple(map(int, args.origin.split(":")))
        if args.phase == "recovery-intent":
            recovery_intent(attempt, origin)
        else:
            recover(attempt, folder_for(attempt), origin)


def main():
    request_state.reset()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "phase",
        choices=(
            "audience",
            "prepare",
            "build",
            "stage-intent",
            "stage",
            "record",
            "recovery-intent",
            "recover",
        ),
    )
    parser.add_argument("--environment", choices=("dev", "uat"), required=True)
    parser.add_argument("--validation-run", type=int)
    parser.add_argument("--backend-run", type=int)
    parser.add_argument("--dev-run", type=int)
    parser.add_argument("--origin")
    args = parser.parse_args()
    # Pop credentials before context validation; never let subprocesses inherit it.
    # prepare's established port owns consumption/removal when called below.
    backend_token = (
        ""
        if args.phase == "prepare"
        else os.environ.pop("PLG_QUALIFICATION_ID_TOKEN", "")
    )
    frontend_token = os.environ.pop("PLG_FIXTURE_FRONTEND_ID_TOKEN", "")
    release.require(
        bool(backend_token)
        if args.phase in {"stage-intent", "stage", "record"}
        else not backend_token,
        "Fixture backend token context invalid",
    )
    release.require(
        bool(frontend_token) if args.phase == "record" else not frontend_token,
        "Fixture frontend token context invalid",
    )
    attempt = preflight.context(args.environment)
    try:
        execute(args, attempt, frontend_token, backend_token)
    finally:
        if args.phase in {"build", "stage", "recover"}:
            write(
                folder_for(attempt),
                args.phase + "-request-state",
                {
                    "kind": "plg-fixture-provider-request-state-v1",
                    "environment": attempt.environment,
                    "producer": {
                        "runId": int(attempt.run_id),
                        "attempt": int(attempt.run_attempt),
                        "workflowSha": attempt.workflow_sha,
                    },
                    "phase": args.phase,
                    "providerRequestAttempted": request_state.was_attempted(),
                    "productionTrafficAuthorized": False,
                },
            )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Provider exceptions and checkpoint contents can contain credentials.
        print(
            "PLG frontend fixture phase refused; reconcile the owned attempt",
            file=sys.stderr,
        )
        sys.exit(1)
