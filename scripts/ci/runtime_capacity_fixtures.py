# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Synthetic retained-production inventory shared by capacity contract scenarios."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any


def retained_production_inventory(
    profile: dict[str, Any], make_revision: Callable[[str], dict[str, Any]]
) -> dict[str, Any]:
    config = profile["environments"]["production"]
    connection = f"{config['project']}:{profile['region']}:{config['database_instance']}"
    revisions = [
        make_revision("consent-protocol-current"),
        make_revision("consent-protocol-recent-drain"),
        make_revision("consent-protocol-older-drain"),
    ]
    for retained in revisions:
        retained["metadata"]["annotations"][
            "run.googleapis.com/cloudsql-instances"
        ] = connection
        retained["spec"]["containers"][0]["env"][1]["value"] = "4"
    job = {
        "metadata": {"name": "consent-protocol-genai-readiness"},
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "run.googleapis.com/cloudsql-instances": connection
                    }
                },
                "spec": {
                    "taskCount": 1,
                    "parallelism": 1,
                    "template": {
                        "spec": {
                            "containers": [
                                {"env": copy.deepcopy(
                                    revisions[0]["spec"]["containers"][0]["env"]
                                )}
                            ]
                        }
                    },
                },
            }
        },
    }
    return {
        "database_max_connections": 400,
        "services": {
            "consent-protocol": {
                "service": {
                    "status": {
                        "traffic": [
                            {"revisionName": "consent-protocol-current", "percent": 100}
                        ]
                    }
                },
                "revisions": revisions,
            }
        },
        "jobs": {"consent-protocol-genai-readiness": job},
    }
