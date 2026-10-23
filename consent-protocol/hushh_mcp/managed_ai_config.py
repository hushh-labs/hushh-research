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


def selected_managed_provider() -> str:
    selected = os.getenv("HUSHH_UAT_MANAGED_AI_PROVIDER") or os.getenv(
        "HUSHH_UAT_MANAGED_TEXT_PROVIDER", "azure_openai"
    )
    if selected not in {"azure_openai", "vertex"} or (
        os.getenv("HUSHH_UAT_MANAGED_AI_PROVIDER")
        and os.getenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER")
        and os.environ["HUSHH_UAT_MANAGED_TEXT_PROVIDER"] != selected
    ):
        raise ValueError("Managed runtime provider bindings disagree")
    return selected


def load_managed_runtime_policy(
    path: Path = PROFILE_PATH, *, environment: str | None = None
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
    value = json.loads(path.read_text())["managed_runtime_uat"]
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
    azure = value["azure"]
    if not isinstance(azure, dict) or set(azure) != {
        "realtime",
        "transcription",
        "speech",
        "embedding",
        "embedding_dimensions",
        "voice",
    }:
        raise ValueError("Invalid managed Azure capability bindings")
    for kind in ("realtime", "transcription", "speech", "embedding"):
        binding = azure[kind]
        if not isinstance(binding, dict) or set(binding) != {"deployment", "model", "version"}:
            raise ValueError("Invalid managed Azure deployment descriptor")
        if any(
            not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", v)
            for v in binding.values()
        ):
            raise ValueError("Invalid managed Azure deployment descriptor")
    if type(azure["embedding_dimensions"]) is not int or azure["embedding_dimensions"] != 768:
        raise ValueError("Managed Location embeddings require 768 dimensions")
    if azure["voice"] not in {"coral"}:
        raise ValueError("Unsupported managed Azure voice")
    selected = selected_managed_provider()
    digest = profile_hash(
        {
            "policy": value,
            "azure": load_pwm_policy(path, environment="uat", provider="azure_openai")["azure"],
        }
    )
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
    path: Path = PROFILE_PATH, *, environment: str | None = None, provider: str | None = None
) -> dict:
    """Research limits and provider are one checked-in runtime contract."""
    document = json.loads(path.read_text())
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
        selected_managed_provider() if runtime_environment == "uat" else "vertex"
    )
    value = dict(
        document["pwm_research_uat"]
        if runtime_environment == "uat"
        and selected == "azure_openai"
        and "pwm_research_uat" in document
        else document["pwm_research"]
    )
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
