"""The Connect Azure setup as a deterministic, dry-run reviewable plan of ARM calls.

Every call runs under the PERSON's own delegated token, once, in the stage order of
the setup job (``AZURE_JOB_STAGES``). The plan is a pure function of its inputs: the
same person, nonce, subscription and location always produce byte-identical steps, so
it can be reviewed before anything runs and rendered as an ARM template
(``azure_setup_template``) that a parity test holds to the applier.

Values that only exist once something is created (the agent identity's principal id,
the key version, the imported image digest) appear as ``${placeholders}``; the applier
substitutes them and refuses to send any step that still carries one.

WHAT HUSSH ENDS UP HOLDING (the trust matrix in byoc-azure.md)
Only the custom "Hussh Pod Observer" role on the agent and its environment (read,
revisions read, restart), plus "Hussh Access Removal": ``roleAssignments/delete``
under an ABAC condition that matches only Hussh's own principal and the agent's. Never
Key Vault, Storage, ``ManagedIdentity/*/write`` or ``roleAssignments/write``.
``test_azure_setup_plan`` asserts exactly this from the rendered plan.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Literal, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS
from hushh_mcp.services.azure_keyed import keyed_digest
from hushh_mcp.services.azure_setup_roles import (
    HUSSH_PRINCIPAL,
    OBSERVER_ACTIONS,
    POD_PRINCIPAL,
    REMOVAL_ACTIONS,
    ROLE_ACR_PULL,
    ROLE_COGNITIVE_SERVICES_OPENAI_USER,
    ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER,
    ROLE_KEY_VAULT_SECRETS_USER,
    ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR,
    observer_role_id,
    removal_condition,
    removal_role_id,
    role_assignment_body,
    role_assignment_path,
    role_definition_body,
)

AZURE_JOB_STAGES: tuple[str, ...] = (
    "creating_resource_group",
    "registering_providers",
    "creating_identity",
    "creating_key_vault",
    "creating_storage",
    "creating_registry",
    "creating_model",
    "creating_environment",
    "assigning_roles",
    "importing_image",
    "deploying_agent",
    "proving",
)

REQUIRED_PROVIDERS: tuple[str, ...] = (
    "Microsoft.App",
    "Microsoft.ManagedIdentity",
    "Microsoft.KeyVault",
    "Microsoft.Storage",
    "Microsoft.ContainerRegistry",
    "Microsoft.CognitiveServices",
)

POD_CLIENT_ID = "${podClientId}"
KEY_URI_WITH_VERSION = "${keyUriWithVersion}"
SIGNING_SECRET_VALUE = "${signingSecretValue}"  # noqa: S105 - a placeholder, never a value
IMAGE_DIGEST = "${imageDigest}"

#: Recorded on the receipt; Key Vault refuses to purge a protected vault before it.
KEY_VAULT_SOFT_DELETE_DAYS = 90
#: Names inside the person's dedicated resource group (unique there by construction).
IDENTITY_NAME = "id-hussh-one-pod"
ENVIRONMENT_NAME = "cae-hussh-one"
CONTAINER_APP_NAME = "ca-hussh-one-pod"
TENANCY_TAG = "hussh-tenancy"
NONCE_TAG = "hussh-setup-nonce"
BINDING_TAG = "hussh-setup-binding"

StepKind = Literal["resource", "action", "role_definition", "role_assignment"]


@dataclass(frozen=True)
class ModelChoice:
    """The agent's own chat model, deployed in the person's Azure OpenAI account."""

    name: str = "gpt-5-mini"
    version: str = "2025-08-07"
    sku: str = "GlobalStandard"
    capacity: int = 50
    account_kind: Literal["OpenAI", "AIServices"] = "OpenAI"


@dataclass(frozen=True)
class ResourceNames:
    resource_group: str
    identity: str
    key_vault: str
    key: str
    signing_secret: str
    storage_account: str
    blob_container: str
    registry: str
    openai_account: str
    model_deployment: str
    environment: str
    container_app: str


@dataclass(frozen=True)
class PlanInputs:
    hushh_id: str
    tenant_id: str
    subscription_id: str
    location: str
    resource_group: str
    nonce: str
    model: Optional[ModelChoice] = field(default_factory=ModelChoice)


@dataclass(frozen=True)
class ArmStep:
    stage: str
    kind: StepKind
    method: Literal["PUT", "POST"]
    path: str
    api: str
    body: dict[str, Any]
    #: Read first and skip when present (a re-run must not rotate a key or secret).
    create_only: bool = False
    #: A refusal here is a typed outcome (the model may be unavailable), not a failure.
    optional: bool = False


def resource_group_name(hushh_id: str) -> str:
    """``rg-hussh-one-<keyed digest>``: names the person to nobody but the hub."""
    return f"rg-hussh-one-{keyed_digest('resource-group', hushh_id)[:20]}"


def setup_binding(hushh_id: str, nonce: str) -> str:
    """The tag value that proves Hussh's setup, for THIS agent, created a resource."""
    return keyed_digest("setup-binding", hushh_id, nonce)


def resource_names(inputs: PlanInputs) -> ResourceNames:
    digest = keyed_digest("resource-names", inputs.hushh_id, inputs.nonce)[:16]
    return ResourceNames(
        resource_group=inputs.resource_group,
        identity=IDENTITY_NAME,
        key_vault=f"kv-h1-{digest}",
        key="pod-log-key",
        signing_secret="pod-signing-key",  # noqa: S106 - a secret NAME, not a value
        storage_account=f"sthussh{digest}",
        blob_container="pod",
        registry=f"crhussh{digest}",
        openai_account=f"oai-hussh-{digest}",
        model_deployment="one-chat",
        environment=ENVIRONMENT_NAME,
        container_app=CONTAINER_APP_NAME,
    )


def tags(inputs: PlanInputs) -> dict[str, str]:
    return {
        TENANCY_TAG: "user-owned",
        NONCE_TAG: inputs.nonce,
        BINDING_TAG: setup_binding(inputs.hushh_id, inputs.nonce),
    }


class Scopes:
    """ARM ids for every resource in the plan, derived once from the names."""

    def __init__(self, inputs: PlanInputs, names: ResourceNames) -> None:
        self.subscription = f"/subscriptions/{inputs.subscription_id}"
        self.group = f"{self.subscription}/resourceGroups/{names.resource_group}"
        p = f"{self.group}/providers"
        self.identity = f"{p}/Microsoft.ManagedIdentity/userAssignedIdentities/{names.identity}"
        self.vault = f"{p}/Microsoft.KeyVault/vaults/{names.key_vault}"
        self.key = f"{self.vault}/keys/{names.key}"
        self.secret = f"{self.vault}/secrets/{names.signing_secret}"
        self.storage = f"{p}/Microsoft.Storage/storageAccounts/{names.storage_account}"
        self.blob_service = f"{self.storage}/blobServices/default"
        self.container = f"{self.blob_service}/containers/{names.blob_container}"
        self.registry = f"{p}/Microsoft.ContainerRegistry/registries/{names.registry}"
        self.openai = f"{p}/Microsoft.CognitiveServices/accounts/{names.openai_account}"
        self.deployment = f"{self.openai}/deployments/{names.model_deployment}"
        self.environment = f"{p}/Microsoft.App/managedEnvironments/{names.environment}"
        self.app = f"{p}/Microsoft.App/containerApps/{names.container_app}"

    def role_definition(self, role_id: str) -> str:
        return f"{self.subscription}/providers/Microsoft.Authorization/roleDefinitions/{role_id}"


def group_id(subscription_id: str, resource_group: str) -> str:
    return f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}"


def app_id(subscription_id: str, resource_group: str) -> str:
    group = group_id(subscription_id, resource_group)
    return f"{group}/providers/Microsoft.App/containerApps/{CONTAINER_APP_NAME}"


def environment_id(subscription_id: str, resource_group: str) -> str:
    group = group_id(subscription_id, resource_group)
    return f"{group}/providers/Microsoft.App/managedEnvironments/{ENVIRONMENT_NAME}"


def identity_id(subscription_id: str, resource_group: str) -> str:
    group = group_id(subscription_id, resource_group)
    return f"{group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/{IDENTITY_NAME}"


def _assign(
    stage: str, scopes: Scopes, scope: str, role_id: str, principal: str, condition: str = ""
) -> ArmStep:
    body = role_assignment_body(scopes.role_definition(role_id), principal, condition=condition)
    path = role_assignment_path(scope, role_id, principal)
    return ArmStep(stage, "role_assignment", "PUT", path, "authorization", body)


def _resource(stage: str, path: str, api: str, body: dict, **flags: Any) -> ArmStep:
    return ArmStep(
        stage=stage, kind="resource", method="PUT", path=path, api=api, body=body, **flags
    )


def _foundation_steps(inputs: PlanInputs, names: ResourceNames, scopes: Scopes) -> list[ArmStep]:
    located = {"location": inputs.location, "tags": tags(inputs)}
    steps = [_resource("creating_resource_group", scopes.group, "resources", dict(located))]
    steps += [
        ArmStep(
            stage="registering_providers",
            kind="action",
            method="POST",
            path=f"{scopes.subscription}/providers/{namespace}/register",
            api="resources",
            body={},
        )
        for namespace in REQUIRED_PROVIDERS
    ]
    steps.append(_resource("creating_identity", scopes.identity, "managed_identity", dict(located)))
    return steps


def _custody_steps(inputs: PlanInputs, names: ResourceNames, scopes: Scopes) -> list[ArmStep]:
    located = {"location": inputs.location, "tags": tags(inputs)}
    vault = {
        **located,
        "properties": {
            "tenantId": inputs.tenant_id,
            "sku": {"family": "A", "name": "standard"},
            "enableRbacAuthorization": True,
            "enableSoftDelete": True,
            "softDeleteRetentionInDays": KEY_VAULT_SOFT_DELETE_DAYS,
            "enablePurgeProtection": True,
            "publicNetworkAccess": "Enabled",
        },
    }
    key = {"properties": {"kty": "RSA", "keySize": 3072, "keyOps": ["wrapKey", "unwrapKey"]}}
    secret = {"properties": {"value": SIGNING_SECRET_VALUE, "contentType": "text/plain"}}
    account = {
        **located,
        "sku": {"name": "Standard_LRS"},
        "kind": "StorageV2",
        "properties": {
            "allowSharedKeyAccess": False,
            "allowBlobPublicAccess": False,
            "allowCrossTenantReplication": False,
            "defaultToOAuthAuthentication": True,
            "minimumTlsVersion": "TLS1_2",
            "supportsHttpsTrafficOnly": True,
            "publicNetworkAccess": "Enabled",
        },
    }
    # Soft delete and versioning OFF: the agent's crypto-erase must actually delete.
    blob_service = {
        "properties": {
            "deleteRetentionPolicy": {"enabled": False},
            "containerDeleteRetentionPolicy": {"enabled": False},
            "isVersioningEnabled": False,
        }
    }
    return [
        _resource("creating_key_vault", scopes.vault, "key_vault", vault),
        _resource("creating_key_vault", scopes.key, "key_vault", key, create_only=True),
        _resource("creating_key_vault", scopes.secret, "key_vault", secret, create_only=True),
        _resource("creating_storage", scopes.storage, "storage", account),
        _resource("creating_storage", scopes.blob_service, "storage", blob_service),
        _resource(
            "creating_storage",
            scopes.container,
            "storage",
            {"properties": {"publicAccess": "None"}},
        ),
    ]


def _platform_steps(inputs: PlanInputs, names: ResourceNames, scopes: Scopes) -> list[ArmStep]:
    located = {"location": inputs.location, "tags": tags(inputs)}
    registry = {
        **located,
        "sku": {"name": "Basic"},
        "properties": {
            "adminUserEnabled": False,
            "anonymousPullEnabled": False,
            "publicNetworkAccess": "Enabled",
        },
    }
    steps = [_resource("creating_registry", scopes.registry, "container_registry", registry)]
    if inputs.model is not None:
        steps += _model_steps(inputs.model, names, scopes, located)
    environment = {
        **located,
        "properties": {
            # Consumption only: no dedicated profile, nothing billed while idle.
            "workloadProfiles": [{"name": "Consumption", "workloadProfileType": "Consumption"}],
            # Logs destination none: no Log Analytics workspace meter.
            "appLogsConfiguration": {"destination": None},
            "zoneRedundant": False,
        },
    }
    steps.append(
        _resource("creating_environment", scopes.environment, "container_apps", environment)
    )
    return steps


def _model_steps(
    model: ModelChoice, names: ResourceNames, scopes: Scopes, located: dict
) -> list[ArmStep]:
    account = {
        **located,
        "kind": model.account_kind,
        "sku": {"name": "S0"},
        "properties": {
            "customSubDomainName": names.openai_account,
            "disableLocalAuth": True,
            "publicNetworkAccess": "Enabled",
        },
    }
    deployment = {
        "sku": {"name": model.sku, "capacity": model.capacity},
        "properties": {
            "model": {"format": "OpenAI", "name": model.name, "version": model.version},
        },
    }
    return [
        _resource("creating_model", scopes.openai, "cognitive_services", account, optional=True),
        _resource(
            "creating_model", scopes.deployment, "cognitive_services", deployment, optional=True
        ),
    ]


def _role_definition(
    inputs: PlanInputs, scopes: Scopes, role_id: str, label: str, actions: tuple[str, ...]
) -> ArmStep:
    body = role_definition_body(label, inputs.resource_group, scopes.group, actions)
    path = f"{scopes.group}/providers/Microsoft.Authorization/roleDefinitions/{role_id}"
    return ArmStep("assigning_roles", "role_definition", "PUT", path, "authorization", body)


def _role_steps(inputs: PlanInputs, names: ResourceNames, scopes: Scopes) -> list[ArmStep]:
    observer, removal = observer_role_id(inputs), removal_role_id(inputs)
    stage = "assigning_roles"
    steps = [
        _role_definition(inputs, scopes, observer, "Hussh Pod Observer", OBSERVER_ACTIONS),
        _role_definition(inputs, scopes, removal, "Hussh Access Removal", REMOVAL_ACTIONS),
        _assign(
            stage, scopes, scopes.key, ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER, POD_PRINCIPAL
        ),
        _assign(stage, scopes, scopes.secret, ROLE_KEY_VAULT_SECRETS_USER, POD_PRINCIPAL),
        _assign(stage, scopes, scopes.container, ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR, POD_PRINCIPAL),
        _assign(stage, scopes, scopes.registry, ROLE_ACR_PULL, POD_PRINCIPAL),
    ]
    if inputs.model is not None:
        steps.append(
            _assign(
                stage, scopes, scopes.openai, ROLE_COGNITIVE_SERVICES_OPENAI_USER, POD_PRINCIPAL
            )
        )
    steps += [
        _assign(stage, scopes, scopes.group, removal, HUSSH_PRINCIPAL, removal_condition()),
        _assign(stage, scopes, scopes.environment, observer, HUSSH_PRINCIPAL),
    ]
    return steps


def import_image_step(scopes: Scopes, source_registry: str, source_repository: str) -> ArmStep:
    """Pull the approved digest into the person's own registry, untagged."""
    body = {
        "source": {
            "registryUri": source_registry,
            "sourceImage": f"{source_repository}@{IMAGE_DIGEST}",
        },
        "untaggedTargetRepositories": ["consent-protocol-pod"],
        "mode": "NoForce",
    }
    return ArmStep(
        "importing_image", "action", "POST", f"{scopes.registry}/importImage",
        "container_registry", body,
    )  # fmt: skip


def agent_steps(scopes: Scopes, app_body: dict[str, Any], inputs: PlanInputs) -> list[ArmStep]:
    """Create the agent, then let Hussh observe THIS app (it cannot exist earlier)."""
    observer = observer_role_id(inputs)
    return [
        _resource("deploying_agent", scopes.app, "container_apps", app_body),
        _assign("deploying_agent", scopes, scopes.app, observer, HUSSH_PRINCIPAL),
    ]


@dataclass(frozen=True)
class SetupPlan:
    inputs: PlanInputs
    names: ResourceNames
    steps: tuple[ArmStep, ...]

    def stage_steps(self, stage: str) -> tuple[ArmStep, ...]:
        return tuple(step for step in self.steps if step.stage == stage)

    def api_version(self, step: ArmStep) -> str:
        return API_VERSIONS[step.api]


def build_setup_plan(
    inputs: PlanInputs,
    *,
    source_registry: str,
    source_repository: str,
    app_body: dict[str, Any],
) -> SetupPlan:
    """Every ARM call of one setup, in stage order. Pure and deterministic."""
    names = resource_names(inputs)
    scopes = Scopes(inputs, names)
    steps = [
        *_foundation_steps(inputs, names, scopes),
        *_custody_steps(inputs, names, scopes),
        *_platform_steps(inputs, names, scopes),
        *_role_steps(inputs, names, scopes),
        import_image_step(scopes, source_registry, source_repository),
        *agent_steps(scopes, app_body, inputs),
    ]
    order = {stage: index for index, stage in enumerate(AZURE_JOB_STAGES)}
    if [order[s.stage] for s in steps] != sorted(order[s.stage] for s in steps):
        raise AssertionError("setup plan steps are out of stage order")
    return SetupPlan(inputs=inputs, names=names, steps=tuple(steps))


def without_model(inputs: PlanInputs) -> PlanInputs:
    """The same plan for a subscription whose model step was refused."""
    return replace(inputs, model=None)


__all__ = [
    "AZURE_JOB_STAGES",
    # Re-exported from azure_setup_roles so plan callers keep one import site.
    "HUSSH_PRINCIPAL",
    "OBSERVER_ACTIONS",
    "POD_PRINCIPAL",
    "REMOVAL_ACTIONS",
    "ROLE_ACR_PULL",
    "ROLE_COGNITIVE_SERVICES_OPENAI_USER",
    "ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER",
    "ROLE_KEY_VAULT_SECRETS_USER",
    "ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR",
    "observer_role_id",
    "removal_role_id",
    "role_assignment_path",
    "ArmStep",
    "ModelChoice",
    "PlanInputs",
    "ResourceNames",
    "Scopes",
    "SetupPlan",
    "build_setup_plan",
    "resource_group_name",
    "resource_names",
    "setup_binding",
    "without_model",
]
