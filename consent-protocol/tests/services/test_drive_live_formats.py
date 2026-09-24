"""Live-lane file formats: Google Sheets as CSV, uploaded CSV, and honest refusals.

Synthetic bytes only. No Google account, grant or credential is used.
"""

# ruff: noqa: S106 -- all bearer values below are synthetic test inputs.

from __future__ import annotations

import csv
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import google_drive_adapter as drive
from hushh_mcp.services import google_drive_permission_adapter as acl
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_document_parser import (
    MAX_CSV_CELL_CHARS,
    MAX_CSV_COLUMNS,
    MAX_CSV_ROWS,
    MAX_INPUT_BYTES,
    MAX_TEXT_BYTES,
    ParseError,
    parse_document,
    parse_live_csv,
    parse_live_document,
)
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveMetadata, DriveReadError

SHEET = "application/vnd.google-apps.spreadsheet"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
ODS = "application/vnd.oasis.opendocument.spreadsheet"
FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
GRANT = "synthetic-live-grant"


# --- parser ---------------------------------------------------------------


def test_live_csv_parser_keeps_rows_as_table_text():
    parsed = parse_live_csv(b'\xef\xbb\xbfMonth,Balance\r\nMarch,"1,204.55"\r\n')
    assert parsed.pages == ("Month | Balance\nMarch | 1,204.55",)
    assert parsed.truncated is False


def test_live_csv_parser_keeps_a_quoted_newline_inside_its_row():
    parsed = parse_live_csv(b'Note,Amount\r\n"line one\nline two",5\r\nNext,6\r\n')
    assert parsed.pages == ("Note | Amount\nline one line two | 5\nNext | 6",)
    assert parsed.truncated is False


def test_live_csv_parser_reads_devanagari_and_rupee_text():
    parsed = parse_live_csv('महीना,शेष\nमार्च,"₹1,204.55"\n'.encode())
    assert parsed.pages == ("महीना | शेष\nमार्च | ₹1,204.55",)
    assert parsed.truncated is False


def test_formula_looking_cells_stay_plain_text():
    # As Sheets exports it: the quoted formula text, never an evaluated value.
    source = '"=HYPERLINK(""https://example.invalid"",""open"")",+1,-2,@SUM(A1:A2)\n'
    parsed = parse_live_csv(source.encode())
    assert parsed.pages == ('=HYPERLINK("https://example.invalid","open") | +1 | -2 | @SUM(A1:A2)',)


def test_live_csv_parser_bounds_rows_columns_and_cells():
    rows = parse_live_csv(("n\n" * (MAX_CSV_ROWS + 1)).encode())
    assert rows.pages[0].count("\n") + 1 == MAX_CSV_ROWS
    assert rows.truncated is True

    wide = parse_live_csv(",".join(f"c{n}" for n in range(MAX_CSV_COLUMNS + 1)).encode())
    assert wide.pages[0].split(" | ") == [f"c{n}" for n in range(MAX_CSV_COLUMNS)]
    assert wide.truncated is True

    long_cell = parse_live_csv(b"a," + b"x" * 5000)
    assert long_cell.pages == ("a | " + "x" * MAX_CSV_CELL_CHARS,)
    assert long_cell.truncated is True


def test_a_huge_row_is_bounded_not_expanded():
    row = ",".join(["y" * 60] * 20_000).encode()
    assert len(row) < MAX_INPUT_BYTES
    parsed = parse_live_csv(row)
    assert parsed.pages == (" | ".join(["y" * 60] * MAX_CSV_COLUMNS),)
    assert parsed.truncated is True


def test_many_long_rows_stop_at_the_text_budget():
    line = ",".join(["z" * 900] * 4) + "\n"
    parsed = parse_live_csv((line * 1000).encode())
    assert len(parsed.pages[0].encode()) <= MAX_TEXT_BYTES
    assert parsed.truncated is True


def test_sheet_padding_columns_are_not_a_cut():
    # Sheets pads short rows with empty trailing cells up to the sheet width.
    padded = "a,b" + "," * (MAX_CSV_COLUMNS + 10) + "\n1,2" + "," * (MAX_CSV_COLUMNS + 10)
    parsed = parse_live_csv(padded.encode())
    assert parsed.pages == ("a | b\n1 | 2",)
    assert parsed.truncated is False


@pytest.mark.parametrize(
    "content,code",
    [
        (b"", "no_extractable_text"),
        (b" \r\n , \n\t", "no_extractable_text"),
        (b"a," + b"\xff\xfe\xfa", "invalid_document"),
        (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "invalid_document"),
        (b"a,b\nc,\x00d\n", "invalid_document"),
        (b'a,"b\n', "invalid_document"),
        (b"a," + b"q" * (200 * 1024), "invalid_document"),
        (b"a" * (MAX_INPUT_BYTES + 1), "file_too_large"),
    ],
)
def test_live_csv_parser_fails_closed(content, code):
    limit = csv.field_size_limit()
    with pytest.raises(ParseError, match=code):
        parse_live_csv(content)
    assert csv.field_size_limit() == limit


def test_selected_parser_still_refuses_csv():
    with pytest.raises(ParseError, match="unsupported_format"):
        parse_document(b"a,b", "text/csv")


def test_live_parse_adds_only_csv_to_the_selected_parser():
    assert parse_live_document(b"a,b\n", "text/csv").pages == ("a | b",)
    assert parse_live_document(b"plain words", "text/plain").pages == ("plain words",)
    for mime in (XLSX, ODS, PPTX, "text/comma-separated-values", "application/vnd.ms-excel"):
        with pytest.raises(ParseError, match="unsupported_format"):
            parse_live_document(b"PK\x03\x04", mime)


# --- adapter --------------------------------------------------------------


def metadata(**changes):
    return {
        "id": "selected-file",
        "name": "Synthetic sheet",
        "mimeType": "text/plain",
        "version": "1",
        "modifiedTime": "2026-09-22T00:00:00Z",
        "size": "14",
        "trashed": False,
        "isAppAuthorized": True,
        "capabilities": {"canDownload": True, "canAccessViaGenAi": True},
        **changes,
    }


async def test_live_read_exports_google_sheets_as_csv():
    adapter = drive.GoogleDriveAdapter()
    adapter._get = AsyncMock(return_value=b"Month,Balance\n")
    result = await adapter.read_live_bytes(
        file_id="selected-file", mime_type=SHEET, access_token="synthetic-token"
    )
    assert result == ("text/csv", b"Month,Balance\n")
    adapter._get.assert_awaited_once_with(
        "/files/selected-file/export",
        access_token="synthetic-token",
        params={"mimeType": "text/csv"},
        limit=drive.CONTENT_LIMIT,
    )


async def test_an_uploaded_csv_downloads_as_media():
    adapter = drive.GoogleDriveAdapter()
    adapter._get = AsyncMock(return_value=b"a,b\n")
    result = await adapter.read_live_bytes(
        file_id="selected-file", mime_type="text/csv", access_token="synthetic-token"
    )
    assert result == ("text/csv", b"a,b\n")
    assert adapter._get.await_args.args == ("/files/selected-file",)
    assert adapter._get.await_args.kwargs["params"] == {"alt": "media", "supportsAllDrives": "true"}


async def test_live_metadata_accepts_uploaded_csv_but_selected_does_not():
    adapter = drive.GoogleDriveAdapter()
    adapter._get = AsyncMock(return_value=json.dumps(metadata(mimeType="text/csv")).encode())
    observed = await adapter.get_metadata(
        file_id="selected-file",
        access_token="synthetic-token",
        require_app_authorized=False,
        require_genai_eligibility=False,
    )
    assert observed.mime_type == "text/csv"
    with pytest.raises(DriveReadError, match="unsupported_format"):
        await adapter.get_metadata(file_id="selected-file", access_token="synthetic-token")


@pytest.mark.parametrize("mime", ["text/comma-separated-values", "application/vnd.ms-excel"])
async def test_other_csv_labels_stay_unsupported_with_a_reason(mime):
    adapter = drive.GoogleDriveAdapter()
    adapter._get = AsyncMock(return_value=json.dumps(metadata(mimeType=mime)).encode())
    with pytest.raises(DriveReadError, match="unsupported_format"):
        await adapter.get_metadata(
            file_id="selected-file",
            access_token="synthetic-token",
            require_app_authorized=False,
            require_genai_eligibility=False,
        )


async def test_csv_export_is_the_only_new_export_shape(monkeypatch):
    assert SHEET not in drive.EXPORTS
    assert drive.SUPPORTED_TYPES == frozenset(drive.EXPORTS) | drive.BINARY_TYPES
    monkeypatch.setattr(
        drive.httpx, "AsyncClient", lambda **_: (_ for _ in ()).throw(RuntimeError("admitted"))
    )
    with pytest.raises(RuntimeError, match="admitted"):
        await drive.GoogleDriveAdapter()._get_private(
            "/files/a/export",
            access_token="synthetic-token",
            params={"mimeType": "text/csv"},
            limit=drive.CONTENT_LIMIT,
        )
    for params in ({"mimeType": "text/html"}, {"mimeType": "text/csv", "alt": "media"}):
        with pytest.raises(DriveReadError, match="operation_not_allowed"):
            await drive.GoogleDriveAdapter()._get_private(
                "/files/a/export",
                access_token="synthetic-token",
                params=params,
                limit=drive.CONTENT_LIMIT,
            )


async def test_selected_fetch_still_refuses_a_google_sheet():
    adapter = drive.GoogleDriveAdapter()
    adapter._get = AsyncMock(return_value=json.dumps(metadata(mimeType=SHEET, size=None)).encode())
    with pytest.raises(DriveReadError, match="unsupported_format"):
        await adapter.fetch_content(file_id="selected-file", access_token="synthetic-token")
    assert adapter._get.await_count == 1


# --- permission adapter ---------------------------------------------------


async def test_a_live_csv_is_shareable_but_not_in_the_selected_lane():
    adapter = acl.GoogleDrivePermissionAdapter()
    adapter._exchange = AsyncMock(
        return_value={
            "id": "synthetic-file",
            "version": "1",
            "trashed": False,
            "isAppAuthorized": True,
            "mimeType": "text/csv",
            "capabilities": {"canShare": True, "canDownload": True, "canAccessViaGenAi": True},
        }
    )
    arguments = {
        "file_id": "synthetic-file",
        "access_token": "synthetic-token",
        "require_current": AsyncMock(),
        "expected_version": "1",
    }
    await adapter.inspect_shareable(
        **arguments, require_app_authorized=False, require_genai_eligibility=False
    )
    with pytest.raises(acl.DrivePermissionError, match="source_not_shareable"):
        await adapter.inspect_shareable(**arguments)


# --- REST transport -------------------------------------------------------


def row(**changes):
    return {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": 7,
        **changes,
    }


def transport(monkeypatch, adapter):
    monkeypatch.setattr(rest, "connector_feature_enabled", lambda *_: True)
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(row(), {"accessToken": GRANT})),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=row())),
    )
    return rest.GoogleDriveRestTransport(oauth=oauth, adapter=adapter)


def meta(mime, name="Budget"):
    return DriveMetadata(FILE_ID, name, mime, "3", "2026-09-20T00:00:00Z", None, None)


async def test_a_google_sheet_reads_as_table_text(monkeypatch):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(return_value=meta(SHEET)),
        read_live_bytes=AsyncMock(return_value=("text/csv", b"Month,Balance\nMarch,10\n")),
    )
    result = await transport(monkeypatch, adapter).read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == {"fileContent": "Month | Balance\nMarch | 10"}


async def test_a_google_sheet_read_asks_drive_for_one_csv_export(monkeypatch):
    adapter = drive.GoogleDriveAdapter()
    info = json.dumps(
        metadata(id=FILE_ID, mimeType=SHEET, size=None, isAppAuthorized=False)
    ).encode()
    adapter._get = AsyncMock(side_effect=[info, b"Month,Balance\r\nMarch,10\r\n"])
    result = await transport(monkeypatch, adapter).read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload == {"fileContent": "Month | Balance\nMarch | 10"}
    export = adapter._get.await_args_list[1]
    assert export.args == (f"/files/{FILE_ID}/export",)
    assert export.kwargs["params"] == {"mimeType": "text/csv"}


@pytest.mark.parametrize("mime", [XLSX, ODS, PPTX])
async def test_office_files_are_refused_as_unsupported_format(monkeypatch, mime):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(return_value=meta(mime)),
        read_live_bytes=AsyncMock(return_value=(mime, b"PK\x03\x04synthetic")),
    )
    result = await transport(monkeypatch, adapter).read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload["textFormattingNotSupported"] is True
    assert "fileContent" not in result.payload
    # The live reader turns the refusal into an explicit reason code, not a blank.
    with pytest.raises(DriveReadError) as caught:
        DriveLiveReader._content(result)
    assert str(caught.value) == "unsupported_format"


async def test_a_damaged_csv_releases_no_text(monkeypatch):
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(return_value=meta("text/csv")),
        read_live_bytes=AsyncMock(return_value=("text/csv", b"a,\xff\xfe\n")),
    )
    result = await transport(monkeypatch, adapter).read_tool(
        user_id="owner", tool_name="read_file_content", arguments={"fileId": FILE_ID}
    )
    assert result.payload["textFormattingNotSupported"] is True
    assert "fileContent" not in result.payload


# --- live reader ----------------------------------------------------------


def reader_for(mime):
    oauth = SimpleNamespace(
        current_credential=AsyncMock(return_value=(row(), {"accessToken": "synthetic"}))
    )
    adapter = SimpleNamespace(get_metadata=AsyncMock(return_value=meta(mime, "Budget")))
    mcp = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=ExternalMcpToolResult(False, {"fileContent": "Month | Balance"}, False)
        )
    )
    return DriveLiveReader(
        user_id="owner", require_access=AsyncMock(), oauth=oauth, mcp=mcp, adapter=adapter
    )


async def test_a_google_sheet_read_is_marked_partial():
    # The CSV export holds the first sheet only, so a Sheet is never complete.
    result = await reader_for(SHEET).read_matches(matches=[{"file_id": FILE_ID, "name": "Budget"}])
    assert [item["text"] for item in result["untrusted_external_content"]] == ["Month | Balance"]
    assert result["truncated"] is True


async def test_an_uploaded_csv_read_is_not_marked_partial():
    result = await reader_for("text/csv").read_matches(
        matches=[{"file_id": FILE_ID, "name": "Budget"}]
    )
    assert [item["text"] for item in result["untrusted_external_content"]] == ["Month | Balance"]
    assert result["truncated"] is False
