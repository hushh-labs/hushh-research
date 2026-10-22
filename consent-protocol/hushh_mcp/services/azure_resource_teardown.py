"""Execute an owner-approved Azure inventory through the existing erasure operation.

No token is persisted. Intent retention precedes DELETE; accepted DELETE is not
absence. An interrupted request is observed, never blindly replayed. The caller
must hold the qualified owner/attempt/incarnation and real-worker admission for
this entire call; this module does not create or bypass that authority.
"""

from __future__ import annotations

from collections.abc import Callable

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_setup_plan import PlanInputs, Scopes, resource_names
from hushh_mcp.services.azure_teardown_inventory import (
    AzureTeardownRefused,
    TeardownResource,
    qualified_identity,
)
from hushh_mcp.services.azure_teardown_receipts import (
    TeardownJournal,
    TeardownMutationJournal,
    can_retry,
    observed_absence_is_terminal,
)
from hushh_mcp.services.azure_teardown_receipts import (
    retain as _retain,
)


def _exclusive_group(
    arm: ArmClient,
    inputs: PlanInputs,
    resources: tuple[TeardownResource, ...],
    *,
    empty: bool = False,
) -> None:
    group = Scopes(inputs, resource_names(inputs)).group
    result = arm.get_or_none(
        group + "/resources", api_version=API_VERSIONS["resources"], op="cleanup_inventory"
    )
    if result is None:
        if (
            arm.get_or_none(group, api_version=API_VERSIONS["resources"], op="cleanup_group")
            is None
        ):
            return
        raise AzureTeardownRefused("AZURE_CLEANUP_INVENTORY_UNAVAILABLE")
    observed = result.get("value")
    if result.get("nextLink") or not isinstance(observed, list) or len(observed) > 128:
        raise AzureTeardownRefused("AZURE_CLEANUP_INVENTORY_UNAVAILABLE")
    allowed = {resource.path.lower() for resource in resources}
    if (empty and observed) or any(
        not isinstance(row, dict)
        or not isinstance(row.get("id"), str)
        or row["id"].lower() not in allowed
        for row in observed
    ):
        raise AzureTeardownRefused("AZURE_CLEANUP_UNRELATED_RESOURCES")


def _model_deployments(arm: ArmClient, inputs: PlanInputs, *, empty: bool = False) -> None:
    scopes = Scopes(inputs, resource_names(inputs))
    observed = arm.get_or_none(
        scopes.openai + "/deployments",
        api_version=API_VERSIONS["cognitive_services"],
        op="cleanup_model_inventory",
    )
    if observed is None:
        if (
            arm.get_or_none(
                scopes.openai,
                api_version=API_VERSIONS["cognitive_services"],
                op="cleanup_model_inventory",
            )
            is None
        ):
            return
        raise AzureTeardownRefused("AZURE_MODEL_INVENTORY_UNAVAILABLE")
    values = observed.get("value")
    if (
        observed.get("nextLink")
        or not isinstance(values, list)
        or len(values) > 128
        or (empty and values)
        or any(
            not isinstance(value, dict)
            or not isinstance(value.get("id"), str)
            or value["id"].lower() != scopes.deployment.lower()
            for value in values
        )
    ):
        raise AzureTeardownRefused("AZURE_MODEL_INVENTORY_UNAVAILABLE")


def _qualified_model_parent(
    arm: ArmClient,
    inputs: PlanInputs,
    resources: tuple[TeardownResource, ...],
    journal: TeardownJournal,
    frozen: dict,
) -> None:
    scopes = Scopes(inputs, resource_names(inputs))
    parent = next(resource for resource in resources if resource.path == scopes.openai)
    body = arm.get_or_none(parent.path, api_version=parent.api_version, op="cleanup_model_parent")
    if body is None or qualified_identity(parent, body, inputs) != frozen[parent.path]:
        raise AzureTeardownRefused("AZURE_RESOURCE_OWNER_CHANGED")
    journal.assert_parent_approved(parent)


def preflight(
    arm: ArmClient,
    inputs: PlanInputs,
    resources: tuple[TeardownResource, ...],
    journal: TeardownJournal,
) -> dict[str, dict | None]:
    """Qualify every existing resource before the first irreversible action."""
    journal.assert_admitted()
    _exclusive_group(arm, inputs, resources)
    _model_deployments(arm, inputs)
    observed = {}
    for resource in resources:
        if resource.covered_by:
            continue
        body = arm.get_or_none(
            resource.path, api_version=resource.api_version, op="cleanup_inventory"
        )
        observed[resource.path] = (
            None if body is None else qualified_identity(resource, body, inputs)
        )
        if body is not None and resource.kind == "resource":
            journal.assert_parent_approved(resource)
    return observed


def _erase_one(
    arm: ArmClient,
    inputs: PlanInputs,
    resource: TeardownResource,
    journal: TeardownJournal,
    frozen_identity: dict | None,
    before_dispatch: Callable[[], None] | None = None,
) -> None:
    journal.assert_admitted()
    state = journal.state(resource) or {}
    if (
        state.get("provider_request")
        and not observed_absence_is_terminal(state)
        and not can_retry(state)
    ):
        from hushh_mcp.services.azure_teardown_reconciliation import reconcile_delete

        state = reconcile_delete(arm, resource, journal)
    body = arm.get_or_none(resource.path, api_version=resource.api_version, op="cleanup_readback")
    if body is None:
        _retain(
            journal, resource, "absence", {"status": "active_resource_absent", "id": resource.path}
        )
        return
    current = qualified_identity(resource, body, inputs)
    if state.get("absence") is not None or current != frozen_identity:
        raise AzureTeardownRefused("AZURE_CLEANUP_RESOURCE_CHANGED")
    if state.get("provider_request") is not None and not can_retry(state):
        # Even a timeout before acknowledgement may have dispatched. Provider
        # settlement/reconciliation must resolve it before any new deletion.
        raise AzureTeardownRefused("AZURE_CLEANUP_OUTCOME_UNCERTAIN")
    if state.get("provider_request") is not None:
        _retain(journal, resource, "retry", {})
    _retain(journal, resource, "intent", {"identity": current})
    journal.assert_admitted()
    if resource.kind == "resource":
        journal.assert_parent_approved(resource)
    if before_dispatch is not None:
        before_dispatch()
    recorded = arm.with_mutations(TeardownMutationJournal(journal, resource))
    recorded.delete(resource.path, api_version=resource.api_version, op="account_cleanup")
    settled = journal.state(resource) or {}
    terminal = settled.get("provider_terminal", {})
    if not settled.get("provider_request") or not (
        terminal.get("outcome") == "succeeded"
        or (
            terminal.get("outcome") == "refused"
            and settled.get("provider_ack", {}).get("status") == 404
        )
    ):
        raise AzureTeardownRefused("AZURE_CLEANUP_OUTCOME_UNCERTAIN")
    _retain(
        journal, resource, "acknowledgement", {"status": "provider_completed", "id": resource.path}
    )
    if (
        arm.get_or_none(resource.path, api_version=resource.api_version, op="cleanup_readback")
        is not None
    ):
        raise AzureTeardownRefused("AZURE_CLEANUP_ABSENCE_UNCONFIRMED")
    _retain(journal, resource, "absence", {"status": "active_resource_absent", "id": resource.path})


def execute(
    arm: ArmClient,
    inputs: PlanInputs,
    resources: tuple[TeardownResource, ...],
    journal: TeardownJournal,
    frozen: dict[str, dict | None],
) -> None:
    """Remove only the admitted inventory; the account guard independently finalizes."""
    arm = arm.with_write_guard(journal.assert_admitted)
    if set(frozen) != {r.path for r in resources if not r.covered_by}:
        raise AzureTeardownRefused("AZURE_CLEANUP_INVENTORY_CHANGED")
    for resource in resources:
        if resource.covered_by:
            continue
        scopes = Scopes(inputs, resource_names(inputs))
        if resource.path == scopes.openai:
            _model_deployments(arm, inputs, empty=True)
        # Recheck exclusivity immediately before the group cascade as well.
        if resource.path == Scopes(inputs, resource_names(inputs)).group:
            journal.assert_group_approved()
            _exclusive_group(arm, inputs, resources, empty=True)
        _erase_one(
            arm,
            inputs,
            resource,
            journal,
            frozen[resource.path],
            before_dispatch=(
                lambda: _qualified_model_parent(arm, inputs, resources, journal, frozen)
            )
            if resource.path == scopes.deployment
            else None,
        )
    # Do not report completion from a historical absence if a resource reappeared.
    observed_ids = []
    for resource in resources:
        if (
            not resource.covered_by
            and arm.get_or_none(resource.path, api_version=resource.api_version, op="cleanup_final")
            is not None
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_RESOURCE_REAPPEARED")
        if not resource.covered_by:
            observed_ids.append(resource.path)
    from hushh_mcp.services.azure_teardown_retention import observe_retention

    for resource in resources:
        if resource.covered_by:
            continue
        observation = observe_retention(arm, inputs, resource, frozen[resource.path])
        if observation is not None:
            _retain(journal, resource, "retention", observation)
    if journal.retain_final_readback(tuple(observed_ids)) is not True:
        raise AzureTeardownRefused("AZURE_CLEANUP_READBACK_UNCONFIRMED")
