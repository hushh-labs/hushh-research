#!/usr/bin/env python3
"""Verify the no-record Omni Gateway CRM transport contract.

This gate deliberately performs only MCP ``initialize`` and ``tools/list``.
It never reads the CRM registry, searches for a person, or invokes a mutating
CRM operation. Client credentials stay in process memory and are never
rendered in output or reports.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

OMNIGATEWAY_SECRETS = (
    "OMNIGATEWAY_CLIENT_ID",
    "OMNIGATEWAY_CLIENT_SECRET",
)


def _read_secret_value(project: str, name: str) -> str | None:
    """Read one credential for the in-memory handshake without logging it."""

    result = subprocess.run(  # noqa: S603 - fixed executable and argv; never shell=True
        [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            name,
            "--project",
            project,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    value = result.stdout.rstrip("\r\n")
    return value or None


def _gateway_contract() -> tuple[str, frozenset[str]]:
    """Load the exact gateway endpoint/tool contract used by the backend."""

    protocol_root = Path(__file__).resolve().parents[2] / "consent-protocol"
    if str(protocol_root) not in sys.path:
        sys.path.insert(0, str(protocol_root))

    from hushh_mcp.services.connected_systems_service import (  # noqa: PLC0415
        EXTERNAL_CRM_TOOL_CATALOG,
        REGISTRY_MCP_ENDPOINT,
    )

    endpoint = str(REGISTRY_MCP_ENDPOINT or "").strip()
    expected_tools = frozenset(
        str(entry.get("name") or "").strip()
        for entry in EXTERNAL_CRM_TOOL_CATALOG
        if str(entry.get("name") or "").strip()
    )
    if not endpoint or not expected_tools:
        raise RuntimeError("connected_systems_contract_unconfigured")
    return endpoint, expected_tools


async def _list_tools(
    endpoint: str,
    *,
    client_id: str,
    client_secret: str,
    timeout_seconds: int,
) -> frozenset[str]:
    """Run the read-only Streamable HTTP handshake against the Omni Gateway."""

    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async def _run() -> frozenset[str]:
        async with streamablehttp_client(
            endpoint,
            headers={"client_id": client_id, "client_secret": client_secret},
            timeout=timeout_seconds,
            sse_read_timeout=timeout_seconds,
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                listed = await session.list_tools()
        return frozenset(str(tool.name) for tool in getattr(listed, "tools", []))

    return await asyncio.wait_for(_run(), timeout=timeout_seconds)


def run(project: str, *, timeout_seconds: int = 30) -> dict[str, object]:
    """Return a redacted readiness report for the production deployment gate."""

    credentials = {
        name: _read_secret_value(project, name) for name in OMNIGATEWAY_SECRETS
    }
    missing_credentials = sorted(
        name for name, value in credentials.items() if not value
    )
    if missing_credentials:
        return {
            "status": "blocked",
            "classification": "omni_gateway_secret_unavailable",
            "missingSecrets": missing_credentials,
        }

    try:
        endpoint, expected_tools = _gateway_contract()
        listed_tools = asyncio.run(
            _list_tools(
                endpoint,
                client_id=str(credentials["OMNIGATEWAY_CLIENT_ID"]),
                client_secret=str(credentials["OMNIGATEWAY_CLIENT_SECRET"]),
                timeout_seconds=timeout_seconds,
            )
        )
    except Exception:
        # Do not render exception messages: HTTP/MCP clients may include request
        # headers in transport failures.
        return {
            "status": "blocked",
            "classification": "omni_gateway_readonly_probe_failed",
        }

    missing_tools = sorted(expected_tools - listed_tools)
    if missing_tools:
        return {
            "status": "blocked",
            "classification": "omni_gateway_tool_contract_mismatch",
            "missingTools": missing_tools,
        }

    return {
        "status": "healthy",
        "probe": "mcp_initialize_and_tools_list",
        "expectedToolCount": len(expected_tools),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run a redacted, no-record Connected Systems Omni Gateway readiness check."
    )
    parser.add_argument("--project", required=True, help="GCP project containing Omni secrets.")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=30,
        help="Maximum handshake duration (default: 30).",
    )
    args = parser.parse_args(argv)
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")

    report = run(args.project, timeout_seconds=args.timeout_seconds)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "healthy" else 1


if __name__ == "__main__":
    raise SystemExit(main())
