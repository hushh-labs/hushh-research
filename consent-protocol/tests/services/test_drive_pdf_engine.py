"""The pypdfium2 PDF engine and the request-time content check leaf.

Synthetic fixtures only (tests/services/drive_pdf_fixtures.py). OCR is a
recording fake unless a local Tesseract is installed, so routing (which pages
are OCRed, at what resolution) is proven without the engine binary.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest

from hushh_mcp.services import drive_content_check_leaf as leaf
from hushh_mcp.services import drive_document_pages as pages_lane
from hushh_mcp.services import drive_pdf_engine as engine
from hushh_mcp.services.drive_document_parser import ParseError, parse_document
from tests.services import drive_pdf_fixtures as fx

HINDI_LINES = ["हिंदी बैंक स्टेटमेंट", "खाता संख्या 12345678", "अवधि 01/09/2026 - 30/09/2026"]
OCR_TEXT = (
    "Scanned HDFC statement\nStatement period 01 Sep 2026 - 30 Sep 2026\n"
    "account holder branch narration closing balance"
)


class RecordingOcr:
    def __init__(self, text: str = OCR_TEXT, words: int = 15, confidence: float = 92.0):
        self.calls: list[bytes] = []
        self.text, self.words, self.confidence = text, words, confidence

    def __call__(self, payload: bytes):
        self.calls.append(payload)
        return self.text, {
            "ocr_mean_word_confidence": self.confidence,
            "ocr_word_count": self.words,
            "ocr_languages": "eng",
        }


def png_size(payload: bytes) -> tuple[int, int]:
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
    return int.from_bytes(payload[16:20], "big"), int.from_bytes(payload[20:24], "big")


# --- engine: one engine, per-page OCR routing --------------------------------


def test_digital_pdf_reads_text_layer_without_ocr():
    ocr = RecordingOcr()
    pages, total = engine.extract_pdf_pages(
        fx.text_pdf(fx.statement_lines()), ocr=ocr, max_ocr_pages=3
    )
    assert total == 1 and ocr.calls == []
    assert pages[0].status == "extracted" and pages[0].method == "native_text"
    assert "INV_2026_HDFC_9981" in pages[0].text


def test_scanned_page_is_ocred_at_300_dpi_inside_the_pixel_cap():
    ocr = RecordingOcr()
    pages, _ = engine.extract_pdf_pages(fx.scanned_page_pdf(), ocr=ocr, max_ocr_pages=3)
    assert len(ocr.calls) == 1
    assert pages[0].method == "ocr" and pages[0].status == "extracted"
    assert pages[0].ocr_reason == "no_text"
    assert pages[0].quality["render_dpi"] == engine.MAX_RENDER_DPI
    width, height = png_size(ocr.calls[0])
    assert width * height == pages[0].quality["render_pixels"] <= engine.MAX_RENDER_PIXELS
    # Negative control: without OCR the scan is an explicit gap, never "blank".
    unread, _ = engine.extract_pdf_pages(fx.scanned_page_pdf())
    assert unread[0].status == "unreadable" and unread[0].error_code == "ocr_not_run"


def test_oversized_page_lowers_dpi_but_never_below_the_floor():
    import pypdfium2

    document = pypdfium2.PdfDocument(fx.scanned_page_pdf())
    page = document[0]
    try:
        page.set_mediabox(0, 0, 918, 1188)  # 1.5x Letter: 300 DPI would pass 12 MP
        payload, dpi, pixels = engine.render_png(page)
        assert engine.MIN_RENDER_DPI <= dpi < engine.MAX_RENDER_DPI
        assert pixels <= engine.MAX_RENDER_PIXELS
        assert png_size(payload)[0] * png_size(payload)[1] == pixels
        page.set_mediabox(0, 0, 1836, 2376)  # 3x Letter: cannot fit even at 150 DPI
        with pytest.raises(engine.PdfEngineError, match="^page_render_budget_exceeded$"):
            engine.render_png(page)
    finally:
        page.close()
        document.close()


def test_hybrid_pdf_ocrs_only_the_scanned_page():
    ocr = RecordingOcr()
    hybrid = fx.joined_pdf(fx.text_pdf(fx.statement_lines()), fx.scanned_page_pdf())
    pages, total = engine.extract_pdf_pages(hybrid, ocr=ocr, max_ocr_pages=3)
    assert total == 2 and len(ocr.calls) == 1
    assert [(page.method, page.status) for page in pages] == [
        ("native_text", "extracted"),
        ("ocr", "extracted"),
    ]


def test_good_invisible_ocr_layer_is_reused_and_a_thin_one_is_ocred_again():
    ocr = RecordingOcr()
    pages, _ = engine.extract_pdf_pages(
        fx.ocr_layer_pdf(fx.statement_lines()), ocr=ocr, max_ocr_pages=3
    )
    assert ocr.calls == [] and pages[0].method == "ocr_layer"
    assert "HDFC Bank account statement" in pages[0].text
    # Negative control: a scanner layer too thin to trust is replaced by OCR.
    thin, _ = engine.extract_pdf_pages(fx.ocr_layer_pdf(["p1"]), ocr=ocr, max_ocr_pages=3)
    assert len(ocr.calls) == 1 and thin[0].method == "ocr"
    assert thin[0].ocr_reason == "short_text"


def test_large_image_area_adds_ocr_to_a_real_text_layer():
    ocr = RecordingOcr()
    pages, _ = engine.extract_pdf_pages(
        fx.image_banner_pdf(fx.statement_lines()), ocr=ocr, max_ocr_pages=3
    )
    assert len(ocr.calls) == 1
    assert pages[0].method == "native_text+ocr" and pages[0].ocr_reason == "image_area"
    assert "INV_2026_HDFC_9981" in pages[0].text and "Scanned HDFC statement" in pages[0].text


def test_ocr_page_budget_and_weak_ocr_are_explicit_gaps():
    ocr = RecordingOcr()
    scans = fx.joined_pdf(*(fx.scanned_page_pdf() for _ in range(3)))
    pages, _ = engine.extract_pdf_pages(scans, ocr=ocr, max_ocr_pages=1)
    assert len(ocr.calls) == 1
    assert [page.error_code for page in pages] == [
        None,
        "ocr_budget_exhausted",
        "ocr_budget_exhausted",
    ]
    weak, _ = engine.extract_pdf_pages(
        fx.scanned_page_pdf(), ocr=RecordingOcr(words=3), max_ocr_pages=1
    )
    assert weak[0].status == "partial" and weak[0].error_code == "ocr_insufficient_text"


def test_garbled_text_layer_is_never_kept_as_evidence():
    layout = engine.PageLayout(objects=1, image_ratio=0.0, text_objects=1, invisible_text_objects=0)
    garbage = "� statement"
    assert engine.ocr_reason(garbage, layout) == "garbled_text"
    assert engine.ocr_reason("A readable statement for September 2026 here", layout) is None


def test_one_damaged_page_is_unreadable_and_the_rest_extract():
    damaged = fx.broken_middle_page_pdf()
    pages, total = engine.extract_pdf_pages(damaged)
    assert total == 3
    assert [(page.number, page.status) for page in pages] == [
        (1, "extracted"),
        (2, "unreadable"),
        (3, "extracted"),
    ]
    assert pages[1].error_code == "page_unreadable"
    # Negative control: the previous pdfplumber engine fails the whole file.
    with pytest.raises(ParseError, match="^invalid_document$"):
        pages_lane.extract_pages(damaged, "application/pdf")


def test_owner_password_pdf_opens_and_user_password_pdf_is_encrypted():
    owner_only = fx.encrypted_pdf(
        user_password=b"", owner_password=b"owner-secret", lines=fx.statement_lines()
    )
    pages, _ = engine.extract_pdf_pages(owner_only)
    assert "HDFC Bank account statement" in pages[0].text
    # Negative control: the previous engine refused every encrypted PDF.
    with pytest.raises(ParseError, match="^encrypted_document$"):
        pages_lane.extract_pages(owner_only, "application/pdf")
    locked = fx.encrypted_pdf(
        user_password=b"user-secret", owner_password=b"owner-secret", lines=["x"]
    )
    with pytest.raises(engine.PdfEngineError, match="^encrypted_document$"):
        engine.extract_pdf_pages(locked)


@pytest.mark.parametrize(
    "content",
    [b"not a pdf", b"%PDF-1.4\n garbage garbage", b"%PDF-1.7\n" + bytes(range(256)) * 20],
)
def test_corrupt_or_foreign_bytes_are_invalid_document(content):
    with pytest.raises(engine.PdfEngineError, match="^invalid_document$"):
        engine.extract_pdf_pages(content)


def test_devanagari_text_layer_is_extracted_intact():
    pages, _ = engine.extract_pdf_pages(fx.devanagari_pdf(HINDI_LINES))
    assert unicodedata.normalize("NFC", pages[0].text) == "\n".join(HINDI_LINES)


# --- compatibility parser (live reads, selected lane): same engine, no OCR ----


def test_compat_parser_uses_the_engine_for_owner_password_and_damaged_pdfs():
    owner_only = fx.encrypted_pdf(
        user_password=b"", owner_password=b"owner-secret", lines=fx.statement_lines()
    )
    assert "HDFC Bank account statement" in parse_document(owner_only, "application/pdf").pages[0]
    damaged = parse_document(fx.broken_middle_page_pdf(), "application/pdf")
    assert damaged.truncated and len(damaged.pages) == 3
    assert "Page three" in damaged.pages[2] and damaged.pages[1] == ""
    with pytest.raises(ParseError, match="^encrypted_document$"):
        parse_document(
            fx.encrypted_pdf(user_password=b"u", owner_password=b"o", lines=["x"]),
            "application/pdf",
        )


def test_compat_parser_never_loads_a_page_past_its_page_cap(monkeypatch):
    import pypdfium2

    loaded: list[int] = []
    original = pypdfium2.PdfDocument.__getitem__

    def spy(self, index):
        loaded.append(index)
        return original(self, index)

    monkeypatch.setattr(pypdfium2.PdfDocument, "__getitem__", spy)
    long_pdf = fx.text_pdf(*([f"Page {number} statement text"] for number in range(1, 103)))
    parsed = parse_document(long_pdf, "application/pdf")
    assert parsed.truncated and len(parsed.pages) == 100
    assert max(loaded) == 99 and len(loaded) == 100


# --- content check leaf: matching, dates, budgets, no text out ----------------


def test_hindi_title_words_stay_whole_and_near_misses_do_not_match():
    assert leaf.content_words("हिंदी बैंक स्टेटमेंट.pdf") == ["हिंदी", "बैंक", "स्टेटमेंट", "pdf"]
    matcher = leaf.ConceptMatcher([["बैंक स्टेटमेंट"], ["बैंक"]])
    matcher.feed("हिंदी बैंकिंग सेवा", final=True)
    assert matcher.matched == set()  # a longer word is not the word
    matcher.feed("मेरा बैंक स्टेटमेंट", final=True)
    assert matcher.matched == {0, 1}


@pytest.mark.parametrize(
    "written", ["INV_2026_HDFC_9981", "INV-2026-HDFC-9981", "inv2026hdfc9981", "INV 2026 HDFC 9981"]
)
def test_codes_match_however_they_are_joined(written):
    matcher = leaf.ConceptMatcher([["INV 2026 HDFC 9981"], ["INV_2026_HDFC_9982"]])
    matcher.feed(f"Reference: {written}.", final=True)
    assert matcher.matched == {0}


def test_whole_words_only_accents_fold_and_digits_fold():
    matcher = leaf.ConceptMatcher([["rent"], ["resume"], ["2026"]])
    matcher.feed("Parental rental Résumé ২০২৬", final=True)  # Bengali digits 2026
    assert matcher.matched == {1, 2}


def test_phrases_match_across_chunk_and_page_boundaries():
    matcher = leaf.ConceptMatcher([["bank statement"], ["salary slip"]])
    matcher.feed("closing ba")
    matcher.feed("nk")
    matcher.feed(" statement for")
    matcher.boundary()
    matcher.feed("salary\n")
    matcher.feed("slip", final=True)
    assert matcher.matched == {0, 1}


def test_header_dates_come_from_the_first_dated_line_only():
    text = "HDFC Bank\nPeriod: ०१/०९/२०२६ - ३०/०९/२०२६\nDue 15 Nov 2026"
    readings = leaf.header_readings(text)
    assert [reading[0] for reading in readings] == ["either", "day"]
    assert readings[1] == ["day", 2026, 9, 30, -1, -1, ""]
    # The later "Due 15 Nov 2026" line never decides the document's date.
    assert ["day", 2026, 11, 15, -1, -1, ""] not in readings


def test_leaf_returns_matches_and_dates_but_never_text():
    secret = "ZETA-PRIVATE-MARKER"
    content = fx.text_pdf(fx.statement_lines() + [f"Holder note {secret} 4242"])
    result = leaf.check(
        content,
        "application/pdf",
        [["hdfc"], ["statement", "statements"], ["INV 2026 HDFC 9981"], ["absent word"]],
        max_text_pages=10,
        max_ocr_pages=0,
    )
    assert result["matched"] == [0, 1, 2]
    assert result["dates"][0] == ["day", 2026, 9, 1, -1, -1, ""]
    assert result["complete"] is True
    serialized = json.dumps(result)
    assert secret not in serialized and "Holder" not in serialized and "HDFC" not in serialized


def test_leaf_stops_reading_once_every_concept_and_the_header_are_known():
    ocr = RecordingOcr()
    # Page one alone holds both concepts and more than the 2,048-character header.
    long_text = ["HDFC statement"] + [
        f"Line {number} narration and value date detail text for the account"
        for number in range(45)
    ]
    content = fx.joined_pdf(fx.text_pdf(long_text), *(fx.scanned_page_pdf() for _ in range(3)))
    result = leaf.check(
        content,
        "application/pdf",
        [["hdfc"], ["statement"]],
        max_text_pages=10,
        max_ocr_pages=3,
        ocr=ocr,
    )
    assert result["matched"] == [0, 1] and result["pages_read"] == 1
    assert result["complete"] is True and ocr.calls == []


def test_leaf_text_budget_and_page_budget_mark_incomplete(monkeypatch):
    content = fx.text_pdf(["alpha words " * 20], ["bravo words " * 20], ["HDFC statement"])
    limited = leaf.check(content, "application/pdf", [["hdfc"]], max_text_pages=2, max_ocr_pages=0)
    assert limited["matched"] == [] and limited["complete"] is False
    assert limited["pages_read"] == 2 and limited["total_pages"] == 3
    monkeypatch.setattr(leaf, "MAX_MATCH_CHARS", 50)
    budget = leaf.check(content, "application/pdf", [["hdfc"]], max_text_pages=3, max_ocr_pages=0)
    assert budget["matched"] == [] and budget["complete"] is False


def test_leaf_docx_keeps_tabs_reads_headers_and_skips_embedded_charts():
    body = fx.docx_paragraphs(
        b"<w:r><w:t>Account No.</w:t><w:tab/><w:t>INV_2026_HDFC_9981</w:t></w:r>"
    )
    header = (
        b"<w:hdr "
        + fx.W
        + b"><w:p><w:r><w:t>Statement period 01 Sep 2026</w:t></w:r></w:p></w:hdr>"
    )
    content = fx.docx(
        body, extra={"word/header1.xml": header, "word/embeddings/chart1.xlsx": b"binary"}
    )
    result = leaf.check(
        content,
        leaf.DOCX,
        [["account no"], ["INV 2026 HDFC 9981"], ["statement period"]],
        max_text_pages=1,
        max_ocr_pages=0,
    )
    assert result["matched"] == [0, 1, 2]
    assert result["dates"] == [["day", 2026, 9, 1, -1, -1, ""]]
    # Negative control: the compatibility reader rejects the embedded chart.
    with pytest.raises(ParseError, match="^invalid_document$"):
        parse_document(content, leaf.DOCX)


def test_leaf_docx_part_budget_stops_a_zip_bomb(monkeypatch):
    monkeypatch.setattr(leaf, "MAX_DOCX_PART_BYTES", 4096)
    bomb = fx.docx(fx.docx_paragraphs(b"<w:r><w:t>" + b"A" * 200_000 + b"</w:t></w:r>"))
    assert len(bomb) < 4096
    with pytest.raises(leaf.CheckError, match="^file_too_large$"):
        leaf.check(bomb, leaf.DOCX, [["a"]], max_text_pages=1, max_ocr_pages=0)


def test_leaf_reads_big_plain_text_beyond_the_compat_cap():
    # Devanagari narration: over the 4 MiB compat cap in bytes, inside the text budget.
    big = ("लेनदेन " * 230_000 + "HDFC statement INV_2026_HDFC_9981").encode()
    assert len(big) > 4 * 1024 * 1024
    result = leaf.check(
        big, "text/plain", [["hdfc"], ["INV 2026 HDFC 9981"]], max_text_pages=1, max_ocr_pages=0
    )
    assert result["matched"] == [0, 1]


def test_leaf_image_is_ocred_and_without_ocr_is_a_gap():
    ocr = RecordingOcr()
    image = fx.png_image(["HDFC statement"])
    result = leaf.check(image, "image/png", [["hdfc"]], max_text_pages=1, max_ocr_pages=1, ocr=ocr)
    assert len(ocr.calls) == 1 and result["matched"] == [0]
    gap = leaf.check(image, "image/png", [["hdfc"]], max_text_pages=1, max_ocr_pages=0, ocr=ocr)
    assert len(ocr.calls) == 1 and gap["gaps"] == 1 and gap["complete"] is False


@pytest.mark.parametrize(
    "mime,code",
    [("application/zip", "unsupported_format"), ("application/pdf", "invalid_document")],
)
def test_leaf_safe_errors(mime, code):
    with pytest.raises(leaf.CheckError, match=f"^{code}$"):
        leaf.check(b"PRIVATE bytes", mime, [["x"]], max_text_pages=1, max_ocr_pages=0)


def test_leaf_child_runs_without_hushh_mcp_or_credentials(tmp_path):
    services = Path(leaf.__file__).resolve().parent
    code = (
        "import os, sys\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "import drive_content_check_leaf, drive_pdf_engine\n"
        "assert 'hushh_mcp' not in sys.modules\n"
        "assert 'google.genai' not in sys.modules and 'vertexai' not in sys.modules\n"
        "print('isolated')\n"
    )
    result = subprocess.run(  # noqa: S603 - authored probe, synthetic input only
        [sys.executable, "-c", code, str(services)],
        capture_output=True,
        text=True,
        timeout=30,
        env={"PATH": os.defpath, "PYTHON_DOTENV_DISABLED": "1"},
    )
    assert result.returncode == 0, result.stderr[-500:]
    assert result.stdout.strip() == "isolated"


def test_real_tesseract_reads_a_scanned_page_when_installed(monkeypatch):
    binary = os.environ.get("DRIVE_TEST_TESSERACT_BINARY", engine.TESSERACT_BINARY)
    if not Path(binary).is_file():
        pytest.skip("local Tesseract engine not installed; the worker image installs it")
    monkeypatch.setattr(engine, "TESSERACT_BINARY", binary)
    pages, _ = engine.extract_pdf_pages(
        fx.scanned_page_pdf(["Scanned HDFC statement", "Account 12345678"]),
        ocr=engine.ocr_png,
        max_ocr_pages=1,
    )
    assert pages[0].method == "ocr" and "12345678" in pages[0].text
