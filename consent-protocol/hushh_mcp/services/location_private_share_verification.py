"""Verify the atomic writer result before committing command authority."""

from typing import Any


def save_verified_command_share(command: Any, row: Any, params: dict) -> None:
    from hushh_mcp.services.one_location_agent_service import OneLocationAgentError, _loads_json

    grant = _loads_json(row.get("grant_row"))
    envelope = _loads_json(row.get("envelope_row"))
    if (
        not isinstance(grant, dict)
        or not isinstance(envelope, dict)
        or (_loads_json(grant.get("metadata")) or {}).get("client_operation_fingerprint")
        != params["_command_fingerprint"]
    ):
        raise OneLocationAgentError(
            "LOCATION_OPERATION_CONFLICT",
            "The saved share differs from this command.",
            status_code=409,
        )
    command.save(str(grant["id"]))
