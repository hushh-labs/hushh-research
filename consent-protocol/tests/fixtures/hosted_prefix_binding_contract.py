"""Native cleanup authority is the frozen call, never a reported policy tuple."""

import json
from copy import deepcopy

from tests.fixtures.hosted_prefix_abort import admitted_prefix_abort


def corrupt_binding(reservation, case):
    value = deepcopy(reservation)
    results = value["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"][
        "reserved"
    ]["hostedCheckpoint"]["completed"]
    result = next(row for row in results if row["step"] == "artifact_repo_grant_copy_writer")
    binding = result["bindingObservations"][0]
    if case == "project":
        binding["policyResource"] = (
            "https://cloudresourcemanager.googleapis.com/v1/projects/foreign-owner:getIamPolicy"
        )
    elif case == "role":
        binding["role"] = "roles/owner"
    elif case == "member":
        binding["member"] = "serviceAccount:foreign-owner@foreign-project.iam.gserviceaccount.com"
    elif case == "missing-field":
        del binding["member"]
    elif case == "step":
        binding["step"] = "iam_pod_sa_vertex"
    elif case == "control":
        result = next(row for row in results if row["step"] == "enable_services")
        result["bindingObservations"] = [{**binding, "step": "enable_services"}]
    else:
        result = next(row for row in results if row["step"] == "iam_pod_sa_on_key")
        if case == "missing-role":
            result["bindingObservations"].pop()
        else:
            result["bindingObservations"][1] = {
                **result["bindingObservations"][0],
                "afterEtag": "different-current-etag",
            }
    return value


async def verify_binding_contract(pg):
    async for fixture in admitted_prefix_abort(pg, 18, bridge=True):
        saved = fixture.reservation()
        inventory = fixture.native_inventory()
        inventory["writerFence"]["status"] = "admitted"
        actual = pg.execute("SELECT managed_prefix_bindings(%s::jsonb)", (json.dumps(saved),))[0][0]
        assert actual == fixture.entered_bindings
        for case in (
            "project",
            "role",
            "member",
            "missing-field",
            "step",
            "control",
            "missing-role",
            "duplicate-role",
        ):
            candidate = corrupt_binding(saved, case)
            assert (
                pg.execute(
                    "SELECT managed_prefix_abort_context(%s::jsonb)", (json.dumps(candidate),)
                )[0][0]
                is not None
            )
            assert (
                pg.execute("SELECT managed_prefix_bindings(%s::jsonb)", (json.dumps(candidate),))[
                    0
                ][0]
                is None
            )
            assert not pg.execute(
                "SELECT valid_managed_prefix_inventory_admission(%s::jsonb,%s::jsonb)",
                (json.dumps(candidate), json.dumps(inventory)),
            )[0][0]
        # The two exact KMS roles may be reported in either order, but both are mandatory.
        reordered = deepcopy(saved)
        results = reordered["registrySnapshot"]["backend_metadata"]["provisionAttempt"]["evidence"][
            "reserved"
        ]["hostedCheckpoint"]["completed"]
        next(row for row in results if row["step"] == "iam_pod_sa_on_key")[
            "bindingObservations"
        ].reverse()
        assert (
            pg.execute("SELECT managed_prefix_bindings(%s::jsonb)", (json.dumps(reordered),))[0][0]
            is not None
        )
        assert fixture.reservation() == saved  # Negative controls never rewrite retained evidence.
