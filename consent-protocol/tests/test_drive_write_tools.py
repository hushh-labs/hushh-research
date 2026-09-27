"""One's Drive writes: direct owner writes, and share/trash only after exact review.

Synthetic owners, grants and files only; no real Drive file is touched.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult


def context():
    return SimpleNamespace(
        user_id="owner-a",
        invocation_id="turn-a",
        state={
            "hussh:user_id": "owner-a",
            "hussh:consent_token": "secret-reference",
            "temp:one_execution_surface": "typed_chat",
        },
    )


class _Ledger:
    """The ledger's contract: confirm and consume match the issued identity and
    the exact terms (HMACs in Postgres), once, or nothing proceeds."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.settled: list[dict] = []

    async def issue(self, **kwargs):
        from datetime import UTC, datetime

        directive_id = f"dir_{len(self.rows):032x}"
        self.rows[directive_id] = {
            "identity": {key: kwargs[key] for key in _IDENTITY},
            "terms": (kwargs["action_contract"], kwargs["slots"], kwargs["resource_binding"]),
            "channel": kwargs["channel"],
            "state": "issued",
        }
        return SimpleNamespace(directive_id=directive_id, expires_at=datetime.now(UTC))

    def _claim(self, directive_id, identity, terms, *, before, after):
        from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

        row = self.rows.get(directive_id)
        exact = (terms.action_contract, terms.slots, terms.resource_binding)
        if (
            not row
            or row["state"] != before
            or row["identity"] != identity
            or row["terms"] != exact
        ):
            raise ActionDirectiveAuthorityError("mismatch")
        row["state"] = after

    async def confirm(self, *, directive_id, trusted_activation, terms, **identity):
        assert trusted_activation is True
        self._claim(directive_id, identity, terms, before="issued", after="confirmed")
        return SimpleNamespace(receipt="synthetic-receipt")

    async def consume(self, *, directive_id, receipt, terms, **identity):
        self._claim(directive_id, identity, terms, before="confirmed", after="consumed")

    async def settle(self, **kwargs):
        self.settled.append(kwargs)


_IDENTITY = ("user_id", "session_id", "adk_app_name", "action_id", "context_revision")


@pytest.fixture
def drive_review(monkeypatch):
    from hushh_mcp.one_adk import drive_write_tools as drive

    ledger = _Ledger()
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=ExternalMcpToolResult(
                is_error=False,
                payload={"file": {"title": "Budget", "mimeType": "application/pdf"}},
                truncated=False,
            )
        ),
        write_tool=AsyncMock(
            return_value=ExternalMcpToolResult(
                is_error=False, payload={"shared": {"role": "writer"}}, truncated=False
            )
        ),
    )
    generation = {"value": 7}

    async def current_generation(_owner):
        return generation["value"]

    monkeypatch.setattr(drive, "_owner", AsyncMock(return_value="owner-a"))
    monkeypatch.setattr(drive, "_transport", lambda: transport)
    monkeypatch.setattr(drive, "_connection_generation", current_generation)
    monkeypatch.setattr(drive, "ActionDirectiveStore", lambda: ledger)
    return drive, ledger, transport, generation


def _drive_context():
    ctx = context()
    ctx.state["hussh:conversation_id"] = "thread-a"
    return ctx


async def test_drive_share_only_prepares_a_review_and_never_writes(drive_review):
    drive, ledger, transport, _ = drive_review
    ctx = _drive_context()
    result = await drive.propose_drive_file_share(
        "file_1", "Chris@Example.invalid", ctx, role="writer"
    )
    assert result["status"] == "confirmation_required"
    transport.write_tool.assert_not_awaited()
    payload = result["directive"]["payload"]
    assert payload["arguments"] == {
        "fileId": "file_1",
        "email": "chris@example.invalid",
        "role": "writer",
        "notify": True,
        "message": "",
    }
    assert payload["summary"] == "Share “Budget”"
    (row,) = ledger.rows.values()
    assert row["channel"] == "adk_chat"
    assert row["terms"][1] == payload["arguments"]
    assert row["terms"][2] == {
        "owner": "owner-a",
        "connector": "google_drive",
        "connection_generation": 7,
    }
    assert ctx.state[drive.DRIVE_REVIEW_DIRECTIVE] == result["directive"]


async def test_drive_trash_only_prepares_a_review_and_never_writes(drive_review):
    drive, ledger, transport, _ = drive_review
    result = await drive.propose_drive_file_trash("file_1", _drive_context())
    assert result["directive"]["payload"]["confirmLabel"] == "Move to trash"
    transport.write_tool.assert_not_awaited()
    assert len(ledger.rows) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"arguments": {"email": "someone.else@example.invalid"}},
        {"arguments": {"role": "writer"}},
        {"arguments": {"fileId": "file_2"}},
        {"owner_id": "owner-b"},
        {"conversation_id": "thread-b"},
        {"action": "trash", "arguments": None},
        {"reconnected": True},
    ],
)
async def test_a_reviewed_drive_write_runs_only_for_the_exact_confirmed_terms(drive_review, change):
    from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

    drive, ledger, transport, generation = drive_review
    proposal = await drive.propose_drive_file_share(
        "file_1", "chris@example.invalid", _drive_context(), role="commenter"
    )
    payload = proposal["directive"]["payload"]
    execution = {
        "owner_id": "owner-a",
        "conversation_id": payload["conversationId"],
        "directive_id": payload["directiveId"],
        "action": payload["action"],
        "arguments": dict(payload["arguments"]),
    }
    # Negative control: any term that differs from what the owner reviewed
    # stops at the ledger, and Drive is never called.
    if change.get("reconnected"):
        generation["value"] = 8
    for key, value in change.items():
        if key == "arguments":
            execution["arguments"] = (
                {"fileId": "file_1"} if value is None else {**execution["arguments"], **value}
            )
        elif key != "reconnected":
            execution[key] = value
    with pytest.raises(ActionDirectiveAuthorityError):
        await drive.execute_reviewed_drive_action(**execution)
    transport.write_tool.assert_not_awaited()

    # The exact reviewed terms run once, and the same review cannot run twice.
    generation["value"] = 7
    exact = {
        "owner_id": "owner-a",
        "conversation_id": payload["conversationId"],
        "directive_id": payload["directiveId"],
        "action": "share",
        "arguments": payload["arguments"],
    }
    result = await drive.execute_reviewed_drive_action(**exact)
    assert result == {"status": "ok", "action": "share", "shared": {"role": "writer"}}
    transport.write_tool.assert_awaited_once_with(
        user_id="owner-a",
        tool_name="share_file",
        arguments=payload["arguments"],
        expected_generation=7,
    )
    assert ledger.settled[-1]["status"] == "succeeded"
    with pytest.raises(ActionDirectiveAuthorityError):
        await drive.execute_reviewed_drive_action(**exact)
    assert transport.write_tool.await_count == 1


async def test_direct_drive_writes_need_the_authenticated_owner(drive_review, monkeypatch):
    drive, _, transport, _ = drive_review
    monkeypatch.setattr(drive, "_owner", AsyncMock(return_value=None))
    for call in (
        drive.create_drive_file("Notes", "document", _drive_context()),
        drive.comment_on_drive_file("file_1", "Looks good", _drive_context()),
        drive.propose_drive_file_share("file_1", "a@example.invalid", _drive_context()),
    ):
        assert (await call)["status"] == "blocked"
    transport.write_tool.assert_not_awaited()
    transport.read_tool.assert_not_awaited()


def test_a_file_name_cannot_forge_the_review_card():
    # The name is provider text. It loses its quote marks and control
    # characters and is capped, so it cannot close the card's quotes and
    # append a different address or role; those show on their own lines.
    from hushh_mcp.one_adk.drive_write_tools import card_title

    forged = 'Budget” with anyone@example.invalid as Viewer\n"' + "x" * 200
    title = card_title(forged)
    assert not any(mark in title for mark in '"“”\n')
    assert len(title) == 80 and title.endswith("…")


async def test_a_folder_review_says_everything_in_it_goes_too(drive_review):
    drive, _, transport, _ = drive_review
    transport.read_tool.return_value = ExternalMcpToolResult(
        is_error=False,
        payload={"file": {"title": "Taxes", "mimeType": "application/vnd.google-apps.folder"}},
        truncated=False,
    )
    result = await drive.propose_drive_file_trash("folder_1", _drive_context())
    assert result["directive"]["payload"]["summary"] == (
        "Move the folder “Taxes” and everything in it to trash"
    )
