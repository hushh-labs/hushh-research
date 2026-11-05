"""Stateful cloud boundary for the real answer scheduler shell helper."""

import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
path = Path(os.environ["FAKE_CLOUD_STATE"])
state = json.loads(path.read_text())
state["calls"].append(args)


def save():
    path.write_text(json.dumps(state))


if args[:3] == ["scheduler", "jobs", "describe"]:
    save()
    if state.get("deny"):
        print("PERMISSION_DENIED", file=sys.stderr)
        sys.exit(1)
    if state["job"] is None:
        print("NOT_FOUND", file=sys.stderr)
        sys.exit(1)
    if "--format=json" in args:
        values = state["config"]
        result = {
            "name": f"projects/{values['project']}/locations/{values['location']}/jobs/{args[3]}",
            "state": state["job"],
            "schedule": values["schedule"],
            "timeZone": values["time-zone"],
            "attemptDeadline": values["attempt-deadline"],
            "httpTarget": {
                "uri": values["uri"],
                "httpMethod": "POST",
                "oidcToken": {
                    "serviceAccountEmail": values["oidc-service-account-email"],
                    "audience": values["oidc-token-audience"],
                },
                "body": state.get("body", ""),
            },
            "retryConfig": {
                "retryCount": int(values["max-retry-attempts"]),
                "minBackoffDuration": values["min-backoff"],
                "maxBackoffDuration": values["max-backoff"],
                "maxDoublings": int(values["max-doublings"]),
            },
        }
        print(json.dumps(result))
    elif any("value(state,schedule," in a for a in args):
        values = state["config"]
        print(
            "\t".join(
                [
                    state["job"],
                    values["schedule"],
                    values["uri"],
                    "POST",
                    values["oidc-service-account-email"],
                    values["oidc-token-audience"],
                ]
            )
        )
    else:
        print(state["job"])
elif args[:2] == ["scheduler", "jobs"]:
    verb = args[2]
    if verb == "create" and state.get("create_failures", 0):
        state["create_failures"] -= 1
        save()
        print(
            "ERROR: (gcloud.scheduler.jobs.create.http) "
            + state["create_error"]
            + ": identity unavailable",
            file=sys.stderr,
        )
        sys.exit(1)
    if verb in {"create", "update"}:
        state["config"] = {
            a[2:].split("=", 1)[0]: a.split("=", 1)[1]
            for a in args
            if a.startswith("--") and "=" in a
        }
    if verb in {"create", "resume"}:
        state["job"] = "ENABLED"
    if verb == "pause":
        state["job"] = "PAUSED"
    save()
elif args[:3] == ["iam", "service-accounts", "describe"] and not state["identity"]:
    save()
    print("NOT_FOUND", file=sys.stderr)
    sys.exit(1)
elif args[:3] == ["iam", "service-accounts", "create"]:
    state["identity"] = True
    save()
else:
    save()
