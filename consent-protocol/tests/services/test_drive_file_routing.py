"""Content routing facts from one listing row: boundaries, freshness, read blocks."""

from datetime import UTC, datetime, timedelta

import pytest

from hushh_mcp.services import drive_file_routing as routing

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
OLD = "2026-01-02T03:04:05Z"
MB = 1_000_000
PDF = "application/pdf"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def row(mime=PDF, size=None, **changes):
    value = {
        "id": "file-1",
        "title": "Synthetic",
        "mimeType": mime,
        "modifiedTime": OLD,
        "createdTime": OLD,
        "capabilities": {"canShare": True, "canDownload": True},
        **changes,
    }
    if size is not None:
        value["size"] = size
    return value


@pytest.mark.parametrize(
    "mime,size,blind",
    [
        # Boundaries a reviewer can check: every type over 10 MB, XLSX over
        # 20 MB, PDF over 30 MB (the smaller of Google's 30/50 MB figures).
        (DOCX, 9 * MB, False),
        (DOCX, 11 * MB, True),
        ("text/plain", 10 * MB, False),
        ("text/plain", 10 * MB + 1, True),
        (XLSX, 19 * MB, False),
        (XLSX, 21 * MB, True),
        (PDF, 29 * MB, False),
        (PDF, 31 * MB, True),
        (PDF, 49 * MB, True),
        (PDF, 51 * MB, True),
    ],
)
def test_size_boundaries_follow_drives_index_caps(mime, size, blind):
    route = routing.content_route(row(mime, str(size)), now=NOW)
    assert route.size_bytes == size
    assert route.drive_blind is blind
    assert (routing.OVER_DRIVE_INDEX_SIZE in route.drive_blind_reasons) is blind
    assert route.size_class == ("over_drive_index" if blind else "within_drive_index")
    assert route.may_read_content is True


def test_projected_int_and_rest_string_sizes_agree_and_bad_sizes_are_unknown():
    as_string = routing.content_route(row(PDF, str(31 * MB)), now=NOW)
    as_int = routing.content_route(row(PDF, 31 * MB), now=NOW)
    assert as_string == as_int
    for bad in ("-1", "1e9", "12 MB", True, 1.5, "9" * 21):
        route = routing.content_route(row(PDF, bad), now=NOW)
        assert route.size_bytes is None and route.size_class == "unknown"
        assert route.drive_blind_reasons == (routing.SIZE_UNKNOWN,)


def test_google_editor_files_are_not_judged_by_storage_size():
    # Storage bytes are not text length (the critic's point); no size rule.
    route = routing.content_route(
        row("application/vnd.google-apps.document", str(200 * MB)), now=NOW
    )
    assert route.size_class == "not_applicable" and route.drive_index_cap_bytes is None
    assert route.drive_blind is False and route.may_read_content is True


@pytest.mark.parametrize(
    "field,age,recent",
    [
        ("modifiedTime", timedelta(minutes=5), True),
        ("createdTime", timedelta(hours=23, minutes=59), True),
        ("modifiedTime", timedelta(hours=25), False),
        # A clock-skewed future time is not "fresh" evidence.
        ("modifiedTime", -timedelta(hours=2), False),
    ],
)
def test_recent_uploads_are_drive_blind_until_googles_index_catches_up(field, age, recent):
    moment = (NOW - age).isoformat().replace("+00:00", "Z")
    route = routing.content_route(row(PDF, str(MB), **{field: moment}), now=NOW)
    assert (routing.RECENT_CHANGE in route.drive_blind_reasons) is recent
    assert route.drive_blind is recent


def test_images_are_routed_to_local_text_reading():
    route = routing.content_route(row("image/png", str(2 * MB)), now=NOW)
    assert route.drive_blind_reasons == (routing.IMAGE_TEXT,)


@pytest.mark.parametrize(
    "changes,block",
    [
        ({"capabilities": {"canShare": True, "canDownload": False}}, "download_restricted"),
        ({"clientEncryptionDetails": {"encryptionState": "encrypted"}}, "client_side_encrypted"),
        ({"mimeType": "application/vnd.google-apps.folder"}, "not_a_file"),
        ({"mimeType": "application/vnd.google-apps.shortcut"}, "not_a_file"),
        ({"mimeType": None}, "not_a_file"),
    ],
)
def test_files_we_may_not_read_are_never_routed_to_extraction(changes, block):
    route = routing.content_route({**row(PDF, str(40 * MB)), **changes}, now=NOW)
    assert route.read_block_reason == block and route.may_read_content is False
    assert block in routing.READ_BLOCK_REASONS


def test_unknown_can_download_is_not_treated_as_a_restriction():
    route = routing.content_route(row(PDF, str(MB), capabilities={"canShare": True}), now=NOW)
    assert route.download_allowed is None and route.may_read_content is True
    route = routing.content_route(row(PDF, str(MB), capabilities=None), now=NOW)
    assert route.may_read_content is True


def test_reasons_are_a_fixed_vocabulary_with_no_row_content():
    route = routing.content_route(
        row("image/jpeg", None, modifiedTime=NOW.isoformat(), title="PRIVATE title"), now=NOW
    )
    assert set(route.drive_blind_reasons) <= routing.DRIVE_BLIND_REASONS
    assert "PRIVATE" not in repr(route)
