"""The Connect Azure plan: deterministic, in stage order, held to its ARM template, and
granting Hussh exactly the trust matrix in byoc-azure.md and nothing more."""

from __future__ import annotations

import json
import re

import pytest

from hushh_mcp.services import azure_setup_plan as plan_module
from hushh_mcp.services.azure_agent_setup import plan_factory
from hushh_mcp.services.azure_setup_plan import (
    AZURE_JOB_STAGES,
    HUSSH_PRINCIPAL,
    OBSERVER_ACTIONS,
    POD_PRINCIPAL,
    REMOVAL_ACTIONS,
    PlanInputs,
    resource_group_name,
    resource_names,
    without_model,
)
from hushh_mcp.services.azure_setup_template import render_arm_template, resource_type
from hushh_mcp.services.compute_backend import PodSpec

_HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"


@pytest.fixture(autouse=True)
def _hub_caller(monkeypatch):
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )


def _inputs(**overrides) -> PlanInputs:
    fields = dict(
        hushh_id=_HUSHH_ID,
        tenant_id="11111111-1111-1111-1111-111111111111",
        subscription_id="22222222-2222-2222-2222-222222222222",
        location="eastus2",
        resource_group=resource_group_name(_HUSHH_ID),
        nonce="0123456789abcdef",
    )
    return PlanInputs(**{**fields, **overrides})


def _plan(inputs: PlanInputs | None = None):
    spec = PodSpec(hushh_id=_HUSHH_ID, phone_e164_hash="h", pod_pubkey="", billing_space_id="b")
    return plan_factory(
        spec,
        source_registry="us-central1-docker.pkg.dev",
        source_repository="hushh-pda-dev/one-pod/consent-protocol-pod",
        incarnation="inc-1",
    )(inputs or _inputs())


def _grants(plan) -> set[tuple[str, str, str]]:
    """(scope, role definition id, principal) for every role assignment step."""
    out = set()
    for step in plan.steps:
        if step.kind == "role_assignment":
            props = step.body["properties"]
            scope = step.path.split("/providers/Microsoft.Authorization/roleAssignments/")[0]
            out.add((scope, props["roleDefinitionId"].rsplit("/", 1)[1], props["principalId"]))
    return out


def test_the_plan_is_deterministic():
    first, second = _plan(), _plan()
    assert json.dumps([s.__dict__ for s in first.steps], sort_keys=True) == json.dumps(
        [s.__dict__ for s in second.steps], sort_keys=True
    )
    assert render_arm_template(first) == render_arm_template(second)


def test_steps_follow_the_http_contracts_stage_order():
    stages = [s.stage for s in _plan().steps]
    assert stages == sorted(stages, key=AZURE_JOB_STAGES.index)
    assert set(stages) == set(AZURE_JOB_STAGES) - {"proving"}


def test_the_template_lists_exactly_the_appliers_resources_roles_and_actions():
    plan = _plan()
    template = render_arm_template(plan)
    applier_puts = {(resource_type(s.path), s.path) for s in plan.steps if s.kind != "action"}
    template_puts = {(r["type"], r["id"]) for r in template["resources"]}
    assert template_puts == applier_puts
    applier_actions = {(s.method, s.path) for s in plan.steps if s.kind == "action"}
    assert {(a["method"], a["id"]) for a in template["metadata"]["actions"]} == applier_actions
    role_rows = {
        (r["id"], r["properties"]["roleDefinitionId"])
        for r in template["resources"]
        if r["type"] == "Microsoft.Authorization/roleAssignments"
    }
    assert {(s.path, s.body["properties"]["roleDefinitionId"]) for s in plan.steps
            if s.kind == "role_assignment"} == role_rows  # fmt: skip


def test_hussh_holds_only_the_observer_and_the_conditioned_removal():
    plan = _plan()
    hussh = {g for g in _grants(plan) if g[2] == HUSSH_PRINCIPAL}
    scopes = plan_module.Scopes(plan.inputs, plan.names)
    observer = plan_module.observer_role_id(plan.inputs)
    removal = plan_module.removal_role_id(plan.inputs)
    assert hussh == {
        (scopes.app, observer, HUSSH_PRINCIPAL),
        (scopes.environment, observer, HUSSH_PRINCIPAL),
        (scopes.group, removal, HUSSH_PRINCIPAL),
    }
    condition = next(
        s.body["properties"]["condition"]
        for s in plan.steps
        if s.kind == "role_assignment"
        and s.path.startswith(f"{scopes.group}/providers/Microsoft.Authorization/")
    )
    assert "roleAssignments:PrincipalId" in condition
    assert HUSSH_PRINCIPAL in condition and POD_PRINCIPAL in condition


def test_the_custom_roles_carry_only_their_declared_actions():
    definitions = {
        s.body["properties"]["roleName"]: s.body["properties"]["permissions"][0]["actions"]
        for s in _plan().steps
        if s.kind == "role_definition"
    }
    assert sorted(definitions.values()) == sorted([list(OBSERVER_ACTIONS), list(REMOVAL_ACTIONS)])
    every_action = " ".join(a for actions in definitions.values() for a in actions)
    for never in ("roleAssignments/write", "ManagedIdentity", "KeyVault", "Storage",
                  "listSecrets", "exec", "getauthtoken", "containerApps/write"):  # fmt: skip
        assert never not in every_action


def test_the_agent_identity_gets_exactly_its_five_least_privilege_roles():
    plan = _plan()
    scopes = plan_module.Scopes(plan.inputs, plan.names)
    assert {g for g in _grants(plan) if g[2] == POD_PRINCIPAL} == {
        (scopes.key, plan_module.ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER, POD_PRINCIPAL),
        (scopes.secret, plan_module.ROLE_KEY_VAULT_SECRETS_USER, POD_PRINCIPAL),
        (scopes.container, plan_module.ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR, POD_PRINCIPAL),
        (scopes.registry, plan_module.ROLE_ACR_PULL, POD_PRINCIPAL),
        (scopes.openai, plan_module.ROLE_COGNITIVE_SERVICES_OPENAI_USER, POD_PRINCIPAL),
    }


def test_without_a_model_the_model_role_and_env_disappear_and_nothing_else_moves():
    full, bare = _plan(), _plan(without_model(_inputs()))
    assert not any(s.stage == "creating_model" for s in bare.steps)
    assert len(_grants(full) - _grants(bare)) == 1
    app = next(s.body for s in bare.steps if s.path.endswith("/containerApps/ca-hussh-one-pod"))
    names = {e["name"] for e in app["properties"]["template"]["containers"][0]["env"]}
    assert "AZURE_OPENAI_ENDPOINT" not in names and "AZURE_OPENAI_DEPLOYMENT" not in names


def test_the_secret_value_and_no_token_ever_appear_in_the_plan_or_template():
    plan = _plan()
    rendered = json.dumps(render_arm_template(plan)) + repr(plan.steps)
    assert "${signingSecretValue}" in repr(plan.steps)
    assert "[parameters('signingSecretValue')]" in rendered
    for forbidden in ("Bearer ", "client_secret", "access_token", "password"):
        assert forbidden not in rendered


def test_custody_and_storage_are_configured_to_be_erasable_and_private():
    steps = {s.path: s for s in _plan().steps}
    scopes = plan_module.Scopes(_inputs(), resource_names(_inputs()))
    vault = steps[scopes.vault].body["properties"]
    assert vault["enableRbacAuthorization"] and vault["enablePurgeProtection"]
    assert vault["softDeleteRetentionInDays"] == plan_module.KEY_VAULT_SOFT_DELETE_DAYS
    assert steps[scopes.key].create_only and steps[scopes.secret].create_only
    account = steps[scopes.storage].body["properties"]
    assert account["allowSharedKeyAccess"] is False and account["allowBlobPublicAccess"] is False
    blob = steps[scopes.blob_service].body["properties"]
    assert blob["deleteRetentionPolicy"] == {"enabled": False}
    assert blob["isVersioningEnabled"] is False
    env = steps[scopes.environment].body["properties"]
    assert env["workloadProfiles"] == [
        {"name": "Consumption", "workloadProfileType": "Consumption"}
    ]
    assert env["appLogsConfiguration"] == {"destination": None}
    assert steps[scopes.registry].body["sku"] == {"name": "Basic"}


def test_every_resource_is_tagged_with_the_setup_binding():
    plan = _plan()
    binding = plan_module.setup_binding(_HUSHH_ID, "0123456789abcdef")
    for step in plan.steps:
        if step.kind == "resource" and "tags" in step.body:
            assert step.body["tags"][plan_module.BINDING_TAG] == binding
            assert step.body["tags"]["hussh-tenancy"] == "user-owned"


def test_names_fit_azures_limits_and_never_name_the_person():
    names = resource_names(_inputs())
    assert re.fullmatch(r"[a-z][a-z0-9-]{2,23}", names.key_vault) and "--" not in names.key_vault
    assert re.fullmatch(r"[a-z0-9]{3,24}", names.storage_account)
    assert re.fullmatch(r"[a-zA-Z0-9]{5,50}", names.registry)
    assert len(names.container_app) <= 32 and len(names.resource_group) <= 90
    for name in names.__dict__.values():
        assert "abcdefghijk" not in name


def test_a_new_nonce_gives_new_global_names_and_the_same_group():
    first, second = resource_names(_inputs()), resource_names(_inputs(nonce="fedcba9876543210"))
    assert first.resource_group == second.resource_group
    assert first.key_vault != second.key_vault and first.storage_account != second.storage_account
