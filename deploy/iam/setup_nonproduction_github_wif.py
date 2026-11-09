#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Inspect or admit canonical Dev/UAT callers on the existing GitHub providers.

This updates only the provider condition. It never creates identities, changes
roles, copies secrets, dispatches a deployment, or touches production.
"""

from __future__ import annotations

import argparse
import json
import time

REPOSITORY = "hushh-labs/hushh-research"
PROJECTS = {"dev": "621416509462", "uat": "745506018753"}
MAPPING = {
    "google.subject": "assertion.sub",
    "attribute.repository": "assertion.repository",
    "attribute.ref": "assertion.ref",
}
ISSUER = "https://token.actions.githubusercontent.com"


class Refused(ValueError):
    pass


def record(environment: str) -> dict:
    number = PROJECTS[environment]  # No production or caller-supplied project.
    subject = f"assertion.sub == 'repo:{REPOSITORY}:environment:{environment}'"
    legacy = (
        f"{subject} && assertion.ref == 'refs/heads/main' && "
        "assertion.event_name in ['workflow_dispatch', 'schedule', 'repository_dispatch']"
    )
    branch = (
        f"assertion.ref == 'refs/heads/{environment}' && "
        "assertion.event_name == 'workflow_dispatch' && "
        f"assertion.workflow_ref == '{REPOSITORY}/.github/workflows/"
        f"deploy-{environment}.yml@refs/heads/{environment}' && "
        f"assertion.job_workflow_ref == '{REPOSITORY}/.github/workflows/"
        f"deploy-{environment}-implementation.yml@refs/heads/main'"
    )
    # Keep the existing Main maintenance/native authority exactly as inspected.
    return {
        "name": f"projects/{number}/locations/global/workloadIdentityPools/"
        f"github-actions-{environment}/providers/hushh-research-{environment}",
        "legacy": legacy,
        "condition": legacy,
        "previous_condition": f"({legacy}) || ({subject} && {branch})",
    }


def inspect(provider: dict, expected: dict) -> str:
    if (
        provider.get("name") != expected["name"]
        or provider.get("state") != "ACTIVE"
        or provider.get("disabled", False)
        or provider.get("attributeMapping") != MAPPING
        or provider.get("oidc", {}).get("issuerUri") != ISSUER
        or provider.get("oidc", {}).get("allowedAudiences", [])
    ):
        raise Refused(
            "Provider identity, mapping or issuer differs; no update admitted"
        )
    condition = provider.get("attributeCondition")
    if condition == expected["condition"]:
        return "ready"
    if condition == expected["previous_condition"]:
        return "branch-enabled"
    raise Refused("Provider condition changed independently; review before updating")


def reconcile(api, environment: str, *, apply: bool = False) -> dict:
    expected = record(environment)
    path = expected["name"]
    before = api("GET", path)
    state = inspect(before, expected)
    if not apply or state == "ready":
        return {"environment": environment, "state": state, "changed": False}
    # Refuse an intervening edit. A lost patch response is uncertain, never
    # retried here; the next explicit inspection determines provider state.
    if api("GET", path) != before:
        raise Refused("Provider changed during inspection; no update admitted")
    operation = api(
        "PATCH",
        path + "?updateMask=attributeCondition",
        {"attributeCondition": expected["condition"]},
    )
    name = operation.get("name", "")
    prefix = path + "/operations/"
    if (
        not isinstance(name, str)
        or not name.startswith(prefix)
        or not name[len(prefix) :]
        or "/" in name[len(prefix) :]
    ):
        raise Refused("Provider update outcome uncertain; inspect before retry")
    for _ in range(15):
        if operation.get("done"):
            break
        time.sleep(2)
        operation = api("GET", name)
    if not operation.get("done") or operation.get("error"):
        raise Refused("Provider update unsettled; inspect before retry")
    state = inspect(api("GET", path), expected)
    if state != "ready":
        raise Refused(
            "Provider readback differs; Main-only activation unverified"
        )
    return {"environment": environment, "state": state, "changed": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", required=True, choices=tuple(PROJECTS))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    import google.auth
    from google.auth.transport.requests import AuthorizedSession, Request
    import requests

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(Request())
    # Token inspection supports the existing cloud-platform ADC without adding
    # userinfo API scopes. The token is sent only to Google and never logged.
    identity = requests.get(
        "https://oauth2.googleapis.com/tokeninfo",
        params={"access_token": credentials.token},
        timeout=20,
    )
    if identity.status_code != 200 or identity.json().get("email") != "kushal@hushh.ai":
        raise Refused("Expected kushal@hushh.ai ADC identity is not verified")
    with AuthorizedSession(credentials) as session:

        def api(method, path, body=None):
            response = session.request(
                method, "https://iam.googleapis.com/v1/" + path, json=body, timeout=30
            )
            if not response.ok:
                raise Refused(
                    f"Provider {method} refused (HTTP {response.status_code}); inspect before retry"
                )
            return response.json()

        print(
            json.dumps(
                reconcile(api, args.environment, apply=args.apply), sort_keys=True
            )
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Refused as error:
        raise SystemExit(str(error))
    except Exception as error:
        raise SystemExit(
            f"Deployment identity read/update unavailable ({type(error).__name__}); inspect before retry"
        )
