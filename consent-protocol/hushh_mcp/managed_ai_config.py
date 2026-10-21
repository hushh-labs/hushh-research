"""Pure managed AI profile contract shared by runtime and deployment tooling."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

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


def load_pwm_policy(path: Path = PROFILE_PATH, *, environment: str | None = None) -> dict:
    """Research limits and provider are one checked-in runtime contract."""
    document = json.loads(path.read_text())
    runtime_environment = (environment or os.environ.get("ENVIRONMENT", "development")).lower()
    value = document[
        "pwm_research_uat"
        if runtime_environment == "uat" and "pwm_research_uat" in document
        else "pwm_research"
    ]
    provider = value.get("provider")
    azure = provider == "azure_openai_web_search"
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
        or provider not in {"vertex_google_search", "azure_openai_web_search"}
        or value["owner_source_provider"] != "vertex_url_context"
    ):
        raise ValueError("PWM requires a declared research provider and Vertex source review")
    if azure:
        config = value["azure"]
        if not isinstance(config, dict) or set(config) != {
            "tenant_id",
            "client_id",
            "primary_endpoint",
            "primary_deployment",
            "phi_endpoint",
            "phi_deployment",
        }:
            raise ValueError("PWM Azure runtime fields do not match the contract")
        for key in ("tenant_id", "client_id"):
            try:
                if str(UUID(config[key])) != config[key]:
                    raise ValueError
            except (TypeError, ValueError, AttributeError) as error:
                raise ValueError(f"Invalid PWM Azure {key}") from error
        for key, suffix in (
            ("primary_endpoint", ".openai.azure.com"),
            ("phi_endpoint", ".services.ai.azure.com"),
        ):
            endpoint = config[key]
            if not isinstance(endpoint, str):
                raise ValueError(f"Invalid PWM Azure {key}")
            parsed = urlsplit(endpoint)
            if (
                parsed.scheme != "https"
                or not (parsed.hostname or "").endswith(suffix)
                or parsed.path.rstrip("/") != "/openai/v1"
                or parsed.username
                or parsed.password
                or parsed.port is not None
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError(f"Invalid PWM Azure {key}")
        for key in ("primary_deployment", "phi_deployment"):
            if not isinstance(config[key], str) or not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", config[key]
            ):
                raise ValueError(f"Invalid PWM Azure {key}")
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
