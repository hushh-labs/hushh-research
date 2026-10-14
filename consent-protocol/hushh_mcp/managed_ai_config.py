"""Pure managed AI profile contract shared by runtime and deployment tooling."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

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


def load_pwm_policy(path: Path = PROFILE_PATH) -> dict:
    """Research limits share the managed-runtime configuration; no provider env split."""
    value = json.loads(path.read_text())["pwm_research"]
    if (
        set(value)
        != {
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
        or value["provider"] != "vertex_google_search"
        or value["owner_source_provider"] != "vertex_url_context"
    ):
        raise ValueError("PWM requires the declared native Vertex providers")
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
