"""Loader for the single authored Hussh Consent MCP public contract."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

_CONTRACT_PATH = Path(__file__).parent / "tools" / "public_contract.json"


@lru_cache(maxsize=1)
def get_public_contract() -> dict[str, Any]:
    with _CONTRACT_PATH.open(encoding="utf-8") as handle:
        contract = json.load(handle)
    if contract.get("contractVersion") != "0.3.0":
        raise RuntimeError("Unsupported Hussh MCP public contract version")
    return contract


def get_public_tool_names() -> tuple[str, ...]:
    return tuple(str(item["name"]) for item in get_public_contract()["tools"])


def get_server_instructions() -> str:
    return json.dumps(
        get_public_contract()["server"]["instructions"],
        separators=(",", ":"),
    )


@lru_cache(maxsize=1)
def _contract_validators() -> dict[str, tuple[Draft202012Validator, Draft202012Validator]]:
    return {
        str(tool["name"]): (
            Draft202012Validator(tool["inputSchema"]),
            Draft202012Validator(tool["outputSchema"]),
        )
        for tool in get_public_contract()["tools"]
    }


def validate_public_tool_input(name: str, payload: object) -> bool:
    validators = _contract_validators().get(name)
    return bool(validators) and not any(validators[0].iter_errors(payload))


def validate_public_tool_output(name: str, payload: object) -> bool:
    validators = _contract_validators().get(name)
    return bool(validators) and not any(validators[1].iter_errors(payload))
