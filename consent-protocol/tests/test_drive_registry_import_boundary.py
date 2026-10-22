"""Registry tooling must work before application security profiles are hydrated."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("environment", ["uat", "prod"])
def test_registry_import_needs_no_application_keys(environment, tmp_path):
    # A fresh process excludes conftest's synthetic keys and cached runtime imports.
    result = subprocess.run(  # noqa: S603 - fixed interpreter and two authored module names
        [
            sys.executable,
            "-c",
            "import sys; "
            f"from hushh_mcp.services import drive_{environment}_registry_provisioning as registry; "
            "assert registry._canonical_row()['connector_id'] == 'google_drive'; "
            "assert {'config', 'api.middleware', "
            "'hushh_mcp.services.external_connector_google_oauth', "
            "'hushh_mcp.services.owner_placement_guard'}.isdisjoint(sys.modules)",
        ],
        cwd=tmp_path,
        env={
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
            "PYTHON_DOTENV_DISABLED": "1",
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, "Registry import loaded application runtime configuration"
