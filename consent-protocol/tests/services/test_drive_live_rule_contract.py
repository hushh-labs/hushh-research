"""An offline repeat needs the same recipient, purpose, file and observed content."""

import base64
from types import SimpleNamespace
from uuid import uuid4

from hushh_mcp.services.drive_sharing_contract import LiveReviewedSource, SharingApproval
from hushh_mcp.services.drive_sharing_store import DriveSharingStore


class Candidates:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return self

    def all(self):
        return self.rows


class Connection:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, _sql, _params):
        return Candidates(self.rows)


def test_live_approval_authority_binds_file_without_plain_provider_id(monkeypatch):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"x" * 32).decode())
    store = DriveSharingStore(db=SimpleNamespace())
    document_id = uuid4()
    source = LiveReviewedSource(
        document_id=document_id,
        source_version="11",
        provider_file_binding=store.sharing_cipher.digest("live-file", "file-1"),
        connection_generation=7,
    )
    approval = SharingApproval(
        request_id=uuid4(),
        revision=1,
        owner_user_id="a",
        recipient_user_id="b",
        recipient_binding="a" * 64,
        connection_generation=7,
        sources=(source,),
    )
    assert approval.sources[0].kind == "live"
    assert "file-1" not in str(approval.authority_binding())


def test_rule_matches_only_complete_exact_repeat(monkeypatch):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"x" * 32).decode())
    store = DriveSharingStore(db=SimpleNamespace())
    request = {"user_id": "a", "recipient_user_id": "b", "recipient_binding": "a" * 64}
    purpose = {
        "purpose": "March statements",
        "periodStart": "2026-03-01",
        "periodEnd": "2026-03-31",
    }
    store._open_request = lambda _: {"purpose": purpose}
    rule_id = uuid4()
    boundary = {
        "purpose_digest": store.sharing_cipher.digest("rule-purpose", purpose),
        "files": [
            {
                "file_id": "file-1",
                "name": "March statement",
                "version": "11",
                "content_fingerprint": "a" * 64,
            }
        ],
    }
    row = {
        "rule_id": rule_id,
        "version": 1,
        "boundary_envelope": store.sharing_cipher.seal(
            boundary, user_id="a", resource_id=str(rule_id), purpose="document-rule"
        ),
    }
    source = {
        "_live": True,
        "file_id": "file-1",
        "name": "March statement",
        "source_version": "11",
        "content_fingerprint": "a" * 64,
    }
    coverage = {
        "coverage_status": "complete",
        "gaps": [],
        "truncated": False,
        "semanticStage": "completed",
    }
    assert (
        store._matching_rule(
            Connection([row]), request=request, sources=[source], coverage=coverage, generation=7
        )
        == row
    )
    # A permission metadata change can advance Drive's version without changing contents.
    assert (
        store._matching_rule(
            Connection([row]),
            request=request,
            sources=[{**source, "source_version": "12"}],
            coverage=coverage,
            generation=7,
        )
        == row
    )
    assert (
        store._matching_rule(
            Connection([row]),
            request=request,
            sources=[{**source, "content_fingerprint": "b" * 64}],
            coverage=coverage,
            generation=7,
        )
        is None
    )
    assert (
        store._matching_rule(
            Connection([row]),
            request=request,
            sources=[source],
            coverage={**coverage, "truncated": True},
            generation=7,
        )
        is None
    )
