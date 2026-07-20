"""Loader for the single authored Hussh Consent MCP public contract."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from jsonschema import Draft202012Validator

from mcp_modules.canonical_contract import (
    get_published_contract_tools,
    get_published_tool_names,
    published_tool_name,
)


@lru_cache(maxsize=1)
def get_public_contract() -> dict[str, Any]:
    return {
        "contractVersion": "0.4.0",
        "server": {
            "name": "Hushh Consent MCP Server",
            "version": "0.4.0",
            "instructions": {
                "consent_flow": [
                    "Search for the narrowest available scope.",
                    "Request consent or prepare consent-backed offer context.",
                    "Wait for a terminal lifecycle state before export retrieval.",
                    "Decrypt hosted ciphertext only in the connector, outside the model.",
                ]
            },
        },
        "resources": [],
        "tools": get_published_contract_tools(),
    }


def get_public_tool_names() -> tuple[str, ...]:
    return get_published_tool_names()


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
    validators = _contract_validators().get(published_tool_name(name) or str(name))
    return bool(validators) and not any(validators[0].iter_errors(payload))


def validate_public_tool_output(name: str, payload: object) -> bool:
    validators = _contract_validators().get(published_tool_name(name) or str(name))
    return bool(validators) and not any(validators[1].iter_errors(payload))
