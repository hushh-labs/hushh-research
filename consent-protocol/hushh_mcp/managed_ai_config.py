"""Pure managed AI profile contract shared by runtime and deployment tooling."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
from functools import cache
from pathlib import Path
from uuid import UUID, uuid5

PROFILE_PATH = Path(__file__).resolve().parents[1] / "config" / "managed-ai-runtime.json"
FIELDS = {
    "project",
    "auth_mode",
    "text_model",
    "text_locations",
    "live_model",
    "live_location",
    "embedding_model",
}
# Account identity is selected by name; deployment names are shared by every account.
AZURE_ACCOUNT_FIELDS = ("tenant_id", "client_id", "primary_endpoint", "phi_endpoint")
AZURE_DEPLOYMENT_FIELDS = frozenset({"primary_deployment", "phi_deployment"})


def validate_profile(value: dict, *, local: bool = False) -> dict:
    if set(value) != FIELDS:
        raise RuntimeError("Managed AI profile fields do not match the contract")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", value["project"]):
        raise RuntimeError("Invalid managed AI project")
    if value["auth_mode"] not in {"vertex_adc", "developer_api_key"} or (
        not local and value["auth_mode"] != "vertex_adc"
    ):
        raise RuntimeError("Hosted managed AI requires Vertex ADC")
    if (
        not isinstance(value["text_locations"], list)
        or not value["text_locations"]
        or any(
            not isinstance(item, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", item)
            for item in value["text_locations"]
        )
    ):
        raise RuntimeError("Invalid managed AI text locations")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", value["live_location"]):
        raise RuntimeError("VERTEX_LIVE_LOCATION requires a regional location")
    for key in ("text_model", "live_model", "embedding_model"):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", value[key]):
            raise RuntimeError("Invalid managed AI model")
    return value


def load_profile(environment: str, path: Path = PROFILE_PATH) -> dict:
    document = json.loads(path.read_text())
    if document.get("version") != 1 or environment not in document.get("environments", {}):
        raise RuntimeError("Unknown managed AI runtime profile")
    return validate_profile(
        dict(document["environments"][environment]), local=environment == "local"
    )


def profile_hash(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def load_private_drive_text_policy(path: Path = PROFILE_PATH) -> dict:
    """Versioned administrator rollout; never an owner's acceptance receipt."""
    value = json.loads(path.read_text())["private_drive_text_uat"]
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "enabled",
            "policy_id",
            "version",
            "provider",
            "alternate_provider",
            "readiness",
            "authority_basis",
            "scope",
        }
        or type(value["enabled"]) is not bool
        or value["provider"] != "azure_openai"
        or value["alternate_provider"] != "vertex"
        or value["readiness"] != "any_usable_text"
        or value["authority_basis"] != "administrator_rollout"
        or value["scope"] != "one_text_chat_and_drive_requests"
        or not isinstance(value["version"], str)
        or not re.fullmatch(r"[a-z0-9-]{1,64}", value["version"])
        or str(UUID(value["policy_id"])) != value["policy_id"]
    ):
        raise ValueError("Invalid UAT private Drive text policy")
    return value


def configured_managed_provider(
    environment: str, path: Path = PROFILE_PATH, *, document: dict | None = None
) -> str:
    """Packaged fleet default; revision pins are resolved separately below.

    Only UAT has an administrator-selected Azure/Vertex runtime. Other lanes
    retain their existing Vertex contract; BYOK and owner-cloud routing are separate.
    """
    document = json.loads(path.read_text()) if document is None else document
    # Version-one candidates predating the central selector declared Azure in
    # their existing UAT processor policy. Preserve their release receipts.
    selection = document.get("managed_provider_selection")
    if selection is None and "managed_provider_selection" not in document:
        selection = {"uat": document.get("private_drive_text_uat", {}).get("provider")}
    if (
        document.get("version") != 1
        or not isinstance(selection, dict)
        or set(selection) != {"uat"}
        or not isinstance(selection["uat"], str)
        or selection["uat"] not in {"azure_openai", "vertex"}
    ):
        raise ValueError("Invalid managed provider selection")
    if environment not in document.get("environments", {}):
        raise ValueError("Unknown managed AI runtime profile")
    return selection["uat"] if environment == "uat" else "vertex"


def validate_runtime_config(path: Path = PROFILE_PATH) -> dict:
    """Validate all packaged settings without credentials, clients or inference.

    Provider readiness separately qualifies the selected runtime's complete
    capability bundle before any candidate is allowed to serve traffic.
    """
    document = json.loads(path.read_text())
    environments = ("local", "dev", "uat", "production")
    if set(document.get("environments", {})) != set(environments):
        raise ValueError("Managed AI configuration requires every environment")
    providers = {}
    for environment in environments:
        load_profile(environment, path)
        providers[environment] = configured_managed_provider(environment, path)
    load_private_drive_text_policy(path)
    load_pwm_policy(path, environment="production", provider="vertex")
    load_pwm_policy(path, environment="uat", provider="azure_openai")
    _validate_standby_azure_accounts(document)
    load_managed_runtime_policy(path, environment="uat", provider=providers["uat"])
    return {"valid": True, "providers": providers, "config_fingerprint": profile_hash(document)}


def _canonical_uuid(value: object) -> bool:
    try:
        return str(UUID(str(value))) == value
    except (TypeError, ValueError, AttributeError):
        return False


def _azure_accounts(document: dict) -> dict | None:
    """Named managed Azure accounts; candidates predating them keep the inline block."""
    if "managed_azure_accounts" not in document:
        return None
    value = document["managed_azure_accounts"]
    if (
        not isinstance(value, dict)
        or set(value) != {"selection", "accounts"}
        or not isinstance(value["selection"], dict)
        or set(value["selection"]) != {"uat"}
        or not isinstance(value["accounts"], dict)
        or not 1 <= len(value["accounts"]) <= 8
        or value["selection"]["uat"] not in value["accounts"]
    ):
        raise ValueError("Invalid managed Azure account selection")
    for name, account in value["accounts"].items():
        if (
            not re.fullmatch(r"[a-z][a-z0-9-]{1,47}", name)
            or not isinstance(account, dict)
            or set(account) != {*AZURE_ACCOUNT_FIELDS, "readiness_exam_client_id"}
        ):
            raise ValueError("Invalid managed Azure account")
    runtime_apps = {account["client_id"] for account in value["accounts"].values()}
    for account in value["accounts"].values():
        exam = account["readiness_exam_client_id"]
        if exam is not None and (not _canonical_uuid(exam) or exam in runtime_apps):
            raise ValueError("The readiness exam requires its own Entra application")
    return value


def _resolved_azure(document: dict, deployments: dict) -> dict:
    """Join the selected account's identity to the shared deployment names."""
    accounts = _azure_accounts(document)
    if accounts is None:
        return dict(deployments)  # Inline legacy block; the PWM contract checks it.
    if not isinstance(deployments, dict) or set(deployments) != AZURE_DEPLOYMENT_FIELDS:
        raise ValueError("Azure deployments must not repeat account identity")
    account = accounts["accounts"][accounts["selection"]["uat"]]
    return {**{key: account[key] for key in AZURE_ACCOUNT_FIELDS}, **deployments}


def _validate_standby_azure_accounts(document: dict) -> None:
    """Shape-check every account before merge, not only the selected one."""
    accounts = _azure_accounts(document)
    if accounts is None:
        return
    deployments = document["pwm_research_uat"]["azure"]
    for account in accounts["accounts"].values():
        _azure_config_validator()(
            {**{key: account[key] for key in AZURE_ACCOUNT_FIELDS}, **deployments}
        )


def load_managed_azure_account(path: Path = PROFILE_PATH, *, document: dict | None = None) -> dict:
    """UAT's selected managed Azure account: identifiers only, never credentials."""
    document = json.loads(path.read_text()) if document is None else document
    azure = load_pwm_policy(environment="uat", provider="azure_openai", document=document)["azure"]
    accounts = _azure_accounts(document)
    name = accounts["selection"]["uat"] if accounts else None
    return {
        "name": name,
        **{key: azure[key] for key in AZURE_ACCOUNT_FIELDS},
        "readiness_exam_client_id": (
            accounts["accounts"][name]["readiness_exam_client_id"] if accounts else None
        ),
    }


def managed_azure_inventory(path: Path = PROFILE_PATH) -> dict:
    """Every deployment the selected account must host, derived from this one file."""
    document = json.loads(path.read_text())
    runtime = document["managed_runtime_uat"]["azure"]
    primary = load_pwm_policy(environment="uat", provider="azure_openai", document=document)
    descriptors = {
        kind: {key: runtime[kind][key] for key in ("deployment", "model", "version")}
        for kind in sorted(runtime)
        if isinstance(runtime[kind], dict)
    }
    return {
        "account": load_managed_azure_account(document=document),
        # The primary model and version are not yet declared; record them when switching.
        "deployments": {"primary": {"deployment": primary["azure"]["primary_deployment"]}}
        | descriptors,
    }


def selected_managed_provider(path: Path = PROFILE_PATH, *, document: dict | None = None) -> str:
    configured = configured_managed_provider("uat", path, document=document)
    selected = os.getenv("HUSHH_UAT_MANAGED_AI_PROVIDER") or os.getenv(
        "HUSHH_UAT_MANAGED_TEXT_PROVIDER", configured
    )
    if selected not in {"azure_openai", "vertex"} or (
        os.getenv("HUSHH_UAT_MANAGED_AI_PROVIDER")
        and os.getenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER")
        and os.environ["HUSHH_UAT_MANAGED_TEXT_PROVIDER"] != selected
    ):
        raise ValueError("Managed runtime provider bindings disagree")
    return selected


def _validate_managed_azure_bindings(azure: dict, required: list[str]) -> None:
    legacy_bindings = {
        "realtime",
        "transcription",
        "speech",
        "embedding",
        "embedding_dimensions",
        "voice",
    }
    optional = {"compact_public_search", "one_text_root"}
    if (
        not isinstance(azure, dict)
        or not legacy_bindings <= set(azure)
        or set(azure) - legacy_bindings - optional
    ):
        raise ValueError("Invalid managed Azure capability bindings")
    for capability in optional:
        if (capability in azure) != (capability in required):
            raise ValueError("Azure text policy requires matching capability qualification")
    kinds = ("realtime", "transcription", "speech", "embedding")
    for kind in (*kinds, *sorted(optional & set(azure))):
        binding = azure[kind]
        fields = {"deployment", "model", "version"}
        if kind in optional:
            fields |= {"reasoning_effort", "text_verbosity"}
        if not isinstance(binding, dict) or set(binding) != fields:
            raise ValueError("Invalid managed Azure deployment descriptor")
        if any(
            not isinstance(binding[key], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", binding[key])
            for key in ("deployment", "model", "version")
        ):
            raise ValueError("Invalid managed Azure deployment descriptor")
        if kind in optional and (
            binding["reasoning_effort"] != "none" or binding["text_verbosity"] != "low"
        ):
            raise ValueError("Invalid compact public search generation budget")
    if type(azure["embedding_dimensions"]) is not int or azure["embedding_dimensions"] != 768:
        raise ValueError("Managed Location embeddings require 768 dimensions")
    if azure["voice"] not in {"coral"}:
        raise ValueError("Unsupported managed Azure voice")


def load_managed_runtime_policy(
    path: Path = PROFILE_PATH,
    *,
    environment: str | None = None,
    provider: str | None = None,
    document: dict | None = None,
) -> dict | None:
    """UAT processor selection only; callers retain information/action authority.

    This expanded administrator rollout is separate from the narrower historical
    One/Drive consent descriptor. It does not select or redirect a BYOK client.
    """
    env = (
        (environment or os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "local")
        .strip()
        .lower()
    )
    if env != "uat":
        return None
    document = json.loads(path.read_text()) if document is None else document
    value = document["managed_runtime_uat"]
    if (
        not isinstance(value, dict)
        or set(value)
        != {"policy_id", "version", "authority_basis", "scope", "azure", "required_capabilities"}
        or value["authority_basis"] != "administrator_rollout"
        or value["scope"] != "managed_runtime_capabilities"
        or not re.fullmatch(r"[a-z0-9-]{1,64}", str(value["version"]))
        or str(UUID(value["policy_id"])) != value["policy_id"]
    ):
        raise ValueError("Invalid UAT managed runtime policy")
    required = value["required_capabilities"]
    if (
        not isinstance(required, list)
        or not 1 <= len(required) <= 32
        or any(
            not isinstance(item, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", item)
            for item in required
        )
        or len(set(required)) != len(required)
    ):
        raise ValueError("Invalid managed capability inventory")
    _validate_managed_azure_bindings(value["azure"], required)
    selected = selected_managed_provider(path, document=document) if provider is None else provider
    if selected not in {"azure_openai", "vertex"}:
        raise ValueError("Invalid managed provider selection")
    azure = load_pwm_policy(path, environment="uat", provider="azure_openai", document=document)
    digest = profile_hash({"policy": value, "azure": azure["azure"]})
    return {
        **value,
        "provider": selected,
        "config_fingerprint": digest,
        "generation": str(uuid5(UUID(value["policy_id"]), value["version"] + digest + selected)),
    }


@cache
def _azure_config_validator():
    # Deployment tools load this stdlib-only contract without package startup.
    path = Path(__file__).with_name("pwm_provider_policy.py")
    spec = importlib.util.spec_from_file_location("pwm_provider_policy", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_azure_config


def load_pwm_policy(
    path: Path = PROFILE_PATH,
    *,
    environment: str | None = None,
    provider: str | None = None,
    document: dict | None = None,
) -> dict:
    """Research limits and provider are one checked-in runtime contract."""
    document = json.loads(path.read_text()) if document is None else document
    runtime_environment = (
        (
            environment
            or os.environ.get("HUSHH_DEPLOY_ENV")
            or os.environ.get("ENVIRONMENT", "development")
        )
        .strip()
        .lower()
    )
    if provider is not None and provider not in {"azure_openai", "vertex"}:
        raise ValueError("Invalid research processor selection")
    selected = provider or (
        selected_managed_provider(path, document=document)
        if runtime_environment == "uat"
        else "vertex"
    )
    uat_research = (
        runtime_environment == "uat"
        and selected == "azure_openai"
        and "pwm_research_uat" in document
    )
    value = dict(document["pwm_research_uat"] if uat_research else document["pwm_research"])
    if runtime_environment == "uat":
        value["owner_source_provider"] = "public_https"
    provider = value.get("provider")
    azure = provider in {"azure_openai_web_search", "azure_openai_tavily"}
    if (
        set(value)
        != (
            {
                "provider",
                "owner_source_provider",
                "search_invocations",
                "model_calls",
                "slice_seconds",
                "job_seconds",
                "lease_seconds",
                "preview_source_limit",
                "preview_fact_limit",
                "notification_scheduler",
            }
            | ({"azure"} if azure else set())
        )
        or provider
        not in {"vertex_google_search", "azure_openai_web_search", "azure_openai_tavily"}
        or value["owner_source_provider"]
        != ("public_https" if runtime_environment == "uat" else "vertex_url_context")
    ):
        raise ValueError("PWM requires declared research and source-review providers")
    if azure:
        if uat_research:  # Named accounts select UAT's managed identity only.
            value["azure"] = _resolved_azure(document, value["azure"])
        _azure_config_validator()(value["azure"])
    limits = {
        "search_invocations": 32,
        "model_calls": 128,
        "slice_seconds": 240,
        "job_seconds": 270,
        "lease_seconds": 300,
        "preview_source_limit": 3,
        "preview_fact_limit": 8,
    }
    if any(
        type(value[key]) is not int or not 1 <= value[key] <= limit for key, limit in limits.items()
    ):
        raise ValueError("PWM budget exceeds the reviewed execution contract")
    if azure and (value["search_invocations"], value["model_calls"]) != (8, 16):
        raise ValueError("Azure PWM requires its reviewed 8-search, 16-model-call budget")
    if not value["slice_seconds"] < value["job_seconds"] < value["lease_seconds"] <= 300:
        raise ValueError("PWM execution must fit the existing owner-key lifetime")
    validate_pwm_scheduler(value["notification_scheduler"])
    return dict(value)


def validate_pwm_scheduler(scheduler: dict) -> dict:
    """One authority contract for runtime and the UAT deployment script."""
    expected = {
        "project": "hushh-pda-uat",
        "audience": "https://api.uat.hushh.ai",
        "service_account": "pwm-notifications@hushh-pda-uat.iam.gserviceaccount.com",
        "job": "pwm-notifications-uat",
        "location": "us-central1",
    }
    if scheduler != expected:
        raise ValueError("PWM scheduler is outside the reviewed UAT authority")
    return scheduler
