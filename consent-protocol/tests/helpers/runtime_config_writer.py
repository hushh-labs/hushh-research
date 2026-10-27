# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Synthetic CLI inputs and secret reads for the real runtime config writer."""

import json
import subprocess
from collections.abc import Callable


def configuration_arguments(project: str, environment: str, origin: str) -> dict[str, str]:
    return {
        "project": project,
        "environment": environment,
        "app-frontend-origin": origin,
        "db-host": "synthetic",
        "db-port": "5432",
        "db-name": "synthetic",
        "consent-sse-enabled": "false",
        "sync-remote-enabled": "false",
        "developer-api-enabled": "false",
        "remote-mcp-enabled": "false",
        "cors-allowed-origins": origin,
        "obs-data-stale-ratio-threshold": "0.35",
    }


def configuration_reader(
    *,
    project: str,
    existing: dict,
    target: str,
    candidate_only: bool,
    candidate_payload: dict | None,
) -> Callable[..., subprocess.CompletedProcess[str]]:
    def read_existing_config(command: list[str], **_kwargs) -> subprocess.CompletedProcess[str]:
        if candidate_only and target in command:
            assert command[1:4] == ["secrets", "versions", "access"] or command[1:3] == [
                "secrets",
                "describe",
            ]
            if candidate_payload is not None and "access" in command:
                return subprocess.CompletedProcess(command, 0, json.dumps(candidate_payload), "")
            return subprocess.CompletedProcess(command, 1, "", "NOT_FOUND")
        assert command == [
            "gcloud",
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            "BACKEND_RUNTIME_CONFIG_JSON",
            "--project",
            project,
        ]
        return subprocess.CompletedProcess(command, 0, json.dumps(existing), "")

    return read_existing_config
