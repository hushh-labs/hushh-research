"""Purpose-bound historical completion proof, never an access grant or report body."""

import json
import os
from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
)

SCHEMA = "kai-analysis-completion-proof.v1"


def _aad(owner: str, run_id: str) -> str:
    return json.dumps(
        [SCHEMA, os.getenv("ENVIRONMENT", "development"), owner, run_id], separators=(",", ":")
    )


def issue_completion_proof(owner: str, run_id: str, ticker: str) -> dict[str, Any]:
    claims = {
        "schema": SCHEMA,
        "owner": owner,
        "runId": run_id,
        "ticker": ticker,
        "completedAt": datetime.now(timezone.utc).isoformat(),
    }
    sealed = ExternalConnectorCredentialsService().encrypt_secret(
        json.dumps(claims, separators=(",", ":")), aad=_aad(owner, run_id)
    )
    return {"version": 1, **sealed}


def verify_completion_proof(owner: str, run_id: str, proof: dict[str, Any]) -> str:
    if (
        set(proof) != {"version", "ciphertext", "iv", "algorithm"}
        or type(proof.get("version")) is not int
        or proof.get("version") != 1
        or proof.get("algorithm") != "aes-256-gcm-aad-v1"
    ):
        raise ValueError("Completion proof unavailable")
    if (
        not isinstance(proof.get("ciphertext"), str)
        or len(proof["ciphertext"]) > 4096
        or not isinstance(proof.get("iv"), str)
        or len(proof["iv"]) > 128
    ):
        raise ValueError("Completion proof unavailable")
    try:
        value = ExternalConnectorCredentialsService().decrypt_secret(
            ciphertext=proof["ciphertext"], iv=proof["iv"], aad=_aad(owner, run_id)
        )
        claims = json.loads(value)
        if (
            set(claims) != {"schema", "owner", "runId", "ticker", "completedAt"}
            or claims["schema"] != SCHEMA
            or claims["owner"] != owner
            or claims["runId"] != run_id
        ):
            raise ValueError
        completed = datetime.fromisoformat(claims["completedAt"])
        ticker = claims["ticker"]
        if (
            completed.tzinfo is None
            or completed.timestamp() > datetime.now(timezone.utc).timestamp() + 300
            or not isinstance(ticker, str)
            or not 0 < len(ticker) <= 64
        ):
            raise ValueError
        return ticker
    except Exception:
        raise ValueError("Completion proof unavailable") from None
