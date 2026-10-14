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
