"""In-memory provider write-attempt marker for one hosted CLI phase."""

import frontend_release as release

_attempted = False


def reset():
    global _attempted
    _attempted = False


def requesting():
    global _attempted
    _attempted = True


def was_attempted():
    return _attempted


def never_requested(client, run, job, environment, phase, step, *, acceptance):
    """Only a genuine completed Main publication can prove zero write attempts."""
    upload = "Publish fixture " + phase + " request state"
    rows = [row for row in job.get("steps", []) if row.get("name") == upload]
    if not (
        len(rows) == 1
        and rows[0].get("status") == "completed"
        and rows[0].get("conclusion") == "success"
    ):
        return False
    prefix = "plg-fixture-" + phase + "-request-state-" + environment
    listing = acceptance.fresh(client, f"runs/{run['id']}/artifacts?per_page=100")
    items = listing.get("artifacts", [])
    release.require(
        listing.get("total_count") == len(items) <= 100,
        "Fixture request-state inventory incomplete",
    )
    wanted = f"{prefix}-{run['id']}-{run['run_attempt']}"
    if not any(item.get("name") == wanted for item in items):
        return False  # a missing file is never evidence of absence
    _item, state = acceptance.artifact(
        client,
        run,
        job,
        environment,
        phase + "-request-state",
        upload,
        phase + "-request-state.json",
    )
    release.require(
        isinstance(state, dict)
        and state
        == {
            "kind": "plg-fixture-provider-request-state-v1",
            "environment": environment,
            "producer": {
                "runId": run["id"],
                "attempt": run["run_attempt"],
                "workflowSha": run["head_sha"],
            },
            "phase": phase,
            "providerRequestAttempted": state.get("providerRequestAttempted"),
            "productionTrafficAuthorized": False,
        }
        and type(state.get("providerRequestAttempted")) is bool,
        "Fixture request-state identity invalid",
    )
    if state["providerRequestAttempted"]:
        return False
    original = [row for row in job.get("steps", []) if row.get("name") == step]
    release.require(
        len(original) == 1 and original[0].get("conclusion") != "success",
        "Fixture successful write phase contradicts zero-request receipt",
    )
    return True
