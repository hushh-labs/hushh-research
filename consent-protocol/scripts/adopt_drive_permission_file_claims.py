#!/usr/bin/env python3
"""Release preflight: adopt existing uncertain file claims without provider I/O.

Optional bootstrap reads this environment's sharing key only when adoption needs
it, into process memory through workflow ADC. Database credentials are supplied by
the existing attested migration step. No secrets or file identities are printed.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def release_project(environment):
    project = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat"}[environment]
    if os.environ.get("GCP_PROJECT_ID") != project:
        raise ValueError("drive_claim_adoption_environment_mismatch")
    return project


def release_keys(environment):
    from google.cloud import secretmanager

    project = release_project(environment)
    client = secretmanager.SecretManagerServiceClient()
    try:
        for name in ("DRIVE_SHARING_KEY_V1",):
            value = client.access_secret_version(
                request={"name": f"projects/{project}/secrets/{name}/versions/latest"}
            )
            os.environ[name] = value.payload.data.decode()
    finally:
        client.transport.close()


async def main(release_environment=None):
    from hushh_mcp.services.drive_permission_file_claims import (
        has_unclaimed_uncertainty,
        seed_uncertain_claims,
    )
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
    from hushh_mcp.services.external_connector_lifecycle_store import (
        ExternalConnectorLifecycleStore,
    )

    if release_environment:
        release_project(release_environment)
    store = ExternalConnectorLifecycleStore()
    # The migration blocks old unclaimed dispatches. A no-work Dev preflight
    # needs no optional Drive key; a race still fails closed during adoption.
    if release_environment and await store._transaction(has_unclaimed_uncertainty):
        await asyncio.to_thread(release_keys, release_environment)
    adopted = await store._transaction(
        lambda connection: seed_uncertain_claims(connection, DriveSharingCipher())
    )
    print(json.dumps({"schema_version": 1, "adopted_claims": adopted, "provider_calls": 0}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-environment", choices=("dev", "uat"))
    args = parser.parse_args()
    try:
        asyncio.run(main(args.release_environment))
    except Exception:
        print(
            json.dumps({"schema_version": 1, "status": "failed", "reason": "claim_adoption_failed"})
        )
        raise SystemExit(1) from None
