#!/usr/bin/env python3
"""Finite company CRM drain for Cloud Scheduler -> Cloud Run Jobs."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.runtime_settings import hydrate_runtime_environment  # noqa: E402

hydrate_runtime_environment()

from db.db_client import close_db_engine  # noqa: E402
from hushh_mcp.services.hubspot_company_client import HubSpotCompanyClient  # noqa: E402
from hushh_mcp.services.hubspot_company_sync import HubSpotCompanySync  # noqa: E402


def main() -> int:
    client = None
    try:
        client = HubSpotCompanyClient(
            os.getenv("HUBSPOT_COMPANY_SYNC_SERVICE_KEY", ""),
            os.getenv("HUBSPOT_COMPANY_PORTAL_ID", ""),
        )
        result = HubSpotCompanySync(client).run()
        ok = not result["mapping_blocked"]
        print(json.dumps({"ok": ok, **result}, sort_keys=True))
        return 0 if ok else 1
    except Exception as exc:
        # Provider/DB exception text can contain credentials or private identity.
        print(json.dumps({"ok": False, "error_type": type(exc).__name__}))
        return 1
    finally:
        if client is not None:
            client.close()
        close_db_engine()


if __name__ == "__main__":
    raise SystemExit(main())
