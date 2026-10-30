# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Inert retained-release and isolated DEV inventory fixtures for capacity tests."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any


def retained_production_inventory(
    profile: dict[str, Any], make_revision: Callable[[str], dict[str, Any]]
) -> dict[str, Any]:
    config = profile["environments"]["production"]
    connection = (
        f"{config['project']}:{profile['region']}:{config['database_instance']}"
    )
    revisions = [
        make_revision("consent-protocol-current"),
        make_revision("consent-protocol-recent-drain"),
        make_revision("consent-protocol-older-drain"),
    ]
    for retained in revisions:
        retained["metadata"]["annotations"]["run.googleapis.com/cloudsql-instances"] = (
            connection
        )
        retained["spec"]["containers"][0]["env"][1]["value"] = "4"
    job = {
        "metadata": {"name": "consent-protocol-genai-readiness"},
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {"run.googleapis.com/cloudsql-instances": connection}
                },
                "spec": {
                    "taskCount": 1,
                    "parallelism": 1,
                    "template": {
                        "spec": {
                            "containers": [
                                {
                                    "env": copy.deepcopy(
                                        revisions[0]["spec"]["containers"][0]["env"]
                                    )
                                }
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


CONNECTION = "hushh-pda-uat:us-central1:hushh-uat-pg"
DEV_OLD_CONNECTION = "hushh-pda-dev:us-central1:hushh-dev-pg"
ISOLATED_DEV_CONNECTION = "hushh-pda-dev:us-central1:plg-qualification-pg"


def revision(
    name: str, *, max_instances: int = 5, overflow: int = 0, created: str = "2026-10-01"
) -> dict:
    return {
        "metadata": {
            "name": name,
            "creationTimestamp": created,
            "annotations": {
                "autoscaling.knative.dev/maxScale": str(max_instances),
                "run.googleapis.com/cloudsql-instances": CONNECTION,
            },
        },
        "spec": {
            "containers": [
                {
                    "name": "backend",
                    "env": [
                        {"name": "DB_POOL_MAX_SIZE", "value": "4"},
                        {"name": "DB_SQLALCHEMY_POOL_SIZE", "value": "3"},
                        {"name": "DB_SQLALCHEMY_MAX_OVERFLOW", "value": str(overflow)},
                    ],
                }
            ]
        },
    }


def foreign_dev_workload(name):
    route = {"name": "DB_UNIX_SOCKET", "value": "/cloudsql/" + DEV_OLD_CONNECTION}
    return {
        "metadata": {
            "name": name,
            "annotations": {
                "run.googleapis.com/cloudsql-instances": DEV_OLD_CONNECTION
            },
        },
        "spec": {"containers": [{"env": [route]}]},
    }


def isolated_dev_inventory(profile):
    config = profile["environments"]["dev"]

    rows = {
        ("projects", "describe", config["project"]): {
            "projectId": config["project"],
            "projectNumber": "123456789012",
        },
        ("sql", "instances", "describe", config["database_instance"]): {
            "state": "RUNNABLE",
            "name": config["database_instance"],
            "project": config["project"],
            "region": "us-central1",
            "connectionName": ISOLATED_DEV_CONNECTION,
            "ipAddresses": [{"ipAddress": "192.0.2.10"}],
            "settings": {
                "settingsVersion": "1",
                "databaseFlags": [
                    {"name": "cloudsql.iam_authentication", "value": "on"},
                    {"name": "max_connections", "value": "100"},
                ],
            },
        },
        ("run", "services", "list"): [
            {"metadata": {"name": name}} for name in config["non_database_services"]
        ],
        ("run", "jobs", "list"): [
            {"metadata": {"name": name}} for name in config["non_target_jobs"]
        ],
    }
    for name in config["non_database_services"]:
        current, retained = (
            foreign_dev_workload(name + "-current"),
            foreign_dev_workload(name + "-retained"),
        )
        rows[("run", "services", "describe", name)] = {
            "spec": {"template": copy.deepcopy(current)},
            "status": {
                "traffic": [
                    {"revisionName": current["metadata"]["name"], "percent": 100}
                ],
                "latestReadyRevisionName": current["metadata"]["name"],
            },
        }
        rows[("run", "revisions", "list", "--service=" + name)] = [
            current,
            retained,
        ]
    for name in config["non_target_jobs"]:
        rows[("run", "jobs", "describe", name)] = {
            "metadata": {"name": name},
            "spec": {"template": foreign_dev_workload(name + "-template")},
        }
        rows[("run", "jobs", "executions", "list", "--job=" + name)] = []
    active = "guard-observer-active"
    rows[("run", "jobs", "executions", "list", "--job=guard-observer")] = [
        {"metadata": {"name": active}}
    ]
    observed = foreign_dev_workload(active)
    observed["metadata"]["labels"] = {"run.googleapis.com/job": "guard-observer"}
    rows[("run", "jobs", "executions", "describe", active)] = observed

    def read(*args):
        key = tuple(
            arg for arg in args if not arg.startswith(("--project=", "--region="))
        )
        return copy.deepcopy(rows[key])

    return profile, config, rows, read
