"""Provider-discovery package grants retain metadata and provenance fences."""

import pytest

from tests.services.test_drive_bulk_share_worker import _discovery_job, _worker


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", [False, True])
@pytest.mark.parametrize("provider_packet", [False, True])
async def test_discovery_delivery_uses_metadata_acl_checks_and_rejects_forged_source(
    tamper, provider_packet, shared_hub_owner
):
    worker, store, adapter = _worker()
    job = _discovery_job()
    file = job["file"]
    checkpoint = file["discoveryEvidence"]
    if provider_packet:
        file.update(
            packageDigest="a" * 64,
            sourceVersion="7",
            metadataOnly=True,
            fingerprintBasis="provider_metadata",
        )
    if tamper:
        file["name"] = "Changed recording"
    job["file"] = file
    await worker._grant(job)
    if tamper:
        adapter.inspect_shareable.assert_not_awaited()
        adapter.create_reader.assert_not_awaited()
    else:
        args = adapter.inspect_shareable.await_args.kwargs
        assert args["metadata_only"] is True
        assert args["metadata_period"]["start"] == checkpoint["period"]["start"]
        assert args["metadata_period"]["date_basis"] == "title_created_modified"
        adapter.create_reader.assert_awaited_once()
