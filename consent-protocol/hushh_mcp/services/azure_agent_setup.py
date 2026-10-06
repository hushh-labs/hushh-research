"""Create the agent in the person's subscription, under their own delegated token.

This is the only place anything is WRITTEN into an owner Azure subscription during
setup, and it runs inside the setup job while the person's token is in memory.

THE SETUP BINDING (closes the confused-deputy gap)
The resource group and the agent carry ``hussh-setup-nonce`` and
``hussh-setup-binding = HMAC(hushh_id|nonce)``. A retry reuses the nonce of a group
already bound to THIS agent; a group with no valid binding is refused rather than
adopted, so setup never writes into a group Hussh did not create for this person.
Every later read (attach, discover, erasure) re-verifies the binding from ARM.

The binding is over the HusshID rather than the account uid because the backend that
re-verifies it is database-free and ``PodSpec`` deliberately carries no user id; the
registry binds the two one-to-one.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hushh_mcp.services import azure_federation as federation
from hushh_mcp.services.azure_agent_observation import assigned_identity
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_container_app_renderer import AgentCoordinates, render_container_app
from hushh_mcp.services.azure_image_source import import_credentials
from hushh_mcp.services.azure_keyed import digest_matches
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused, SetupApplier
from hushh_mcp.services.azure_setup_plan import (
    BINDING_TAG,
    IMAGE_DIGEST,
    KEY_URI_WITH_VERSION,
    NONCE_TAG,
    POD_CLIENT_ID,
    PlanInputs,
    Scopes,
    SetupPlan,
    build_setup_plan,
    resource_group_name,
    resource_names,
    tags,
)
from hushh_mcp.services.azure_subscription_limits import environment_limit_refusal
from hushh_mcp.services.compute_backend import PodSpec

logger = logging.getLogger(__name__)

_IMMUTABLE_SOURCE = re.compile(r"^([a-z0-9.-]+\.[a-z]{2,})/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$")
_NONCE = re.compile(r"^[0-9a-f]{16}$")
_HEALTH_DELAYS: tuple[float, ...] = (5, 10, 15, 20, 30, 30, 30, 30)


@dataclass(frozen=True)
class AzureSetupResult:
    tenant_id: str
    subscription_id: str
    resource_group: str
    location: str
    nonce: str
    model_credential_mode: str
    model_outcome: str
    image_digest: str
    app_id: str
    fqdn: str
    pod_principal_id: str
    pod_client_id: str
    incarnation: str


def hub_caller_identity() -> str:
    """The hub's Google identity the agent's wall admits (same as the GCP tier)."""
    import os  # noqa: PLC0415

    value = (os.getenv("HUSSH_CONSENT_PLANE_SA") or "").strip()
    return value.removeprefix("serviceAccount:").strip()


def parse_source_image(reference: str) -> tuple[str, str, str]:
    """``registry/repository@sha256:...`` -> (registry, repository, digest). Digest only."""
    match = _IMMUTABLE_SOURCE.match(str(reference or "").strip())
    if not match:
        raise AzureSetupRefused(
            "the agent image must be pinned by digest before it is imported",
            code="IMAGE_NOT_PINNED",
        )
    return match.group(1), match.group(2), match.group(3)


def binding_is_valid(tag_map: Any, hushh_id: str) -> bool:
    """The resource carries a setup binding Hussh minted for THIS agent."""
    tag_map = tag_map if isinstance(tag_map, dict) else {}
    nonce = str(tag_map.get(NONCE_TAG) or "")
    return bool(_NONCE.match(nonce)) and digest_matches(
        str(tag_map.get(BINDING_TAG) or ""), "setup-binding", hushh_id, nonce
    )


def bound_nonce(arm: ArmClient, *, subscription_id: str, hushh_id: str) -> str:
    """Reuse the nonce of THIS agent's group, mint one for a new group, refuse a foreign one."""
    group = f"/subscriptions/{subscription_id}/resourceGroups/{resource_group_name(hushh_id)}"
    existing = arm.get_or_none(group, api_version=API_VERSIONS["resources"], op="bind")
    if existing is None:
        return secrets.token_hex(8)
    if not binding_is_valid(existing.get("tags"), hushh_id):
        raise AzureSetupRefused(
            "A resource group with this agent's name exists but was not created by "
            "Hussh's setup for you. Nothing was changed.",
            code="RESOURCE_GROUP_FOREIGN",
        )
    return str(existing["tags"][NONCE_TAG])


def setup_nonce(arm: ArmClient, *, subscription_id: str, spec: PodSpec, adopt: bool) -> str:
    """The group's nonce. A rebuild (``adopt``) first proves only the hosting is gone.

    Read-only either way. The rebuild's survey (``azure_hosting_rebuild``) refuses a
    missing group, identity, vault, key, secret, storage account or container, so a
    rebuild can never fall through to minting a new nonce, and with it new names.
    """
    if not adopt:
        return bound_nonce(arm, subscription_id=subscription_id, hushh_id=spec.hushh_id)
    from hushh_mcp.services.azure_hosting_rebuild import survey_custody  # noqa: PLC0415

    return survey_custody(
        arm,
        subscription_id=subscription_id,
        hushh_id=spec.hushh_id,
        recorded_principal=spec.expected_runtime_principal or "",
    ).nonce


def plan_factory(
    spec: PodSpec, *, source_registry: str, source_repository: str, incarnation: str
) -> Callable[[PlanInputs], SetupPlan]:
    """Build (and rebuild, without a model) the plan for one agent."""

    def _plan(inputs: PlanInputs) -> SetupPlan:
        names = resource_names(inputs)
        scopes = Scopes(inputs, names)
        coords = AgentCoordinates(
            location=inputs.location,
            environment_id=scopes.environment,
            identity_id=scopes.identity,
            identity_client_id=POD_CLIENT_ID,
            registry_server=f"{names.registry}.azurecr.io",
            image_digest=IMAGE_DIGEST,
            blob_url=f"https://{names.storage_account}.blob.core.windows.net/{names.blob_container}",
            key_vault_key=KEY_URI_WITH_VERSION,
            signing_secret_url=(
                f"https://{names.key_vault}.vault.azure.net/secrets/{names.signing_secret}"
            ),
            incarnation=incarnation,
            hub_caller_emails=hub_caller_identity(),
            openai_endpoint=(
                f"https://{names.openai_account}.openai.azure.com/" if inputs.model else None
            ),
            openai_deployment=names.model_deployment if inputs.model else None,
            tags=tags(inputs),
        )
        return build_setup_plan(
            inputs,
            source_registry=source_registry,
            source_repository=source_repository,
            app_body=render_container_app(spec, coords),
        )

    return _plan


def _await_health(fqdn: str, *, http: Any, sleep: Callable[[float], None]) -> bool:
    for delay in (0.0, *_HEALTH_DELAYS):
        if delay:
            sleep(delay)
        try:
            if http.get(f"https://{fqdn}/health", timeout=10).status_code == 200:
                return True
        except Exception:  # noqa: BLE001 - a cold start refuses connections for a while
            continue
    return False


def prove(
    arm: ArmClient, plan: SetupPlan, values: dict[str, str], *, http: Any, sleep: Callable
) -> tuple[str, dict[str, Any]]:
    """Read the agent back from ARM and wait for its health; return (fqdn, app)."""
    scopes = Scopes(plan.inputs, plan.names)
    app = arm.get(scopes.app, api_version=API_VERSIONS["container_apps"], op="proving")
    principal, _client_id = assigned_identity(app, scopes.identity)
    fqdn = str(
        ((app.get("properties") or {}).get("configuration") or {}).get("ingress", {}).get("fqdn")
        or ""
    )
    if not binding_is_valid(app.get("tags"), plan.inputs.hushh_id) or principal != values.get(
        "podPrincipalId"
    ):
        raise AzureSetupRefused("the created agent did not read back as ours", code="PROOF_FAILED")
    if not fqdn or not _await_health(fqdn, http=http, sleep=sleep):
        raise AzureSetupRefused(
            "Your agent was created but has not started answering yet. Try again in a few "
            "minutes; everything already created is kept.",
            code="AGENT_NOT_SERVING",
        )
    return fqdn, app


def run_agent_setup(
    *,
    access_token: str,
    tenant_id: str,
    subscription_id: str,
    location: str,
    spec: PodSpec,
    source_image: str,
    advance: Callable[[str], None],
    arm: Optional[ArmClient] = None,
    hussh_principal_id: Optional[str] = None,
    image_credentials: Optional[Callable[[], dict[str, str]]] = None,
    http: Any = None,
    sleep: Callable[[float], None] = time.sleep,
    adopt: bool = False,
) -> AzureSetupResult:
    """Every setup stage before and including ``proving``. Synchronous.

    ``image_credentials`` defaults to the configured image reader
    (``azure_image_source``): minted at the import call, never the hub's own token.
    ``adopt`` is the rebuild after Azure removed the hosting space: same nonce, custody
    read and kept (``SetupApplier(adopt=True)``), only hosting and agent created.
    """
    registry, repository, digest = parse_source_image(source_image)
    if image_credentials is None:
        image_credentials = import_credentials(registry)
    arm = arm or ArmClient(access_token, sleep=sleep)
    nonce = setup_nonce(arm, subscription_id=subscription_id, spec=spec, adopt=adopt)
    principal = hussh_principal_id or federation.app_token(tenant_id).object_id
    if not principal:
        raise AzureSetupRefused(
            "the Hussh app is not present in this directory", code="APP_NOT_CONSENTED"
        )
    incarnation = uuid.uuid4().hex
    plan_for = plan_factory(
        spec, source_registry=registry, source_repository=repository, incarnation=incarnation
    )
    inputs = PlanInputs(
        hushh_id=spec.hushh_id,
        tenant_id=tenant_id,
        subscription_id=subscription_id,
        location=location,
        resource_group=resource_group_name(spec.hushh_id),
        nonce=nonce,
    )
    values = {"husshPrincipalId": principal, "imageDigest": digest}
    applier = SetupApplier(
        arm, advance=advance, sleep=sleep, image_source_credentials=image_credentials, adopt=adopt
    )
    try:
        result = applier.apply(plan_for(inputs), values=values, plan_for=plan_for)
    except ArmError as exc:
        # A subscription limit is the person's to resolve: name it and what fills it.
        refusal = environment_limit_refusal(exc, arm, subscription_id)
        if refusal is not None:
            raise refusal from exc
        raise
    advance("proving")
    if http is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        http = requests
    plan = result.plan or plan_for(inputs)
    fqdn, app = prove(arm, plan, result.values, http=http, sleep=sleep)
    return AzureSetupResult(
        tenant_id=tenant_id,
        subscription_id=subscription_id,
        resource_group=inputs.resource_group,
        location=location,
        nonce=nonce,
        model_credential_mode="user_azure_mi" if result.model_available else "byok_per_turn",
        model_outcome=result.model_outcome,
        image_digest=digest,
        app_id=str(app.get("id") or Scopes(plan.inputs, plan.names).app),
        fqdn=fqdn,
        pod_principal_id=result.values.get("podPrincipalId", ""),
        pod_client_id=result.values.get("podClientId", ""),
        incarnation=incarnation,
    )


__all__ = [
    "AzureSetupResult",
    "binding_is_valid",
    "bound_nonce",
    "hub_caller_identity",
    "parse_source_image",
    "plan_factory",
    "prove",
    "run_agent_setup",
    "setup_nonce",
]
