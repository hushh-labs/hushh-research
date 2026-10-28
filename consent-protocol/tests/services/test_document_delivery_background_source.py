"""Content identity and bounded diagnostics for background copies."""

import pytest

from hushh_mcp.services.document_delivery.background_source import (
    content_identity,
    require_original,
)
from hushh_mcp.services.document_delivery.contracts import DeliveryError

pytestmark = pytest.mark.feature_protected_documents


def test_source_identity_accepts_metadata_time_only_with_stable_content():
    facts = {
        "id": "file",
        "title": "code.js",
        "mimeType": "application/javascript",
        "size": "5",
        "modifiedTime": "2026-10-27T00:00:00Z",
        "md5Checksum": "a" * 32,
        "sha256Checksum": "b" * 64,
        "headRevisionId": "content-revision-1",
        "version": "9",
        "capabilities": {"canDownload": True},
    }
    source = {
        "id": "file",
        "name": "code.js",
        "mimeType": "application/javascript",
        "sourceVersion": "1",
        "sourceContentIdentity": content_identity(facts),
    }
    assert require_original(source, facts) == source["sourceContentIdentity"]
    after_grant = dict(facts, modifiedTime="2026-10-28T16:36:19.171Z")
    assert require_original(source, after_grant) == source["sourceContentIdentity"]
    for changed in (
        dict(after_grant, md5Checksum="c" * 32),
        dict(after_grant, sha256Checksum="c" * 64),
        dict(after_grant, headRevisionId="content-revision-2"),
        dict(after_grant, size="6"),
        dict(after_grant, title="different.js"),
    ):
        with pytest.raises(DeliveryError, match="source_changed"):
            require_original(source, changed)
    weak = {
        key: value
        for key, value in facts.items()
        if key not in {"sha256Checksum", "headRevisionId"}
    }
    with pytest.raises(DeliveryError, match="source_changed"):
        require_original(
            {**source, "sourceContentIdentity": content_identity(weak)},
            dict(weak, modifiedTime=after_grant["modifiedTime"]),
        )
    with pytest.raises(DeliveryError, match="download_restricted"):
        require_original(source, dict(facts, capabilities={"canDownload": False}))
    with pytest.raises(DeliveryError, match="source_identity_unavailable"):
        require_original({**source, "sourceContentIdentity": None}, facts)


def test_copy_diagnostics_preserve_failure_and_omit_source_values(caplog, monkeypatch):
    import logging
    from uuid import uuid4

    from hushh_mcp.services.document_delivery import background_diagnostics as diagnostics

    request, file = str(uuid4()), str(uuid4())
    private = "private-query-name-credential"
    row = {"request_id": request, "file_ref": file, "source": private}
    failure = diagnostics.CopySourceChanged("source_before", ["modified_time", "sha256"])
    with caplog.at_level(logging.INFO, logger="drive_copy"):
        with pytest.raises(DeliveryError) as caught:
            with diagnostics.copy_step(row, "source_before"):
                raise failure
    assert caught.value is failure
    assert (
        "stage=source_before" in caplog.text
        and "mismatch_fields=modified_time,sha256" in caplog.text
    )
    assert all(value not in caplog.text for value in (request, file, private))
    from mcp_modules.log_redaction import SensitiveLogFilter

    monkeypatch.setattr(diagnostics, "correlation_tag", lambda value: "1234567890123456")
    with caplog.at_level(logging.INFO, logger="drive_copy"):
        with diagnostics.copy_step(row, "source_before"):
            pass
    record = caplog.records[-1]
    SensitiveLogFilter().filter(record)
    assert "request_op=1234567890123456" in record.getMessage()
    assert "file_op=1234567890123456" in record.getMessage()

    def unavailable(*args, **kwargs):
        raise RuntimeError(private)

    monkeypatch.setattr(diagnostics.logger, "info", unavailable)
    with pytest.raises(DeliveryError) as caught:
        with diagnostics.copy_step(row, "source_before"):
            raise failure
    assert caught.value is failure
