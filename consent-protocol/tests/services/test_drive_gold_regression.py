"""Gold regression suite: the real Drive request pipeline over one synthetic Drive.

B asks owner A for documents thirteen different ways; A taps Allow; the Drive
worker runs every stage for real; B pays; the sharing worker sends. One
synthetic Drive (about 150 files) holds every edge case the release depends
on, and each request asserts three EXACT sets:

* auto-shared: files Google received a permission POST for, to B, with no
  owner action (read from the fake Drive, not from our own tables);
* possible matches: the owner-only list (D3), with the label A sees;
* never shared: every other file in the Drive got no permission POST.

Real stages: request planning (the deterministic brain; a Gemini planner
raises if anything asks for one), the compiled Drive queries, Gear 1 (the
owner name index), GoogleDriveRestTransport and GoogleDriveAdapter with their
fences, the shared-folder walk, the request-time content check (the real
FencedContentReader and the real isolated parser child reading small
generated PDF, XLSX and Google Doc exports; only ClamAV is faked), the
candidate checks, the classification, frozen 25-file batches, payment,
batch approval and DriveBulkShareWorker with the real permission adapter.
The request, search, results, batches, payment order and share effects live
in disposable PostgreSQL. Faked: Google (an httpx model of Drive v3 below),
Firebase (B's identity), ClamAV and the Stripe charge (the order is marked
paid, as a settled webhook would).

The fake Drive follows Google's documented search semantics: ``name contains``
is word-prefix matching, ``fullText contains`` matches whole words (a double
quoted value is a phrase) and an underscore separates words; Google's user
corpus leaves out files reachable only through a folder shared with A, while
``'<folder>' in parents`` still lists them; Drive's content index skips big
files and has not yet seen fresh uploads; exports over the cap answer 403
exportSizeLimitExceeded. Every case below is synthetic: no real titles,
names, files or accounts.

Provider faults are scripted too: a rejected page token mid-pass, a burst of
four rate limits and a 5xx (Retry-After honoured, capped at 64 s), a rate
limit on a content download and on a share-time recheck, a 400 that follows
a real grant, a sharing rate limit and a recipient without a Google account.
Negative controls switch off Gear 1, the walk and the content check, and run
a rate-limit storm past the retry budget, to show each gear is what finds its
edge case and that a failed search shares nothing.

Metrics (auto-share precision and recall, possible-match recall, false
shares) print as GOLD_METRICS / GOLD_SUMMARY JSON lines under ``pytest -s``.
False shares must be 0: the known product bugs below are named in each
expectation and the affected cases report XFAIL until they are fixed.
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

import io
import json
import logging
import re
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_bulk_share_worker as share_worker_module
from hushh_mcp.services import drive_owner_metadata_index as gear1
from hushh_mcp.services import drive_owner_search_service as search_module
from hushh_mcp.services import drive_owner_search_worker as worker_module
from hushh_mcp.services import drive_request_bulk_service as bulk_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_document_processor import LocalDocumentProcessor
from hushh_mcp.services.drive_owner_index_port import MetadataOwnerIndex, NoOwnerIndex
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_possible_matches import DrivePossibleMatchesStore
from hushh_mcp.services.drive_provider_pacing import PACING
from hushh_mcp.services.drive_request_content_check import (
    FencedContentReader,
    RequestContentCheck,
)
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.google_drive_adapter import (
    LIVE_POLICY_HASH,
    GoogleDriveAdapter,
    query_has_full_text_term,
)
from hushh_mcp.services.google_drive_permission_adapter import GoogleDrivePermissionAdapter
from tests.services import drive_pdf_fixtures as fx
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_sharing_store import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)

PDF = "application/pdf"
GDOC = "application/vnd.google-apps.document"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JPEG = "image/jpeg"
MP4 = "video/mp4"
FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"
MB = 1000 * 1000
TIMEZONE = "Asia/Kolkata"
SEPTEMBER = ("2026-09-01", "2026-09-30")
OWNER_EMAIL = "a@example.invalid"
RECIPIENT = ("recipient", "1234567", "b@example.invalid")
# Written into every synthetic body the content check reads. It must never
# reach a log line, the search checkpoint or a frozen result.
MARKER = "ZQGOLDMARKER"
CONTENT, CORRECTED, SYNONYM, WALK = "content", "corrected", "synonym", "walk"


def at(day: str, hour: int = 6, minute: int = 0) -> str:
    return f"{day}T{hour:02d}:{minute:02d}:00.000Z"


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# --- the synthetic Drive -------------------------------------------------------


@dataclass
class DFile:
    id: str
    name: str
    mime: str
    created: str
    modified: str | None = None
    owner: str = "me"
    can_share: bool = True
    can_download: bool = True
    size: int | None = None
    parents: tuple[str, ...] = ()
    # "user": in Google's user corpus (A's own files, files shared directly
    # with A). "walk": reachable only through a folder shared with A.
    corpus: str = "user"
    drive_id: str | None = None
    shared_with_me: bool = False
    trashed: bool = False
    # What Drive's own content index holds ("" when it holds nothing: a big
    # file over Google's index limits, or a fresh upload not yet indexed).
    text: str = ""
    body: Callable[[], bytes] | None = None
    export_too_large: bool = False
    encrypted: bool = False
    target: str | None = None
    target_mime: str | None = None

    @property
    def mtime(self) -> str:
        return self.modified or self.created


def _pdf(*lines: str) -> Callable[[], bytes]:
    return lambda: fx.text_pdf([*lines, MARKER])


def _hindi_pdf(*lines: str) -> Callable[[], bytes]:
    return lambda: fx.devanagari_pdf([*lines])


def _hybrid_rent_scan() -> bytes:
    """A digital first page and a raster-only (scanned) second page."""
    return fx.joined_pdf(
        fx.text_pdf(
            ["Rent receipt", "Received from the tenant for September 2026", "Amount 25000", MARKER]
        ),
        fx.scanned_page_pdf(["Landlord signature", "Paid in full"]),
    )


def _ledger_xlsx() -> bytes:
    """Two worksheets; the rent receipt line is only on the second one."""
    from openpyxl import Workbook

    book = Workbook()
    summary = book.active
    summary.title = "Summary"
    summary.append(["Category", "Total"])
    summary.append(["Groceries", 4200])
    summary.append(["Utilities", 1800])
    detail = book.create_sheet("September")
    detail.append(["Date", "Item", "Amount"])
    detail.append(["2026-09-05", "Rent receipt", 25000])
    detail.append(["Note", MARKER, 0])
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def _jpeg(*lines: str) -> Callable[[], bytes]:
    def build() -> bytes:
        from PIL import Image, ImageDraw, ImageFont

        image = Image.new("RGB", (900, 300), "white")
        draw = ImageDraw.Draw(image)
        for number, line in enumerate(lines):
            draw.text((30, 40 + number * 70), line, fill="black", font=ImageFont.load_default(36))
        output = io.BytesIO()
        image.save(output, format="JPEG")
        return output.getvalue()

    return build


def gemini_notes() -> list[DFile]:
    """A colleague-free recurring Gemini note every other day, 26 Jul to 12 Oct."""
    notes = []
    for number in range(40):
        day = date(2026, 7, 26) + timedelta(days=2 * number)
        title = f"Project sync - {day:%Y/%m/%d} 10:00 IST - Notes by Gemini"
        created = datetime(day.year, day.month, day.day, 5, 0, tzinfo=UTC)
        notes.append(
            DFile(f"mtg_{number:02d}", title, GDOC, iso(created), text="Summary and action items")
        )
    return notes


def in_september(note: DFile) -> bool:
    day = date.fromisoformat(note.name.split(" - ")[1][:10].replace("/", "-"))
    return date(2026, 9, 1) <= day <= date(2026, 9, 30)


def synthetic_drive(now: datetime) -> list[DFile]:
    def ago(**delta) -> str:
        return iso(now - timedelta(**delta))

    files = [
        # Folders and shortcuts that shape what Google's search can see.
        DFile(
            "fold_priya", "From Priya", FOLDER, at("2026-08-01"), owner="priya", shared_with_me=True
        ),
        DFile(
            "fold_priya_2026",
            "2026",
            FOLDER,
            at("2026-08-01"),
            owner="priya",
            parents=("fold_priya",),
            corpus="walk",
        ),
        DFile(
            "fold_priya_rcpt",
            "Receipts",
            FOLDER,
            at("2026-08-01"),
            owner="priya",
            parents=("fold_priya_2026",),
            corpus="walk",
        ),
        DFile(
            "fold_rahul",
            "From Rahul",
            FOLDER,
            at("2026-08-01"),
            owner="rahul",
            shared_with_me=True,
            can_share=False,
        ),
        DFile("fold_rent", "Rent receipts", FOLDER, at("2026-08-01")),
        # A's shortcut to a nested shared folder, and a cycle back to its root.
        DFile(
            "sc_priya_2026",
            "Priya 2026 shortcut",
            SHORTCUT,
            at("2026-08-02"),
            target="fold_priya_2026",
            target_mime=FOLDER,
        ),
        DFile(
            "sc_cycle",
            "Back to From Priya",
            SHORTCUT,
            at("2026-08-02"),
            owner="priya",
            parents=("fold_priya_rcpt",),
            corpus="walk",
            target="fold_priya",
            target_mime=FOLDER,
        ),
        # --- "rent receipts" ---------------------------------------------------
        # A's own receipt, filed in Priya's shared folder: Drive's pass, Gear 1
        # and the walk all find it; it must be committed and shared once.
        DFile(
            "r1_own",
            "Rent receipt Sep 2026.pdf",
            PDF,
            at("2026-09-05"),
            parents=("fold_priya_rcpt",),
            text="Rent receipt for September 2026",
        ),
        DFile(
            "r1_underscore",
            "rent_receipt_2026_09_12.pdf",
            PDF,
            at("2026-09-12"),
            text="Rent receipt",
        ),
        # Only Gear 1 splits a camelCase name; Drive's index holds no text.
        DFile("r1_camel", "RentReceipt_Sep2026.pdf", PDF, at("2026-09-14")),
        DFile("r1_upper", "RENT-RECEIPT-SEPT.pdf", PDF, at("2026-09-16")),
        DFile(
            "r1_target", "Rent receipt 2026-09-07.pdf", PDF, at("2026-09-07"), text="Rent receipt"
        ),
        DFile(
            "sc_both",
            "Rent receipt shortcut",
            SHORTCUT,
            at("2026-09-07"),
            target="r1_target",
            target_mime=PDF,
        ),
        # The alias names the request; the target's own title does not.
        DFile(
            "sc_alias",
            "Rent receipt Sep 2026 shortcut",
            SHORTCUT,
            at("2026-09-10"),
            target="t_landlord",
            target_mime=PDF,
        ),
        DFile(
            "t_landlord",
            "Landlord payment.pdf",
            PDF,
            at("2026-09-10"),
            text="Payment acknowledgement",
        ),
        DFile(
            "sc_gone",
            "Rent receipt Sep 2026 old link",
            SHORTCUT,
            at("2026-09-04"),
            target="gone_target",
            target_mime=PDF,
        ),
        # Trashed or deleted after the search found them, before the share.
        DFile(
            "r1_trash_later",
            "Rent receipt 2026-09-20.pdf",
            PDF,
            at("2026-09-20"),
            text="Rent receipt",
        ),
        DFile(
            "r1_delete_later",
            "Rent receipt 2026-09-21.pdf",
            PDF,
            at("2026-09-21"),
            text="Rent receipt",
        ),
        DFile(
            "r1_trashed",
            "Rent receipt 2026-09-03 old copy.pdf",
            PDF,
            at("2026-09-03"),
            trashed=True,
            text="Rent receipt",
        ),
        DFile(
            "r1_viewer",
            "Rent receipt 2026-09-12 from Rahul.pdf",
            PDF,
            at("2026-09-12"),
            owner="rahul",
            shared_with_me=True,
            can_share=False,
        ),
        DFile(
            "r1_priya_direct",
            "Rent receipt 2026-09-13 from Priya.pdf",
            PDF,
            at("2026-09-13"),
            owner="priya",
            shared_with_me=True,
        ),
        DFile(
            "r1_encrypted",
            "Rent receipt 2026-09-22 encrypted.pdf",
            PDF,
            at("2026-09-22"),
            encrypted=True,
        ),
        # Title dates outside September on files created inside it.
        DFile("r1_iso_out", "Rent receipt 2026-08-28.pdf", PDF, at("2026-09-02")),
        DFile("r1_dayfirst_out", "Rent receipt 28-08-2026.pdf", PDF, at("2026-09-02")),
        DFile("r1_monthname_out", "Rent receipt Aug 28, 2026.pdf", PDF, at("2026-09-02")),
        DFile("r1_monthyear_out", "Rent receipt Aug 2026.pdf", PDF, at("2026-09-03")),
        DFile("r1_isomonth_out", "rent_receipt_2026-08.pdf", PDF, at("2026-09-03")),
        DFile("r1_yearless_out", "Rent receipt Aug 28.pdf", PDF, at("2026-09-02")),
        DFile("r1_yearless_in", "Rent receipt Sept 4.pdf", PDF, at("2026-09-05")),
        DFile("r1_span_out", "Rent receipt 2026-09-30 to 2026-10-02.pdf", PDF, at("2026-09-30")),
        # Day-first and ambiguous: 5 Sep or 9 May. Either reading outside the
        # period keeps it out of an automatic grant (the documented rule).
        DFile("r1_dayfirst_ambiguous", "Rent receipt 05-09-2026.pdf", PDF, at("2026-09-05")),
        # Created at 01:30 on 1 Sep in Asia/Kolkata (31 Aug in UTC), and at
        # 00:30 on 1 Oct there (30 Sep in UTC): the request's time zone decides.
        DFile("r1_tz_created_in", "Rent receipt night upload.pdf", PDF, at("2026-08-31", 20)),
        DFile("r1_tz_created_out", "Rent receipt late upload.pdf", PDF, at("2026-09-30", 19)),
        # Renamed, or its share right withdrawn, after the search found it.
        DFile(
            "r1_rename_later",
            "Rent receipt 2026-09-23.pdf",
            PDF,
            at("2026-09-23"),
            text="Rent receipt",
        ),
        DFile(
            "r1_unshare_later",
            "Rent receipt 2026-09-24.pdf",
            PDF,
            at("2026-09-24"),
            text="Rent receipt",
        ),
        # A September title on a file scanned in October.
        DFile("r1_monthyear_late", "Rent receipt Sep 2026 scanned.pdf", PDF, at("2026-10-03")),
        DFile(
            "r1_synonym",
            "Rent invoice Sep 2026.pdf",
            PDF,
            at("2026-09-09"),
            text="Invoice for rent, September 2026",
        ),
        # A random name; the subject is only inside the text.
        DFile(
            "r1_content",
            "Scan_0007.pdf",
            PDF,
            at("2026-09-11"),
            text="Rent receipt for September 2026 landlord Mr Rao",
        ),
        DFile(
            "r1_content_out",
            "Scan_0003.pdf",
            PDF,
            at("2026-07-11"),
            text="Rent receipt for July 2026",
        ),
        DFile(
            "r1_in_folder",
            "Rent receipt 2026-09-25.pdf",
            PDF,
            at("2026-09-25"),
            parents=("fold_rent",),
            text="Rent receipt",
        ),
        DFile(
            "r1_folder_img",
            "IMG_2041.jpg",
            JPEG,
            at("2026-09-25"),
            parents=("fold_rent",),
            size=2_400_000,
            body=_jpeg("Holiday photo"),
        ),
        DFile(
            "r1_team",
            "Rent receipt Sep 2026 - team.pdf",
            PDF,
            at("2026-09-18"),
            owner="team",
            drive_id="drive_fin",
            text="Rent receipt",
        ),
        # Reachable only through Priya's nested folders (the walk).
        DFile(
            "r1_walk_title",
            "Rent receipt Sep 2026 - Priya.pdf",
            PDF,
            at("2026-09-06"),
            owner="priya",
            parents=("fold_priya_rcpt",),
            corpus="walk",
        ),
        DFile(
            "r1_walk_out",
            "Rent receipt Aug 2026 - Priya.pdf",
            PDF,
            at("2026-09-01"),
            owner="priya",
            parents=("fold_priya_rcpt",),
            corpus="walk",
        ),
        DFile(
            "r1_walk_hybrid",
            "Scan_0042.pdf",
            PDF,
            at("2026-09-08"),
            owner="priya",
            parents=("fold_priya_rcpt",),
            corpus="walk",
            size=300_000,
            body=_hybrid_rent_scan,
        ),
        # Walked scan whose opening text dates it to July: read, never listed.
        DFile(
            "r1_walk_old_scan",
            "Scan_0050.pdf",
            PDF,
            at("2026-09-03"),
            owner="priya",
            parents=("fold_priya_rcpt",),
            corpus="walk",
            body=_pdf("Rent receipt", "July 2026"),
        ),
        DFile(
            "r1_walk_xlsx",
            "Household ledger 2026.xlsx",
            XLSX,
            at("2026-09-10"),
            owner="priya",
            parents=("fold_priya_2026",),
            corpus="walk",
            size=9_000,
            body=_ledger_xlsx,
        ),
        DFile(
            "r1_walk_gdoc_big",
            "Q3 household binder",
            GDOC,
            at("2026-09-12"),
            owner="priya",
            parents=("fold_priya_2026",),
            corpus="walk",
            export_too_large=True,
            body=lambda: f"Rent receipts for the quarter {MARKER}".encode(),
        ),
        DFile(
            "r1_walk_restricted",
            "Scan_0099.pdf",
            PDF,
            at("2026-09-09"),
            owner="priya",
            parents=("fold_priya_rcpt",),
            corpus="walk",
            can_download=False,
            body=_pdf("Rent receipt September 2026"),
        ),
        DFile(
            "r1_walk_viewer",
            "Rent receipt Sep 2026 - Rahul.pdf",
            PDF,
            at("2026-09-06"),
            owner="rahul",
            parents=("fold_rahul",),
            corpus="walk",
            can_share=False,
        ),
        # A big Google Doc whose title names the request: no read is needed.
        DFile(
            "r1_binder_title",
            "Rent receipts 2026 binder",
            GDOC,
            at("2026-09-15"),
            export_too_large=True,
        ),
        # --- "rental agreement" and "contracts" --------------------------------
        DFile(
            "r2_title",
            "Rental agreement Sep 2026.pdf",
            PDF,
            at("2026-09-03"),
            text="Rental agreement between owner and tenant",
        ),
        DFile("r2_camel", "RentalAgreement_2026_09_10.pdf", PDF, at("2026-09-10")),
        DFile(
            "r2_dental",
            "Dental agreement 2026-09-08.pdf",
            PDF,
            at("2026-09-08"),
            text="Dental clinic agreement",
        ),
        DFile(
            "r2_synonym",
            "Rental contract 2026-09-15.docx",
            DOCX,
            at("2026-09-15"),
            text="Rental contract",
        ),
        DFile(
            "r2_content",
            "Lease deed.pdf",
            PDF,
            at("2026-09-18"),
            text="This rental agreement is made on 18 September 2026",
        ),
        DFile(
            "r2_out",
            "Rental agreement 2025-09-01.pdf",
            PDF,
            at("2026-09-02"),
            text="Rental agreement",
        ),
        DFile(
            "r3_title",
            "Vendor contract 2026-09-15.pdf",
            PDF,
            at("2026-09-15"),
            text="Vendor contract",
        ),
        DFile("r3_underscore", "Freelance_Contract_Sep.pdf", PDF, at("2026-09-16")),
        DFile(
            "r3_contacts",
            "Client contacts 2026-09-15.pdf",
            PDF,
            at("2026-09-15"),
            text="Client contacts list",
        ),
        DFile("r3_nda", "NDA Acme 2026-09-20.pdf", PDF, at("2026-09-20"), text="Non disclosure"),
        # --- codes: "HDFC 8892" and "invoice 8892" -----------------------------
        DFile(
            "r4_code",
            "INV_2026_HDFC_8892.pdf",
            PDF,
            at("2026-09-10"),
            text="Tax invoice INV_2026_HDFC_8892 HDFC Bank",
        ),
        DFile(
            "r4_long",
            "INV_2026_HDFC_88921.pdf",
            PDF,
            at("2026-09-10"),
            text="Tax invoice INV_2026_HDFC_88921 HDFC Bank",
        ),
        DFile("r4_other", "HDFC_8893.pdf", PDF, at("2026-09-10"), text="HDFC 8893"),
        DFile(
            "r4_content",
            "Payment advice Sep 2026.pdf",
            PDF,
            at("2026-09-11"),
            text="Paid against INV_2026_HDFC_8892 via HDFC netbanking",
        ),
        DFile(
            "r4_camel",
            "HDFCBank_Statement_8892_Sep2026.pdf",
            PDF,
            at("2026-09-12"),
            text="HDFC Bank statement 8892 September 2026",
        ),
        DFile(
            "r4_dash",
            "Remittance.pdf",
            PDF,
            at("2026-09-13"),
            text="Ref INV-2026-HDFC-8892 settled",
        ),
        # The same code with every separator dropped.
        DFile("r4_joined", "INV2026HDFC8892.pdf", PDF, at("2026-09-17")),
        DFile("r5_title", "Invoice 8892 - HDFC.pdf", PDF, at("2026-09-14"), text="Invoice"),
        DFile("r5_bill", "Bill 8892.pdf", PDF, at("2026-09-15")),
        # --- Hindi --------------------------------------------------------------
        DFile(
            "r6_hi",
            "हिंदी बैंक स्टेटमेंट सितंबर 2026.pdf",
            PDF,
            at("2026-09-05"),
            text="बैंक स्टेटमेंट सितंबर 2026",
            body=_hindi_pdf("बैंक स्टेटमेंट सितंबर 2026"),
        ),
        DFile(
            "r6_hi_digits",
            "बैंक स्टेटमेंट २०२६-०९-१४.pdf",
            PDF,
            at("2026-09-15"),
            text="बैंक स्टेटमेंट",
            body=_hindi_pdf("बैंक स्टेटमेंट"),
        ),
        DFile(
            "r6_hi_out",
            "बैंक स्टेटमेंट २०२६-०७-१४.pdf",
            PDF,
            at("2026-07-20"),
            text="बैंक स्टेटमेंट",
            body=_hindi_pdf("बैंक स्टेटमेंट"),
        ),
        DFile(
            "r6_banking",
            "बैंकिंग गाइड 2026.pdf",
            PDF,
            at("2026-09-06"),
            text="बैंकिंग गाइड",
            body=_hindi_pdf("बैंकिंग गाइड"),
        ),
        DFile(
            "r6_en",
            "HDFC Bank statement Sep 2026.pdf",
            PDF,
            at("2026-09-07"),
            text="HDFC Bank account statement for September 2026",
        ),
        # --- meeting notes and MoM ---------------------------------------------
        *gemini_notes(),
        DFile(
            "mtg_tz_in",
            "Vendor call - 2026/08/31 23:30 GMT-07:00 - Notes by Gemini",
            GDOC,
            at("2026-09-01", 7),
            text="Summary",
        ),
        DFile(
            "mtg_tz_out",
            "Vendor call - 2026/10/01 00:30 IST - Notes by Gemini",
            GDOC,
            at("2026-09-30", 19, 30),
            text="Summary",
        ),
        DFile(
            "mtg_tz_edge",
            "Vendor call - 2026/09/30 23:45 IST - Notes by Gemini",
            GDOC,
            at("2026-09-30", 18, 45),
            text="Summary",
        ),
        DFile("mtg_camel", "MeetingNotes_2026_09_10.docx", DOCX, at("2026-09-10")),
        DFile(
            "mtg_agenda",
            "Meeting agenda 2026-09-10.docx",
            DOCX,
            at("2026-09-10"),
            text="Agenda; meeting notes to follow",
        ),
        DFile(
            "mtg_recording",
            "Project sync - 2026/09/17 - Recording.mp4",
            MP4,
            at("2026-09-17"),
            size=50 * MB,
        ),
        DFile(
            "mtg_content",
            "Sprint planning 2026-09-14",
            GDOC,
            at("2026-09-14"),
            text="Meeting notes: sprint planning decisions",
        ),
        DFile(
            "mtg_standup", "Daily standup notes 2026-09-16", GDOC, at("2026-09-16"), text="Standup"
        ),
        DFile(
            "mtg_minutes",
            "Board minutes 2026-09-18.pdf",
            PDF,
            at("2026-09-18"),
            text="Minutes of the board meeting held on 18 September 2026",
        ),
        DFile(
            "mtg_mom",
            "MoM - Project X - 12 Sep 2026.pdf",
            PDF,
            at("2026-09-12"),
            text="Minutes of meeting for Project X",
        ),
        DFile("mom_upper", "MOM_2026_09_20.pdf", PDF, at("2026-09-20")),
        DFile("mom_aadhaar", "Mom's Aadhaar.pdf", PDF, at("2026-09-09"), text="Aadhaar card copy"),
        # --- names: "Neha passport" ---------------------------------------------
        DFile(
            "pp_neha", "Neha passport scan 2026-09-10.pdf", PDF, at("2026-09-10"), text="Passport"
        ),
        DFile("pp_sneha", "Sneha passport 2026-09-11.pdf", PDF, at("2026-09-11"), text="Passport"),
        DFile(
            "pp_neha_out", "Neha passport 2026-06-10.pdf", PDF, at("2026-09-02"), text="Passport"
        ),
        # --- big files: "insurance policy" (and a typo of it) -------------------
        DFile(
            "ins_title_big",
            "Insurance policy schedule Sep 2026.pdf",
            PDF,
            at("2026-09-04"),
            size=45 * MB,
        ),
        # Over Drive's 30 MB PDF index limit, under our 32 MiB read cap.
        DFile(
            "ins_big_content",
            "Family documents 2026.pdf",
            PDF,
            at("2026-09-06"),
            size=31 * MB,
            body=_pdf(
                "Family documents",
                "Insurance policy number HX-2231",
                "Valid from 01 September 2026",
            ),
        ),
        DFile(
            "ins_too_big",
            "Scans archive 2026.pdf",
            PDF,
            at("2026-09-07"),
            size=40 * MB,
            body=_pdf("Insurance policy scans"),
        ),
        DFile(
            "ins_big_docx",
            "Household papers.docx",
            DOCX,
            at("2026-09-05"),
            size=12 * MB,
            body=lambda: fx.docx(
                fx.docx_paragraphs(
                    b"<w:r><w:t>Insurance policy renewal notice</w:t></w:r>",
                    b"<w:r><w:t>" + MARKER.encode() + b"</w:t></w:r>",
                )
            ),
        ),
        DFile(
            "ins_claims", "Insurance claims tracker", GDOC, at("2026-09-08"), export_too_large=True
        ),
        DFile(
            "ins_synonym",
            "Policy schedule Sep 2026.pdf",
            PDF,
            at("2026-09-09"),
            text="Policy schedule",
        ),
        DFile(
            "ins_premium",
            "Premium receipt 2026-09-10.pdf",
            PDF,
            at("2026-09-10"),
            text="Premium receipt",
        ),
        DFile(
            "ins_typo_title",
            "Insurence policy 2026-09-11.pdf",
            PDF,
            at("2026-09-11"),
            text="Insurance policy document for the family",
        ),
        DFile(
            "ins_car",
            "Car insurance renewal 2026-09-20.pdf",
            PDF,
            at("2026-09-20"),
            text="Car insurance renewal",
        ),
        # --- fresh uploads: "electricity bill" ----------------------------------
        DFile(
            "el_title",
            "Electricity bill latest.pdf",
            PDF,
            ago(hours=2),
            body=_pdf("Electricity bill", "Consumer number 4471"),
        ),
        DFile(
            "el_fresh_content",
            "Untitled document.pdf",
            PDF,
            ago(minutes=5),
            body=_pdf("Electricity bill", "Consumer number 4471", "Amount due 1840"),
        ),
        DFile(
            "el_synonym", "Electricity invoice.pdf", PDF, ago(days=2), text="Electricity invoice"
        ),
        DFile(
            "el_old",
            "Electricity bill 2026-07-15.pdf",
            PDF,
            at("2026-07-15"),
            text="Electricity bill",
        ),
        DFile(
            "el_photo",
            "Electricity bill photo.jpg",
            JPEG,
            ago(hours=1),
            size=1_800_000,
            body=_jpeg("Holiday photo"),
        ),
    ]
    assert len({item.id for item in files}) == len(files)
    return files


# --- Drive's query language, as documented -------------------------------------

_Q_TOKEN = re.compile(r"\s*(?:(\(|\))|('(?:\\.|[^'\\])*')|(!=|>=|<=|=|<|>)|([A-Za-z]+))")


def drive_words(value: str) -> list[str]:
    """Runs of letters, marks and digits; anything else (``_`` too) separates."""
    words, current = [], []
    for character in unicodedata.normalize("NFC", value).casefold():
        if unicodedata.category(character)[0] in "LMN":
            current.append(character)
        elif current:
            words.append("".join(current))
            current = []
    if current:
        words.append("".join(current))
    return words


def _name_contains(value: str) -> Callable[[DFile], bool]:
    wanted = drive_words(value)

    def match(item: DFile) -> bool:
        words = drive_words(item.name)
        size = len(wanted)
        return bool(wanted) and any(
            words[index : index + size - 1] == wanted[:-1]
            and words[index + size - 1].startswith(wanted[-1])
            for index in range(len(words) - size + 1)
        )

    return match


def _full_text_contains(value: str) -> Callable[[DFile], bool]:
    wanted = drive_words(value.strip('"'))

    def match(item: DFile) -> bool:
        size = len(wanted)
        return bool(wanted) and any(
            words[index : index + size] == wanted
            for words in (drive_words(item.name), drive_words(item.text))
            for index in range(len(words) - size + 1)
        )

    return match


def compile_q(q: str) -> tuple[Callable[[DFile], bool], bool]:
    """A predicate for ``q`` and whether it lists a folder's children."""
    tokens: list[str] = []
    position = 0
    while q[position:].strip():
        match = _Q_TOKEN.match(q, position)
        assert match, q[position:]
        tokens.append(next(group for group in match.groups() if group is not None))
        position = match.end()
    cursor = [0]
    scoped = [False]

    def peek():
        return tokens[cursor[0]] if cursor[0] < len(tokens) else None

    def take(expected=None):
        token = tokens[cursor[0]]
        assert expected is None or token == expected, (token, expected, q)
        cursor[0] += 1
        return token

    def literal(token):
        assert token.startswith("'"), (token, q)
        return re.sub(r"\\(.)", r"\1", token[1:-1])

    def expression():
        left = conjunction()
        while peek() == "or":
            take()
            right = conjunction()
            left = (lambda a, b: lambda item: a(item) or b(item))(left, right)
        return left

    def conjunction():
        left = factor()
        while peek() == "and":
            take()
            right = factor()
            left = (lambda a, b: lambda item: a(item) and b(item))(left, right)
        return left

    def factor():
        token = take()
        if token == "not":
            inner = factor()
            return lambda item: not inner(item)
        if token == "(":
            inner = expression()
            take(")")
            return inner
        if token.startswith("'"):
            value = literal(token)
            take("in")
            collection = take()
            if collection == "parents":
                scoped[0] = True
                return lambda item: value in item.parents
            assert (collection, value) == ("owners", "me"), q
            return lambda item: item.owner == "me"
        operator = take()
        raw = take()
        value = raw == "true" if raw in {"true", "false"} else literal(raw)
        if token == "name":
            assert operator == "contains", q
            return _name_contains(value)
        if token == "fullText":
            assert operator == "contains", q
            return _full_text_contains(value)
        if token == "mimeType":
            if operator == "contains":
                return lambda item: value in item.mime
            if operator == "=":
                return lambda item: item.mime == value
            assert operator == "!=", q
            return lambda item: item.mime != value
        attribute = {"trashed": "trashed", "sharedWithMe": "shared_with_me"}[token]
        if operator == "=":
            return lambda item: getattr(item, attribute) == value
        assert operator == "!=", q
        return lambda item: getattr(item, attribute) != value

    predicate = expression()
    assert cursor[0] == len(tokens), q
    return predicate, scoped[0]


# --- the fake Drive v3 -------------------------------------------------------


@dataclass
class Fault:
    """One scripted provider failure, served ``times`` times before the real answer."""

    label: str
    matches: Callable[[str, str, dict], bool]
    status: int
    body: dict
    headers: dict = field(default_factory=dict)
    times: int = 1
    # What Google did before it answered (a grant made, then an error).
    effect: Callable[["GoldDrive", httpx.Request], None] | None = None


def rate_limited_429(label, matches, *, retry_after="20", times=1) -> Fault:
    body = {"error": {"code": 429, "message": "Rate limit", "status": "RESOURCE_EXHAUSTED"}}
    return Fault(label, matches, 429, body, {"Retry-After": retry_after}, times)


def rate_limited_403(label, matches, *, times=1) -> Fault:
    body = {
        "error": {
            "code": 403,
            "message": "User rate limit exceeded.",
            "errors": [{"reason": "userRateLimitExceeded", "domain": "usageLimits"}],
        }
    }
    return Fault(label, matches, 403, body, {}, times)


def page_token_rejected(label, matches, *, times=1) -> Fault:
    body = {
        "error": {
            "code": 400,
            "message": "Invalid Value",
            "errors": [{"reason": "invalid", "location": "pageToken", "locationType": "parameter"}],
        }
    }
    return Fault(label, matches, 400, body, {}, times)


class GoldDrive:
    """files.list/get/export/download, permissions, drives and changes over A's Drive."""

    def __init__(self, files: list[DFile], *, faults: list[Fault] | None = None):
        self.files = {item.id: item for item in files}
        self.faults = list(faults or [])
        self.permissions: dict[str, list[dict]] = {}
        self.posts: list[tuple[str, str, str]] = []  # file id, email, sendNotificationEmail
        self.downloads: list[str] = []
        self.exports: list[tuple[str, str]] = []
        self.listings: list[dict] = []
        self.served_faults: list[str] = []
        self.post_attempts: list[str] = []
        self._bodies: dict[str, bytes] = {}

    @staticmethod
    def _json(status: int, payload: dict, headers: dict | None = None) -> httpx.Response:
        return httpx.Response(
            status,
            headers=headers or {},
            stream=httpx.ByteStream(json.dumps(payload).encode()),
        )

    @staticmethod
    def _bytes(data: bytes) -> httpx.Response:
        return httpx.Response(200, stream=httpx.ByteStream(data))

    def _not_found(self) -> httpx.Response:
        return self._json(
            404,
            {
                "error": {
                    "code": 404,
                    "message": "File not found.",
                    "errors": [{"reason": "notFound"}],
                }
            },
        )

    def _fault(self, request: httpx.Request, path: str, params: dict) -> httpx.Response | None:
        for fault in self.faults:
            if fault.times > 0 and fault.matches(request.method, path, params):
                fault.times -= 1
                self.served_faults.append(fault.label)
                if fault.effect is not None:
                    fault.effect(self, request)
                return self._json(fault.status, fault.body, fault.headers)
        return None

    def grant(self, file_id: str, request: httpx.Request) -> dict:
        body = json.loads(request.content)
        assert body["type"] == "user" and body["role"] == "reader", body
        permission = {
            "id": f"perm{len(self.posts) + 1}",
            "type": "user",
            "role": "reader",
            "emailAddress": body["emailAddress"],
            **({"expirationTime": body["expirationTime"]} if "expirationTime" in body else {}),
        }
        self.permissions.setdefault(file_id, []).append(permission)
        self.posts.append(
            (file_id, body["emailAddress"], dict(request.url.params).get("sendNotificationEmail"))
        )
        return permission

    def trash(self, file_id: str) -> None:
        self.files[file_id].trashed = True

    def delete(self, file_id: str) -> None:
        del self.files[file_id]

    def rename(self, file_id: str) -> None:
        self.files[file_id].name = "Private letter.pdf"

    def revoke(self, file_id: str) -> None:
        self.files[file_id].can_share = False

    def body(self, item: DFile) -> bytes:
        if item.id not in self._bodies:
            if item.body is not None:
                self._bodies[item.id] = item.body()
            elif item.mime == PDF:
                self._bodies[item.id] = fx.text_pdf([f"Synthetic file {item.id}", MARKER])
            else:
                self._bodies[item.id] = f"Synthetic file {item.id} {MARKER}".encode()
        return self._bodies[item.id]

    def _row(self, item: DFile) -> dict:
        row = {
            "id": item.id,
            "name": item.name,
            "mimeType": item.mime,
            "modifiedTime": item.mtime,
            "createdTime": item.created,
            "webViewLink": f"https://drive.google.com/file/d/{item.id}/view",
            "capabilities": {"canShare": item.can_share, "canDownload": item.can_download},
        }
        if item.size is not None:
            row["size"] = str(item.size)
        if item.drive_id:
            row["driveId"] = item.drive_id
        if item.encrypted:
            row["clientEncryptionDetails"] = {"encryptionState": "encrypted"}
        if item.mime == SHORTCUT:
            row["shortcutDetails"] = {"targetId": item.target, "targetMimeType": item.target_mime}
        return row

    def _file(self, item: DFile) -> dict:
        return {
            **self._row(item),
            "version": "7",
            "trashed": item.trashed,
            "isAppAuthorized": False,
            "capabilities": {
                "canShare": item.can_share,
                "canDownload": item.can_download,
                "canAccessViaGenAi": True,
            },
        }

    def _list(self, params: dict) -> httpx.Response:
        q = params["q"]
        assert params.get("supportsAllDrives") == "true", params
        assert not (query_has_full_text_term(q) and "orderBy" in params), q
        predicate, scoped = compile_q(q)
        drive_id = params.get("driveId") if params.get("corpora") == "drive" else None
        rows = []
        for item in self.files.values():
            if drive_id is not None:
                if item.drive_id != drive_id:
                    continue
            elif item.drive_id is not None or (item.corpus != "user" and not scoped):
                # Google's user corpus never holds a file reachable only
                # through a shared folder; listing that folder still does.
                continue
            if predicate(item):
                rows.append(item)
        rows.sort(key=lambda item: item.id)
        order = params.get("orderBy")
        if order:
            key = {"modifiedTime desc": "mtime", "createdTime desc": "created"}[order]
            rows.sort(key=lambda item: getattr(item, key), reverse=True)
        token = params.get("pageToken")
        if token is not None and not re.fullmatch(r"t[0-9]{1,6}", token):
            return self._json(400, {"error": {"code": 400, "errors": [{"reason": "invalid"}]}})
        offset = int(token[1:]) if token else 0
        size = int(params["pageSize"])
        chunk = rows[offset : offset + size]
        self.listings.append(
            {
                "q": q,
                "token": token,
                "size": size,
                "corpora": params.get("corpora"),
                "rows": len(chunk),
            }
        )
        payload = {"files": [self._row(item) for item in chunk], "incompleteSearch": False}
        if offset + len(chunk) < len(rows):
            payload["nextPageToken"] = f"t{offset + len(chunk)}"
        return self._json(200, payload)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "www.googleapis.com", request.url.host
        path = request.url.path.removeprefix("/drive/v3")
        params = dict(request.url.params)
        method = request.method
        if method == "POST":
            self.post_attempts.append(path.split("/")[2])
        fault = self._fault(request, path, params)
        if fault is not None:
            return fault
        if path == "/files" and method == "GET":
            return self._list(params)
        if path == "/drives":
            return self._json(200, {"drives": [{"id": "drive_fin", "name": "Team Finance"}]})
        if path == "/changes/startPageToken":
            return self._json(200, {"startPageToken": "1"})
        if path == "/changes":
            return self._json(200, {"changes": [], "newStartPageToken": params["pageToken"]})
        match = re.fullmatch(r"/files/([A-Za-z0-9_-]+)(/export|/permissions)?", path)
        assert match, path
        item = self.files.get(match.group(1))
        if item is None:
            return self._not_found()
        if match.group(2) == "/export":
            self.exports.append((item.id, params["mimeType"]))
            if item.export_too_large:
                message = "This file is too large to be exported."
                return self._json(
                    403,
                    {
                        "error": {
                            "code": 403,
                            "message": message,
                            "errors": [{"reason": "exportSizeLimitExceeded", "message": message}],
                        }
                    },
                )
            return self._bytes(self.body(item))
        if match.group(2) == "/permissions":
            granted = self.permissions.setdefault(item.id, [])
            if method == "GET":
                owner = {
                    "id": "ownerperm",
                    "type": "user",
                    "role": "owner",
                    "emailAddress": OWNER_EMAIL,
                }
                return self._json(200, {"permissions": [owner, *granted]})
            assert method == "POST", method
            return self._json(200, self.grant(item.id, request))
        if params.get("alt") == "media":
            self.downloads.append(item.id)
            return self._bytes(self.body(item))
        return self._json(200, self._file(item))


def test_the_fake_drive_follows_googles_documented_search_semantics():
    """The gold expectations are only as good as this model of Drive."""
    files = synthetic_drive(datetime(2026, 10, 18, 6, 0, tzinfo=UTC))
    by_id = {item.id: item for item in files}

    def hits(q):
        predicate, scoped = compile_q(q)
        return {
            item.id
            for item in files
            if item.drive_id is None and (item.corpus == "user" or scoped) and predicate(item)
        }

    # name contains is a word prefix: "rent" reaches "rental", never "current".
    assert "r2_title" in hits("name contains 'rent'")
    # A camelCase name is one word to Drive: its inner words are invisible.
    assert "r1_camel" not in hits("name contains 'receipt'")
    assert "r1_camel" in hits("name contains 'rentreceipt'")
    # An underscore separates words, in names and in text.
    assert "r4_code" in hits("name contains '8892'")
    assert "r4_dash" in hits("""fullText contains '"inv 2026 hdfc 8892"'""")
    assert "r4_content" in hits("""fullText contains '"inv 2026 hdfc 8892"'""")
    # fullText matches whole words: "88921" is not "8892".
    assert "r4_long" not in hits("fullText contains '8892'")
    # Devanagari stays whole: बैंक is a prefix of बैंकिंग, but not a word in it.
    assert "r6_banking" in hits("name contains 'बैंक'")
    assert "r6_banking" not in hits("fullText contains 'बैंक'")
    # The user corpus leaves out what only a shared folder reaches; the
    # folder listing still returns it.
    assert "r1_walk_title" not in hits("name contains 'rent' and trashed = false")
    assert "r1_walk_title" in hits("trashed = false and 'fold_priya_rcpt' in parents")
    # Fresh uploads and files over Google's index limits hold no indexed text.
    assert not by_id["el_fresh_content"].text and not by_id["ins_big_content"].text
    assert "r1_trashed" not in hits("name contains 'rent' and trashed = false")
    assert hits("not 'me' in owners and name contains 'rent'") >= {"r1_viewer", "r1_priya_direct"}


# --- the request run -----------------------------------------------------------


@dataclass
class RequestSpec:
    key: str
    phrase: str
    auto: frozenset
    possible: dict
    period: tuple[str, str] | None = SEPTEMBER  # None: the last ten days, ending today
    # Must never be shared and never listed (the near misses, readable at a glance).
    never_listed: frozenset = frozenset()
    faults: Callable[[], list[Fault]] | None = None
    # Drive changes after the search and before the share (file id -> "trash"/"delete").
    between: dict = field(default_factory=dict)
    # Possible matches the owner sends with one tap before B pays.
    owner_send: frozenset = frozenset()
    # Product bugs (file id -> finding): auto-shared now, must never be shared.
    known_overshare: dict = field(default_factory=dict)
    # Product bugs (file id -> finding): must auto-share, is not shared now.
    known_undershare: dict = field(default_factory=dict)
    # Stage-level checks for this request (faults served, retries, reads).
    checks: Callable[[dict], None] | None = None

    def __repr__(self) -> str:
        return self.key


def _generation(db) -> int:
    with db.engine.connect() as connection:
        return connection.execute(
            text("""SELECT connection_generation FROM user_external_connector_connections
            WHERE user_id='owner' AND connector_id='google_drive'""")
        ).scalar_one()


def _sql(db, statement, params=None):
    with db.engine.begin() as connection:
        result = connection.execute(text(statement), params or {})
        return [dict(row) for row in result.mappings()] if result.returns_rows else result.rowcount


def _pay(db, request_id):
    """The Stripe charge settles, as its verified webhook would record it."""
    updated = _sql(
        db,
        """UPDATE drive_request_payment_orders SET status='paid',paid_at=clock_timestamp()
        WHERE request_id=:request""",
        {"request": request_id},
    )
    if not updated:
        _sql(
            db,
            """INSERT INTO drive_request_payment_orders
              (stripe_mode,request_id,user_id,requester_user_id,status,paid_at)
              VALUES ('test',:request,'owner','recipient','paid',clock_timestamp())""",
            {"request": request_id},
        )


def _search_deferral(db, request_id) -> tuple[float, str | None] | None:
    """A retry backoff the search store chose (seconds, public code); then skip it."""
    rows = _sql(
        db,
        """SELECT EXTRACT(EPOCH FROM (next_at-clock_timestamp())) AS wait,error_code
        FROM drive_owner_search_jobs WHERE user_id='owner' AND client_request_id=:request
          AND status='queued' AND next_at>clock_timestamp()+INTERVAL '500 milliseconds'""",
        {"request": request_id},
    )
    if not rows:
        return None
    _sql(
        db,
        """UPDATE drive_owner_search_jobs SET next_at=clock_timestamp()
        WHERE user_id='owner' AND client_request_id=:request AND status='queued'""",
        {"request": request_id},
    )
    return float(rows[0]["wait"]), rows[0]["error_code"]


def _open_results(bulk, job_id) -> dict[int, dict]:
    rows = _sql(
        bulk.db,
        """SELECT position,metadata_envelope FROM drive_owner_search_results
        WHERE job_id=:job ORDER BY position""",
        {"job": job_id},
    )
    return {
        row["position"]: bulk._open(
            row["metadata_envelope"],
            user_id="owner",
            resource_id=f"{job_id}:{row['position']}",
            purpose="owner-search-result",
        )
        for row in rows
    }


def _open_checkpoint(bulk, job_id) -> dict:
    [row] = _sql(
        bulk.db,
        "SELECT checkpoint_envelope FROM drive_owner_search_jobs WHERE job_id=:job",
        {"job": job_id},
    )
    return bulk._open(
        row["checkpoint_envelope"],
        user_id="owner",
        resource_id=job_id,
        purpose="owner-search-checkpoint",
    )


def _batches(db, request_id, committed) -> list[dict]:
    grouped: dict = {}
    for row in _sql(
        db,
        """SELECT b.share_id,b.approved_at IS NOT NULL AS approved,f.source_position
        FROM drive_bulk_share_files f JOIN drive_bulk_shares b ON b.share_id=f.share_id
        WHERE f.user_id='owner' AND f.origin_request_id=:request
        ORDER BY b.created_at,b.share_id,f.source_position""",
        {"request": request_id},
    ):
        grouped.setdefault((str(row["share_id"]), row["approved"]), []).append(
            committed[row["source_position"]]["id"]
        )
    return [{"approved": approved, "files": ids} for (_, approved), ids in grouped.items()]


def _period(spec: RequestSpec) -> tuple[str, str]:
    if spec.period is not None:
        return spec.period
    today = datetime.now(ZoneInfo(TIMEZONE)).date()
    return (today - timedelta(days=10)).isoformat(), today.isoformat()


async def run_gold_request(
    monkeypatch,
    sharing,
    bulk,
    spec: RequestSpec,
    *,
    owner_index_enabled: bool = True,
    content_check_enabled: bool = True,
) -> dict:
    """B asks, A allows, the worker searches, A sends, B pays, the sharer shares."""
    monkeypatch.setenv("DRIVE_WORKER_MODE", "true")
    monkeypatch.setattr(share_worker_module, "_START_INTERVAL", 0.0)
    monkeypatch.setattr(search_module, "wake_drive_work", AsyncMock())
    monkeypatch.setattr(worker_module, "wake_drive_work", AsyncMock())
    PACING.reset()
    now = datetime.now(UTC)
    drive_fake = GoldDrive(synthetic_drive(now), faults=spec.faults() if spec.faults else [])
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(drive_fake)),
    )
    generation = _generation(sharing.db)
    connection = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": LIVE_POLICY_HASH,
        "connection_generation": generation,
    }
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                connection,
                {
                    "accessToken": "synthetic",
                    "subject": "owner-google",
                    "oauthClientId": "synthetic-client",
                },
            )
        ),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=connection)),
    )
    adapter = GoogleDriveAdapter()
    transport = rest.GoogleDriveRestTransport(oauth=oauth, adapter=adapter)
    # The Drive worker deployment wires Gear 1 and the content check.
    index = (
        MetadataOwnerIndex(
            indexer=gear1.OwnerMetadataIndexer(transport=transport),
            generation=AsyncMock(return_value=generation),
        )
        if owner_index_enabled
        else NoOwnerIndex()
    )
    content_check = RequestContentCheck(
        reader=FencedContentReader(oauth=oauth, adapter=adapter),
        # The real isolated parser child; only the ClamAV daemon is faked.
        processor=LocalDocumentProcessor(
            scanner=SimpleNamespace(scan=AsyncMock()), parser=SimpleNamespace(), embedder=None
        ),
        enabled=lambda: content_check_enabled,
    )
    store = DriveOwnerSearchStore(db=sharing.db)
    scanner = DriveOwnerSearchService(
        store=store, transport=transport, owner_index=index, content_check=content_check
    )
    planner_calls = []

    async def no_model_planner(*args, **kwargs):
        planner_calls.append("gemini")
        raise RuntimeError("403 CONSUMER_SUSPENDED")

    async def verified_recipient(user_id):
        return VerifiedGoogleRecipient(user_id, *RECIPIENT[1:], datetime.now(UTC))

    monkeypatch.setattr(bulk_module, "plan_live_search", no_model_planner)
    monkeypatch.setattr(bulk_module, "DriveOwnerSearchService", lambda: scanner)
    monkeypatch.setattr(bulk_module, "default_owner_index", lambda: index)
    monkeypatch.setattr(bulk_module, "recipient_identity_for_user", verified_recipient)

    start, end = _period(spec)
    created = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(*RECIPIENT, datetime.now(UTC)),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        expected_quote_version=1,
        request_time_zone=TIMEZONE,
        purpose=ShareRequestPurpose(purpose=spec.phrase, periodStart=start, periodEnd=end),
    )
    request_id = created["requestId"]
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["trustedAuto"] is False  # an ordinary request: nothing runs before Allow
    await sharing.allow_request(
        user_id="owner", request_id=request_id, revision=created["revision"], amount_cents=50
    )
    payment = DriveRequestPaymentService(db=sharing.db)
    auto = DriveTrustedAutoService(sharing=sharing, bulk=bulk, payment=payment, wake=AsyncMock())
    worker = DriveOwnerSearchWorker(scanner, trusted_auto=auto)
    deferrals = []
    search = None
    for _ in range(80):
        outcome = await worker.run(max_jobs=1, deadline_seconds=200)
        assert not outcome["outcomes"].get("unavailable"), outcome
        search = await store.by_client(user_id="owner", client_request_id=request_id)
        if search is not None and search["status"] not in {"queued", "running"}:
            break
        deferral = _search_deferral(sharing.db, request_id)
        if deferral is not None:
            deferrals.append(deferral)
    assert search is not None
    # The worker's batch drain after the search: frozen batches wait for payment.
    await worker.run(max_jobs=1, deadline_seconds=200)
    search = await store.by_client(user_id="owner", client_request_id=request_id)
    job_id = search["jobId"]
    committed = _open_results(bulk, job_id)
    checkpoint = _open_checkpoint(bulk, job_id)
    position_of = {}
    for position, item in committed.items():
        position_of.setdefault(item["id"], position)
    matches = DrivePossibleMatchesStore(db=sharing.db, cipher=bulk.cipher)
    listed = await matches.possible_matches(user_id="owner", request_id=request_id)
    possible = {}
    for item in listed["matches"]:
        position = int(item["matchRef"].rsplit(":", 1)[1])
        possible[committed[position]["id"]] = item["kind"]
    before_payment = _batches(sharing.db, request_id, committed)
    # A taps Send on chosen possible matches before B pays.
    if spec.owner_send:
        refs = [
            item["matchRef"]
            for item in listed["matches"]
            if committed[int(item["matchRef"].rsplit(":", 1)[1])]["id"] in spec.owner_send
        ]
        assert len(refs) == len(spec.owner_send), (refs, possible)
        sent = await matches.send(user_id="owner", request_id=request_id, match_refs=refs)
        assert sent["queued"] == len(refs)
    # Drive changes between the search and the share.
    for file_id, change in spec.between.items():
        getattr(drive_fake, change)(file_id)
    _pay(sharing.db, request_id)
    share_error = None
    try:
        for _ in range(10):
            if not await auto.share_available(user_id="owner", request_id=request_id):
                break
    except DriveSharingError as error:
        # A failed search never releases a batch, paid or not.
        share_error = str(error)
    sharer = DriveBulkShareWorker(
        store=bulk,
        oauth=oauth,
        adapter=GoogleDrivePermissionAdapter(),
        verify_recipient=AsyncMock(),
        send_push=lambda *args, **kwargs: 0,
        wake=AsyncMock(),
    )
    share_outcomes: Counter = Counter()
    for _ in range(8):
        outcome = await sharer.run(max_jobs=400, deadline_seconds=60)
        share_outcomes.update(outcome["outcomes"])
        retried = _sql(
            sharing.db,
            """UPDATE drive_bulk_share_effects SET next_at=clock_timestamp()-INTERVAL '1 second'
            WHERE user_id='owner' AND state IN ('queued','dispatching','unknown')
              AND next_at>clock_timestamp()""",
        )
        pending = _sql(
            sharing.db,
            """SELECT count(*) AS n FROM drive_bulk_share_effects
            WHERE user_id='owner' AND state IN ('queued','dispatching','unknown')""",
        )[0]["n"]
        if not retried and not pending:
            break
    after_payment = _batches(sharing.db, request_id, committed)
    effect_states = Counter(
        row["state"]
        for row in _sql(
            sharing.db,
            "SELECT state FROM drive_bulk_share_effects WHERE user_id='owner'",
        )
    )
    posts = Counter(file_id for file_id, _, _ in drive_fake.posts)
    run = {
        "requestId": request_id,
        "status": search["status"],
        "incompleteSearch": search["incompleteSearch"],
        "coverage": search["coverage"],
        "planSource": checkpoint.get("request_plan_source"),
        "plannerCalls": planner_calls,
        "committed": {item["id"] for item in committed.values()},
        "committedIds": [item["id"] for item in committed.values()],
        "unshareable": {
            item["id"]: item.get("unavailableReason")
            for item in committed.values()
            if item.get("shareable") is not True
        },
        "possible": possible,
        "possibleCount": listed["count"],
        "batchesBeforePayment": before_payment,
        "batchesAfterPayment": after_payment,
        "posts": posts,
        "postAttempts": Counter(drive_fake.post_attempts),
        "postRecipients": {email for _, email, _ in drive_fake.posts},
        "postNotify": {notify for _, _, notify in drive_fake.posts},
        "shared": set(posts),
        "downloads": Counter(drive_fake.downloads),
        "exports": drive_fake.exports,
        "listings": drive_fake.listings,
        "servedFaults": drive_fake.served_faults,
        "deferrals": deferrals,
        "effectStates": effect_states,
        "shareError": share_error,
        "shareOutcomes": share_outcomes,
        "checkpoint": checkpoint,
        "committedMetadata": committed,
        "drive": drive_fake,
    }
    return run


GOLD_METRICS: dict[str, dict] = {}


def score(spec: RequestSpec, run: dict, all_ids: set[str]) -> dict:
    """Auto-share precision/recall, possible-match recall and false shares.

    The expectation is the product rule, known product bugs included: a known
    overshare counts as a false share and a known undershare as a miss.
    """
    shared = run["shared"] - spec.owner_send
    expected = set(spec.auto) | set(spec.known_undershare)
    true_shares = shared & expected
    false_shares = shared - expected
    listed = set(run["possible"])
    found = {key for key, kind in run["possible"].items() if spec.possible.get(key) == kind}
    coverage = run["coverage"]
    metrics = {
        "request": spec.key,
        "autoShared": len(shared),
        "autoExpected": len(expected),
        "autoPrecision": round(len(true_shares) / len(shared), 4) if shared else 1.0,
        "autoRecall": round(len(true_shares) / len(expected), 4) if expected else 1.0,
        "falseShares": sorted(false_shares),
        "missedShares": sorted(expected - shared),
        "ownerSent": sorted(run["shared"] & spec.owner_send),
        "possibleListed": len(listed),
        "possibleExpected": len(spec.possible),
        "possibleRecall": round(len(found) / len(spec.possible), 4) if spec.possible else 1.0,
        "possiblePrecision": round(len(found) / len(listed), 4) if listed else 1.0,
        "unexpectedPossible": sorted(listed - set(spec.possible)),
        "neverShared": len(all_ids - run["shared"]),
        "contentFilesSelected": coverage.get("contentFilesSelected"),
        "contentFilesRead": coverage.get("contentFilesRead"),
        "coveragePartial": coverage.get("coveragePartial"),
        "sharedFolderWalk": coverage.get("sharedFolderWalk"),
        "retryBackoffs": [[round(wait, 1), code] for wait, code in run["deferrals"]],
        "providerFaultsServed": run["servedFaults"],
        "shareEffects": dict(run["effectStates"]),
    }
    print("GOLD_METRICS " + json.dumps(metrics, sort_keys=True))
    GOLD_METRICS[spec.key] = metrics
    return metrics


def _faults_meeting_notes() -> list[Fault]:
    """A rejected page token mid-pass, then a burst of rate limits."""

    def title_page_with_token(method, path, params):
        return (
            path == "/files"
            and bool(params.get("pageToken"))
            and "notes by gemini" in params.get("q", "")
            and not query_has_full_text_term(params.get("q", ""))
        )

    def content_pass(method, path, params):
        return path == "/files" and query_has_full_text_term(params.get("q", ""))

    def create(file_id):
        return lambda method, path, params: (
            method == "POST" and path == f"/files/{file_id}/permissions"
        )

    def invalid_sharing(message):
        return {
            "error": {
                "code": 400,
                "message": message,
                "errors": [{"reason": "invalidSharingRequest", "message": message}],
            }
        }

    share_faults = [
        # Google made the grant, then answered 400: reconciled, never re-POSTed.
        Fault(
            "share_400_after_success",
            create("mtg_20"),
            400,
            invalid_sharing("Items were successfully shared but emails could not be sent."),
            effect=lambda drive, request: drive.grant("mtg_20", request),
        ),
        # Google refused the share for its sharing rate limit: retried later.
        Fault(
            "share_rate_limited",
            create("mtg_21"),
            403,
            {
                "error": {
                    "code": 403,
                    "message": "Sharing rate limit exceeded.",
                    "errors": [{"reason": "sharingRateLimitExceeded"}],
                }
            },
        ),
        # No grant: B has no Google account. Reported, never retried.
        Fault(
            "share_needs_google_account",
            create("mtg_22"),
            400,
            invalid_sharing("You are trying to invite someone with no Google account."),
        ),
    ]
    server_error = Fault(
        "content_pass_503",
        content_pass,
        503,
        {"error": {"code": 503, "message": "Backend Error"}},
    )
    return [
        page_token_rejected("title_page_token_rejected", title_page_with_token),
        rate_limited_429("content_pass_429", content_pass, retry_after="20"),
        rate_limited_403("content_pass_403", content_pass),
        rate_limited_429("content_pass_429_long", content_pass, retry_after="120"),
        server_error,
        *share_faults,
    ]


def _faults_rent_receipts() -> list[Fault]:
    """One rate limit on a content download and one on a share-time recheck."""

    def hybrid_download(method, path, params):
        return path == "/files/r1_walk_hybrid" and params.get("alt") == "media"

    def share_inspect(method, path, params):
        return (
            path == "/files/r1_underscore"
            and "isAppAuthorized" in params.get("fields", "")
            and "canShare" in params.get("fields", "")
        )

    return [
        rate_limited_429("content_download_429", hybrid_download, retry_after="5"),
        rate_limited_429("share_inspect_429", share_inspect, retry_after="5"),
    ]


def check_rent_receipts(run: dict) -> None:
    coverage = run["coverage"]
    assert sorted(run["servedFaults"]) == ["content_download_429", "share_inspect_429"]
    # The rate-limited download was retried on the next content page: read once.
    assert run["downloads"]["r1_walk_hybrid"] == 1
    # The rate-limited share-time recheck was retried: shared once.
    assert run["posts"]["r1_underscore"] == 1 and run["shareOutcomes"]["queued"] >= 1
    # Trashed, deleted, renamed or no longer shareable after the search:
    # frozen into the paid batch, then refused by the share-time recheck
    # (each would have been shared).
    changed = {"r1_trash_later", "r1_delete_later", "r1_rename_later", "r1_unshare_later"}
    frozen = {file_id for batch in run["batchesAfterPayment"] for file_id in batch["files"]}
    assert changed <= frozen and not changed & run["shared"]
    refused = sum(count for state, count in run["effectStates"].items() if state != "succeeded")
    assert refused == len(changed), run["effectStates"]
    # One tap: the owner's chosen possible match is sent after payment, once.
    assert run["posts"]["r1_content"] == 1
    # Shortcuts resolve to their targets; a missing target is never shareable.
    assert "sc_both" not in run["committed"] and "sc_alias" not in run["committed"]
    assert run["unshareable"] == {
        "r1_viewer": "source_not_shareable",
        "r1_encrypted": "source_not_shareable",
        "r1_walk_viewer": "source_not_shareable",
        "sc_gone": "shortcut_target_unavailable",
    }
    # The walk lists Priya's three folders (one also reached through A's
    # shortcut, one through a cycle back to the root) and Rahul's, once each.
    assert coverage["sharedFoldersWalked"] == 4 and coverage["sharedFolderWalkSkipped"] == 0
    assert coverage["deduplicatedCount"] > 0
    # The walked big Google Doc: both exports hit Google's 10 MB cap.
    assert [mime for file_id, mime in run["exports"] if file_id == "r1_walk_gdoc_big"] == [
        "text/markdown",
        "text/plain",
    ]
    # Never downloaded: Google forbids it, or it is over the 32 MiB read cap.
    for file_id in ("r1_walk_restricted", "ins_too_big", "ins_title_big"):
        assert not run["downloads"].get(file_id), file_id
    # 15 Drive-blind candidates; the export-capped Doc and the two files over
    # the read cap are counted, not read, and make coverage partial.
    assert (coverage["contentFilesSelected"], coverage["contentFilesRead"]) == (15, 12)
    # Partly read scans add to the unread count where OCR is weak or absent;
    # the three files nobody could download are always there.
    assert coverage["contentFilesTooLarge"] == 3 and coverage["contentFilesUnread"] >= 3
    assert coverage["contentCheck"] == "partial" and coverage["coveragePartial"] is True
    # Clearer error types: Google's export cap and rate limits keep their own
    # causes (fixed codes in logs), never a generic "no access".
    logs = run["logs"]
    assert "operation=export status=403 reason=export_too_large" in logs
    assert "operation=content status=429 reason=rate_limited" in logs
    assert "reason=source_unavailable" not in logs.split("operation=export", 1)[-1][:200]


def check_meeting_notes(run: dict) -> None:
    served = run["servedFaults"]
    assert served[:5] == [
        "title_page_token_rejected",
        "content_pass_429",
        "content_pass_403",
        "content_pass_429_long",
        "content_pass_503",
    ]
    assert sorted(served[5:]) == [
        "share_400_after_success",
        "share_needs_google_account",
        "share_rate_limited",
    ]
    # Share-path outcomes: a 400 after a real grant is reconciled and never
    # POSTed again; a sharing rate limit is retried after the absence check; a
    # recipient without a Google account is reported and never retried.
    attempts = run["postAttempts"]
    assert (attempts["mtg_20"], run["posts"]["mtg_20"]) == (1, 1)
    assert (attempts["mtg_21"], run["posts"]["mtg_21"]) == (2, 1)
    assert (attempts["mtg_22"], run["posts"]["mtg_22"]) == (1, 0)
    assert run["effectStates"]["failed"] == 1
    # The rejected page token restarted its pass from page 1, with no backoff.
    title = [
        item
        for item in run["listings"]
        if item["corpora"] == "user"
        and "notes by gemini" in item["q"]
        and not query_has_full_text_term(item["q"])
    ]
    assert [(item["token"], item["size"]) for item in title[:2]] == [(None, 25), (None, 100)]
    assert "status=400 reason=page_token_invalid" in run["logs"]
    # Four retryable failures in a row (two rate limits with Retry-After, one
    # 403 rate limit, one 5xx) back off longer each time; the search still
    # completes. Retry-After floors a backoff and Google's 64 s caps it.
    waits = [wait for wait, _ in run["deferrals"]]
    assert {code for _, code in run["deferrals"]} == {"provider_unavailable"}
    assert len(waits) == 4, waits
    assert 19 <= waits[0] <= 64  # Retry-After: 20 (equal jitter alone: 4-8 s)
    assert 7 <= waits[1] <= 17  # streak 2: 8-16 s
    assert 63 <= waits[2] <= 64.5  # Retry-After: 120, capped at 64 s
    assert 31 <= waits[3] <= 64.5  # streak 4: 32-64 s


def check_code_phrase(run: dict) -> None:
    # An underscore in text is a space to Drive: the code goes as one phrase.
    phrase = """fullText contains '"inv 2026 hdfc 8892"'"""
    assert any(phrase in item["q"] for item in run["listings"]), "no phrase query sent"


def check_big_files(run: dict) -> None:
    # Over Drive's index limits (30 MB PDF, 10 MB DOCX): read once each by
    # our own content check.
    assert run["downloads"]["ins_big_content"] == run["downloads"]["ins_big_docx"] == 1
    # Shared on title evidence alone: never downloaded, never exported.
    assert not run["downloads"].get("ins_title_big") and not run["downloads"].get("ins_too_big")
    assert not [file_id for file_id, _ in run["exports"] if file_id == "ins_claims"]


def check_fresh_uploads(run: dict) -> None:
    # Not yet in Google's content index: Gear 1's recent rows send it to the
    # content check, the only file this request reads.
    assert run["downloads"]["el_fresh_content"] == 1
    assert run["coverage"]["contentFilesRead"] == 1


SEPTEMBER_NOTES = frozenset(note.id for note in gemini_notes() if in_september(note))

REQUESTS = [
    RequestSpec(
        "rent_receipts",
        "rent receipts",
        auto=frozenset(
            {
                "r1_own",
                "r1_underscore",
                "r1_camel",
                "r1_upper",
                "r1_target",
                "r1_priya_direct",
                "r1_yearless_in",
                # A month-only title inside the period decides, whatever the
                # created time says (created 3 Oct, titled September).
                "r1_monthyear_late",
                "r1_in_folder",
                "r1_team",
                "r1_walk_title",
                "r1_binder_title",
                "r1_tz_created_in",
            }
        ),
        possible={
            # The shortcut's alias names the request; its target's title does not.
            "t_landlord": CONTENT,
            "r1_synonym": SYNONYM,
            "r1_content": CONTENT,
            # Read by our own content check: a hybrid scan and a second worksheet.
            "r1_walk_hybrid": CONTENT,
            "r1_walk_xlsx": CONTENT,
        },
        never_listed=frozenset(
            {
                "r1_trashed",
                "r1_viewer",
                "r1_encrypted",
                "r1_iso_out",
                "r1_dayfirst_out",
                "r1_monthname_out",
                "r1_span_out",
                "r1_content_out",
                "r1_folder_img",
                "r1_walk_out",
                "r1_walk_gdoc_big",
                "r1_walk_restricted",
                "r1_walk_viewer",
                "sc_gone",
                "r1_dayfirst_ambiguous",
                "r1_tz_created_out",
                "r1_walk_old_scan",
                # Month-only and year-less titles naming August decide the
                # period, though each was created inside September.
                "r1_monthyear_out",
                "r1_isomonth_out",
                "r1_yearless_out",
            }
        ),
        faults=_faults_rent_receipts,
        between={
            "r1_trash_later": "trash",
            "r1_delete_later": "delete",
            "r1_rename_later": "rename",
            "r1_unshare_later": "revoke",
        },
        owner_send=frozenset({"r1_content"}),
        checks=check_rent_receipts,
    ),
    RequestSpec(
        "rental_agreement",
        "rental agreement",
        auto=frozenset({"r2_title", "r2_camel"}),
        possible={"r2_synonym": SYNONYM, "r2_content": CONTENT},
        never_listed=frozenset({"r2_dental", "r2_out"}),
    ),
    RequestSpec(
        "contracts",
        "contracts",
        auto=frozenset({"r3_title", "r3_underscore", "r2_synonym"}),
        possible={
            "r3_nda": SYNONYM,
            "r2_title": SYNONYM,
            "r2_camel": SYNONYM,
            "r2_dental": SYNONYM,
            "r2_content": CONTENT,
        },
        never_listed=frozenset({"r3_contacts", "r2_out"}),
    ),
    RequestSpec(
        "code_hdfc_8892",
        "HDFC 8892",
        auto=frozenset({"r4_code", "r4_camel", "r5_title"}),
        possible={
            # Drive's word-prefix name match returns the longer code; no title evidence.
            "r4_long": CONTENT,
            "r4_content": CONTENT,
            "r4_dash": CONTENT,
            # Gear 1 splits the joined code into letter and digit runs; the
            # typed words are not whole title words, so it only discovers.
            "r4_joined": CORRECTED,
        },
        never_listed=frozenset({"r4_other", "r5_bill"}),
    ),
    RequestSpec(
        "code_typed_whole",
        "INV_2026_HDFC_8892",
        auto=frozenset({"r4_code", "r4_joined"}),
        possible={"r4_content": CONTENT, "r4_dash": CONTENT, "r4_long": CONTENT},
        never_listed=frozenset({"r4_other", "r4_camel", "r5_title", "r5_bill"}),
        checks=check_code_phrase,
    ),
    RequestSpec(
        "code_invoice_8892",
        "invoice 8892",
        auto=frozenset({"r5_title"}),
        # "INV" is not "invoice": the code file is discovery (its text says invoice).
        possible={"r5_bill": SYNONYM, "r4_code": CONTENT, "r4_long": CONTENT},
        never_listed=frozenset({"r4_other", "r4_content", "r4_dash"}),
    ),
    RequestSpec(
        "hindi_bank_statement",
        "बैंक स्टेटमेंट",
        auto=frozenset({"r6_hi", "r6_hi_digits"}),
        # A Hindi request never auto-shares an English title.
        possible={"r6_en": SYNONYM, "r4_camel": SYNONYM},
        never_listed=frozenset({"r6_hi_out", "r6_banking"}),
    ),
    RequestSpec(
        "meeting_notes",
        "meeting notes",
        # mtg_22: Google refuses the share (B has no Google account): never shared.
        auto=SEPTEMBER_NOTES - {"mtg_22"} | {"mtg_tz_in", "mtg_tz_edge", "mtg_camel"},
        possible={
            "mtg_content": CONTENT,
            "mtg_standup": SYNONYM,
            "mtg_minutes": CONTENT,
            "mtg_mom": CONTENT,
        },
        never_listed=frozenset({"mtg_tz_out", "mtg_agenda", "mtg_recording", "mom_aadhaar"}),
        faults=_faults_meeting_notes,
        checks=check_meeting_notes,
    ),
    RequestSpec(
        "minutes_of_meeting_cased",
        "MoM",
        auto=frozenset({"mtg_mom", "mom_upper", "mtg_minutes"}),
        # Lowercase "mom" is a discovery spelling only (D3 lists it, never sends it).
        possible={"mom_aadhaar": SYNONYM},
    ),
    RequestSpec(
        "neha_passport",
        "Neha passport",
        auto=frozenset({"pp_neha"}),
        # Gear 1's inner-word match: "Similar spelling" for the owner, never sent.
        possible={"pp_sneha": CORRECTED},
        never_listed=frozenset({"pp_neha_out"}),
    ),
    RequestSpec(
        "insurance_policy_big_files",
        "insurance policy",
        auto=frozenset({"ins_title_big", "ins_claims", "ins_car"}),
        possible={
            "ins_synonym": SYNONYM,
            "ins_premium": SYNONYM,
            "ins_typo_title": CONTENT,
            # Over Drive's index limits: only our own read finds them.
            "ins_big_content": CONTENT,
            "ins_big_docx": CONTENT,
        },
        never_listed=frozenset({"ins_too_big"}),
        checks=check_big_files,
    ),
    RequestSpec(
        "insurance_policy_typo",
        "insurence policy",
        auto=frozenset({"ins_typo_title"}),
        possible={
            "ins_title_big": CORRECTED,
            "ins_claims": CORRECTED,
            "ins_synonym": CORRECTED,
            "ins_premium": CORRECTED,
            "ins_car": CORRECTED,
            "ins_big_content": CONTENT,
            "ins_big_docx": CONTENT,
        },
        never_listed=frozenset({"ins_too_big"}),
    ),
    RequestSpec(
        "electricity_bill_fresh_uploads",
        "electricity bill",
        auto=frozenset({"el_title", "el_photo"}),
        possible={"el_synonym": SYNONYM, "el_fresh_content": CONTENT},
        never_listed=frozenset({"el_old"}),
        period=None,
        checks=check_fresh_uploads,
    ),
]


def assert_exact_gold(spec: RequestSpec, run: dict, all_ids: set[str]) -> list[str]:
    """Every stage invariant and the exact sets; returns known-bug mismatches."""
    assert run["shareError"] is None, run["shareError"]
    assert run["plannerCalls"] == [], "a model planner was asked"
    assert run["planSource"] == "deterministic_brain"
    assert run["status"] == "completed" and run["incompleteSearch"] is False, run["coverage"]
    coverage = run["coverage"]
    assert coverage["requestedPeriod"]["timezone"] == TIMEZONE
    assert coverage["ownerReviewRequired"] is False
    assert coverage["dateBasis"] == "title_date_then_created_then_modified"
    assert coverage["sharedFolderWalk"] == "complete", coverage
    # Every selected Drive-blind candidate is either read in full or counted
    # unread by cause; any unread one makes coverage partial (never "All
    # files sent" over a file nobody could read).
    unread = (
        coverage["contentFilesTooLarge"]
        + coverage["contentFilesUnreadable"]
        + coverage["contentFilesUnavailable"]
        + coverage["contentFilesUnsafe"]
    )
    assert unread == coverage["contentFilesSelected"] - coverage["contentFilesRead"], coverage
    assert coverage["contentFilesUnread"] == unread + coverage["contentFilesPartlyRead"]
    assert coverage["contentCheck"] == (
        "partial" if coverage["contentFilesUnread"] else "complete"
    ), coverage
    assert coverage["coveragePartial"] is bool(coverage["contentFilesUnread"]), coverage
    assert coverage["contentCheckIncomplete"] is bool(coverage["contentFilesUnread"]), coverage
    # One result per file, whichever gears found it (Drive's passes, Gear 1,
    # the walk, a shortcut, the content check).
    assert len(run["committedIds"]) == len(set(run["committedIds"])), run["committedIds"]
    # Every share went to B, once per file, with Google's email suppressed.
    assert run["postRecipients"] <= {RECIPIENT[2]}
    assert run["postNotify"] <= {"false"}
    assert all(count == 1 for count in run["posts"].values()), run["posts"]
    for batch in run["batchesAfterPayment"]:
        assert len(batch["files"]) == len(set(batch["files"]))
    frozen = [file_id for batch in run["batchesAfterPayment"] for file_id in batch["files"]]
    assert len(frozen) == len(set(frozen)), "a file was frozen into two batches"
    # Before payment nothing is approved and nothing reaches Google.
    assert not any(batch["approved"] for batch in run["batchesBeforePayment"])
    assert set(frozen) >= run["shared"]
    # Nothing readable is kept: no candidates, no extracted text.
    content_phase = run["checkpoint"].get("content_phase", {})
    assert content_phase.get("stage") == "done" and "candidates" not in content_phase
    assert MARKER not in json.dumps(run["checkpoint"], ensure_ascii=False)
    assert MARKER not in json.dumps(run["committedMetadata"], ensure_ascii=False)
    # Files Drive will not let us download are never read.
    assert not run["downloads"].get("r1_walk_restricted")

    shared = run["shared"] - spec.owner_send
    expected_shared = set(spec.auto) | set(spec.known_undershare)
    known = []
    overshared = shared - expected_shared
    undershared = expected_shared - shared
    unexplained = sorted(
        [f"shared but must not be: {file_id}" for file_id in overshared - set(spec.known_overshare)]
        + [f"not shared: {file_id}" for file_id in undershared - set(spec.known_undershare)]
    )
    assert not unexplained, unexplained
    known += [f"overshare {file_id}: {spec.known_overshare[file_id]}" for file_id in overshared]
    known += [f"undershare {file_id}: {spec.known_undershare[file_id]}" for file_id in undershared]
    # Possible matches: the exact owner-only list, labelled as A sees it.
    assert run["possible"] == spec.possible, {
        "unexpected": {k: v for k, v in run["possible"].items() if spec.possible.get(k) != v},
        "missing": {k: v for k, v in spec.possible.items() if run["possible"].get(k) != v},
    }
    assert run["possibleCount"] == len(spec.possible)
    # Never shared: every other file in the Drive got no permission at all,
    # and no possible match was ever sent without the owner's tap.
    never = all_ids - expected_shared - set(spec.known_overshare) - spec.owner_send
    assert not (run["shared"] & never), sorted(run["shared"] & never)
    assert not (run["shared"] & (set(spec.possible) - spec.owner_send))
    assert not (spec.never_listed & (run["shared"] | set(run["possible"])))
    return known


ALL_IDS = {item.id for item in synthetic_drive(datetime(2026, 10, 18, tzinfo=UTC))}


@pytest.mark.asyncio
@pytest.mark.parametrize("spec", REQUESTS, ids=[spec.key for spec in REQUESTS])
async def test_gold_request(request_bulk, sharing, monkeypatch, caplog, spec):
    caplog.set_level(logging.INFO)
    run = await run_gold_request(monkeypatch, sharing, request_bulk, spec)
    score(spec, run, ALL_IDS)
    known = assert_exact_gold(spec, run, ALL_IDS)
    run["logs"] = caplog.text
    if spec.checks is not None:
        spec.checks(run)
    # The requester never learns the owner's possible matches exist.
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await DrivePossibleMatchesStore(db=sharing.db, cipher=request_bulk.cipher).possible_matches(
            user_id="recipient", request_id=run["requestId"]
        )
    delivery = await DriveSuggestionStore(
        db=sharing.db, authority_key="synthetic-ledger-key"
    ).delivery_snapshot(user_id="recipient", request_id=run["requestId"], views=True)
    seen_by_b = json.dumps(delivery, ensure_ascii=False, default=str)
    names = {item.id: item.name for item in synthetic_drive(datetime.now(UTC))}
    assert not [
        key for key in run["possible"] if key not in spec.owner_send and names[key] in seen_by_b
    ]
    logged = caplog.text
    # Logs carry fixed codes and counts: never names, text or emails.
    assert MARKER not in logged and RECIPIENT[2] not in logged
    leaked = sorted(
        item.name
        for item in synthetic_drive(datetime.now(UTC))
        if len(item.name) >= 10 and item.name in logged
    )
    assert not leaked, leaked
    if known:
        pytest.xfail("; ".join(known))


# --- negative controls: each gear is what finds its edge case ------------------

REQUEST = {spec.key: spec for spec in REQUESTS}


@pytest.mark.asyncio
async def test_without_gear_one_a_camelcase_title_is_never_found(
    request_bulk, sharing, monkeypatch
):
    """Drive's word-prefix name search cannot see inside "RentalAgreement_..."."""
    spec = REQUEST["rental_agreement"]
    run = await run_gold_request(
        monkeypatch, sharing, request_bulk, spec, owner_index_enabled=False
    )
    assert run["status"] == "completed"
    assert run["shared"] == spec.auto - {"r2_camel"}
    assert "r2_camel" not in run["committed"]
    assert run["possible"] == spec.possible


@pytest.mark.asyncio
async def test_without_the_walk_files_only_in_shared_folders_are_never_found(
    request_bulk, sharing, monkeypatch
):
    """The walk is the only gear that reaches Priya's nested folders."""
    monkeypatch.setenv(search_module.SHARED_WALK_FLAG, "false")
    gold = REQUEST["rent_receipts"]
    spec = RequestSpec("rent_receipts_no_walk", gold.phrase, gold.auto, gold.possible)
    run = await run_gold_request(monkeypatch, sharing, request_bulk, spec)
    walked = {"r1_walk_title", "r1_walk_hybrid", "r1_walk_xlsx", "r1_walk_viewer"}
    assert not walked & run["committed"]
    # A's own receipt filed in Priya's folder is still in Google's user corpus.
    unchanged = gold.auto - {"r1_walk_title"} | set(gold.between)
    assert run["shared"] - set(gold.known_overshare) == unchanged
    assert run["possible"] == {
        key: kind for key, kind in gold.possible.items() if key not in walked
    }
    # A walk the operator switched off is reported as partial coverage.
    assert run["coverage"]["sharedFolderWalk"] == "disabled"
    assert run["coverage"]["coveragePartial"] is True


@pytest.mark.asyncio
async def test_without_the_content_check_big_and_fresh_files_are_never_listed(
    request_bulk, sharing, monkeypatch
):
    """Only our own read sees inside a PDF over Google's 30 MB index limit."""
    spec = REQUEST["insurance_policy_big_files"]
    run = await run_gold_request(
        monkeypatch, sharing, request_bulk, spec, content_check_enabled=False
    )
    assert run["shared"] == spec.auto
    assert run["possible"] == {
        key: kind
        for key, kind in spec.possible.items()
        if key not in {"ins_big_content", "ins_big_docx"}
    }
    assert not run["downloads"] and run["coverage"]["contentCheck"] == "disabled"


@pytest.mark.asyncio
async def test_a_rate_limit_storm_past_six_attempts_fails_the_search_closed(
    request_bulk, sharing, monkeypatch
):
    """Six retryable failures in a row: the search fails; it never completes partially."""

    def content_pass(method, path, params):
        return path == "/files" and query_has_full_text_term(params.get("q", ""))

    gold = REQUEST["rental_agreement"]
    spec = RequestSpec(
        "rental_agreement_storm",
        gold.phrase,
        gold.auto,
        gold.possible,
        faults=lambda: [rate_limited_429("storm", content_pass, retry_after="1", times=6)],
    )
    run = await run_gold_request(monkeypatch, sharing, request_bulk, spec)
    assert run["servedFaults"] == ["storm"] * 6
    assert len(run["deferrals"]) == 5  # five backoffs, then the sixth failure is final
    assert run["status"] == "failed"
    # Fails closed: paid or not, a failed search releases no batch and lists
    # nothing for the owner to send.
    assert run["shareError"] == "search_incomplete"
    assert run["shared"] == set() and run["possible"] == {}


@pytest.mark.asyncio
async def test_drive_blind_files_left_unread_are_reported_as_partial_coverage(
    request_bulk, sharing, monkeypatch
):
    """_end_content's own contract: Drive-blind candidates left unread make coverage partial."""
    spec = REQUEST["insurance_policy_big_files"]
    run = await run_gold_request(monkeypatch, sharing, request_bulk, spec)
    coverage = run["coverage"]
    # The walked export-capped Google Doc and the 40 MB scan archive were
    # selected as Drive-blind and never read. (The 45 MB policy schedule names
    # the request in its title: it is shared on that evidence, never a content
    # candidate here; the rent request counts all three.)
    assert coverage["contentFilesSelected"] - coverage["contentFilesRead"] == 2
    assert coverage["contentFilesTooLarge"] == 2 and coverage["contentFilesUnread"] >= 2
    assert coverage["coveragePartial"] is True and coverage["contentCheckIncomplete"] is True
    assert coverage["contentCheck"] == "partial"
    # Partial coverage changes B's copy only: every exact set still holds.
    assert run["shared"] == spec.auto and run["possible"] == spec.possible


@pytest.mark.asyncio
async def test_a_request_whose_candidates_are_all_read_keeps_full_coverage(
    request_bulk, sharing, monkeypatch
):
    """Negative control: fresh uploads read in full leave coverage complete."""
    spec = REQUEST["electricity_bill_fresh_uploads"]
    run = await run_gold_request(monkeypatch, sharing, request_bulk, spec)
    coverage = run["coverage"]
    assert coverage["contentFilesRead"] == coverage["contentFilesSelected"] >= 1
    assert coverage["contentFilesUnread"] == 0
    assert coverage["contentCheck"] == "complete" and coverage["coveragePartial"] is False


def test_gold_summary_has_no_unexplained_false_shares():
    """Totals over every gold request run in this session (pytest -s prints them)."""
    if len(GOLD_METRICS) < len(REQUESTS):
        pytest.skip("runs after the gold requests")
    totals = Counter()
    for metrics in GOLD_METRICS.values():
        totals["autoShared"] += metrics["autoShared"]
        totals["autoExpected"] += metrics["autoExpected"]
        totals["autoTrue"] += metrics["autoShared"] - len(metrics["falseShares"])
        totals["falseShares"] += len(metrics["falseShares"])
        totals["missedShares"] += len(metrics["missedShares"])
        totals["possibleExpected"] += metrics["possibleExpected"]
        totals["possibleFound"] += round(metrics["possibleRecall"] * metrics["possibleExpected"])
    summary = {
        "requests": len(GOLD_METRICS),
        "autoSharePrecision": round(totals["autoTrue"] / totals["autoShared"], 4),
        "autoShareRecall": round(totals["autoTrue"] / totals["autoExpected"], 4),
        "possibleMatchRecall": round(totals["possibleFound"] / totals["possibleExpected"], 4),
        **totals,
    }
    print("GOLD_SUMMARY " + json.dumps(summary, sort_keys=True))
    known = {
        file_id for spec in REQUESTS for file_id in (*spec.known_overshare, *spec.known_undershare)
    }
    unexplained = {
        key: sorted(set(metrics["falseShares"] + metrics["missedShares"]) - known)
        for key, metrics in GOLD_METRICS.items()
        if set(metrics["falseShares"] + metrics["missedShares"]) - known
    }
    assert not unexplained, unexplained
    # No known product bug is left: every automatic share is exact.
    assert (totals["falseShares"], totals["missedShares"]) == (0, 0), totals
