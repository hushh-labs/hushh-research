"""Career Agent resume parsing: a private, stateless draft for the owner.

Pins the boundaries: off unless the flag is on; only PDF/DOCX up to 4 MB; the
model receives extracted text, never the file; unreadable files get a clear
message; and the route keeps nothing.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import career
from hushh_mcp.services.drive_document_parser import ParsedText
from hushh_mcp.services.google_drive_adapter import DriveReadError

PDF = "application/pdf"


class _Parser:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    async def parse(self, *, content, mime_type):
        self.calls.append((len(content), mime_type))
        if self.error:
            raise DriveReadError(self.error)
        return self.result


@pytest.fixture
def setup(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import owner_placement_guard as guard

    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    monkeypatch.setenv("ONE_CAREER_ENABLED", "true")
    parser = _Parser(
        result=ParsedText(pages=("Ada Lovelace", "Analyst, Engine Co, 1843"), truncated=False)
    )
    seen: dict = {}

    async def extract(*, text, user_id, consent_token):
        seen.update(text=text, user_id=user_id)
        return {
            "name": "Ada Lovelace",
            "experience": [],
            "education": [],
            "skills": ["math"],
            "links": [],
        }

    monkeypatch.setattr(career, "_parser", lambda: parser)
    monkeypatch.setattr(career, "_extract", extract)
    app = FastAPI()
    app.include_router(career.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1", "token": "vt"}
    return TestClient(app), parser, seen


def _post(client, data=b"%PDF-1.7 ...", mime=PDF):
    return client.post("/api/one/career/resume/parse", files={"file": ("cv.pdf", data, mime)})


def test_off_unless_flag(setup, monkeypatch):
    client, _, _ = setup
    monkeypatch.setenv("ONE_CAREER_ENABLED", "false")
    assert _post(client).status_code == 404


def test_returns_structured_resume_from_text_only(setup):
    client, parser, seen = setup
    res = _post(client)
    assert res.status_code == 200
    assert res.json()["resume"]["name"] == "Ada Lovelace"
    assert res.headers["cache-control"] == "private, no-store"
    assert (
        seen["text"] == "Ada Lovelace\nAnalyst, Engine Co, 1843"
    )  # the model gets text, not bytes
    assert parser.calls == [(len(b"%PDF-1.7 ..."), PDF)]


def test_rejects_other_types_and_large_files(setup):
    client, parser, _ = setup
    assert _post(client, mime="image/png").status_code == 415
    assert _post(client, data=b"x" * (4 * 1024 * 1024 + 1)).status_code == 413
    assert parser.calls == []


def test_unreadable_file_explains_why(setup):
    client, parser, _ = setup
    parser.error = "encrypted_document"
    res = _post(client)
    assert res.status_code == 422
    assert "password-protected" in res.json()["detail"]["message"]
