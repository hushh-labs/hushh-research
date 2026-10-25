"""Full production client → API → PostgreSQL → signed settlement document loop."""

import json
import sys

# ruff: noqa: F811 -- imported isolated PostgreSQL pytest fixtures
from contextlib import closing
from pathlib import Path

import pytest

from tests.helpers import document_delivery_browser as browser_helper
from tests.helpers.document_delivery_browser import (
    assert_browser_trace,
    assert_ended_access,
    assert_financial_receipts,
    browser_backend,
    browser_configuration,
    install_google_source_credential,
    install_identity_boundaries,
    install_intake_boundary,
    install_key_recovery_boundary,
    install_stripe_boundary,
    prepare_synthetic_source,
    reader_inventory,
    run_browser_process,
)
from tests.services.test_document_delivery import (  # noqa: F401
    connector_postgres_url,
    delivery_app,
    delivery_system,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_code", [0, 1])
async def test_browser_parent_removes_its_vite_cache_after_child_success_or_failure(
    monkeypatch, tmp_path, exit_code
):
    marker = tmp_path / "cache-path"
    group = browser_helper.run_path(
        str(Path(__file__).resolve().parents[3] / "scripts/ci/process_group.py")
    )["command_group"]
    child = """import json, pathlib, sys
config = json.load(sys.stdin)
cache = pathlib.Path(config['viteCacheDir'])
assert cache.is_dir()
(cache / 'optimizer-cache').write_text('synthetic dependency cache')
pathlib.Path(sys.argv[1]).write_text(str(cache))
print(json.dumps({'ready': True}))
sys.exit(int(sys.argv[2]))
"""

    def child_group(command, **kwargs):
        assert command == ["node", "scripts/testing/hosted-document-flow.mjs"]
        return group([sys.executable, "-c", child, str(marker), str(exit_code)], **kwargs)

    monkeypatch.setattr(browser_helper, "run_path", lambda _path: {"command_group": child_group})
    config = {"synthetic": True}
    if exit_code:
        with pytest.raises(AssertionError, match="Browser loop failed"):
            await run_browser_process(config)
    else:
        assert await run_browser_process(config) == {"ready": True}
    assert not Path(marker.read_text()).exists()
    assert config == {"synthetic": True}


@pytest.mark.asyncio
@pytest.mark.trace_loop
@pytest.mark.feature_protected_documents
@pytest.mark.parametrize("browser_engine", ["chromium", "webkit"])
async def test_protected_document_browser_payment_preview_download_revoke(
    delivery_system, delivery_app, sharing, browser_engine, monkeypatch
):
    system, app = delivery_system, delivery_app
    policy, schema = reader_inventory(system)
    # Hosted finance qualifies independently from legacy enrollment.
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "false")
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "false")
    original = await prepare_synthetic_source(system, sharing)
    install_identity_boundaries(app, monkeypatch)
    install_google_source_credential(system)
    install_intake_boundary(system, app, monkeypatch)
    install_key_recovery_boundary(system, app)
    install_stripe_boundary(system, app)
    config = browser_configuration(system, original, browser_engine)
    try:
        async with browser_backend(app) as origin:
            config["backend"] = origin
            result = await run_browser_process(config)
            assert_browser_trace(result, browser_engine)
            # Retired copies retain opaque obligations: intake OFF cannot
            # authorize rolling back to a binary without the reader.
            with closing(system.db.engine.raw_connection()) as connection:
                assert policy["inventory_empty"](connection, schema=schema) is False
            assert_financial_receipts(system)
            await assert_ended_access(system, app, result, original)
            print(
                json.dumps(
                    {
                        name: result[name]
                        for name in (
                            "feature",
                            "engine",
                            "trace_loop",
                            "elapsedMs",
                        )
                    }
                )
            )
    finally:
        config.clear()
