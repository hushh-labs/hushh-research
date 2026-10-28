#!/usr/bin/env python3
"""Release preflight: adopt existing uncertain file claims without provider I/O.

Optional release bootstrap reads only this environment's signing/sharing keys
into process memory through workflow ADC. Database credentials remain supplied by
the existing attested migration step. No secrets or file identities are printed.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def release_keys(environment):
    from google.cloud import secretmanager

    project = {"dev": "hushh-pda-dev", "uat": "hushh-pda-uat"}[environment]
    if os.environ.get("GCP_PROJECT_ID") != project:
        raise ValueError("drive_claim_adoption_environment_mismatch")
    client = secretmanager.SecretManagerServiceClient()
    try:
        for name in ("APP_SIGNING_KEY", "DRIVE_SHARING_KEY_V1"):
            value = client.access_secret_version(
                request={"name": f"projects/{project}/secrets/{name}/versions/latest"}
            )
            os.environ[name] = value.payload.data.decode()
    finally:
        client.close()


async def main():
    from hushh_mcp.services.drive_permission_file_claims import seed_uncertain_claims
    from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher
    from hushh_mcp.services.external_connector_lifecycle_store import (
        ExternalConnectorLifecycleStore,
    )

    store = ExternalConnectorLifecycleStore()
    adopted = await store._transaction(
        lambda connection: seed_uncertain_claims(connection, DriveSharingCipher())
    )
    print(json.dumps({"schema_version": 1, "adopted_claims": adopted, "provider_calls": 0}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-environment", choices=("dev", "uat"))
    args = parser.parse_args()
    try:
        if args.release_environment:
            release_keys(args.release_environment)
        asyncio.run(main())
    except Exception:
        print(
            json.dumps({"schema_version": 1, "status": "failed", "reason": "claim_adoption_failed"})
        )
        raise SystemExit(1) from None
