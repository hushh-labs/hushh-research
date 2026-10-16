"""Production parser/process boundaries with synthetic private documents."""

from __future__ import annotations

import io
import os
import subprocess
import sys
import time
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.drive_document_parser import (
    DOCX,
    MAX_INPUT_BYTES,
    MAX_TEXT_BYTES,
    ParsedText,
    ParseError,
    parse_document,
)
from hushh_mcp.services.drive_document_processor import (
    ClamAvScanner,
    IsolatedDocumentParser,
    LocalDocumentProcessor,
    PrivateDocumentEmbedding,
    _private_process,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError


def scanned_pdf(*, resolution=200) -> bytes:
    """Original raster PDF fixture: no pre-extracted text or embedded text layer."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1600, 550), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=48)
    for number, line in enumerate(
        ("Charles Schwab statement", "Account 12345678", "September 1, 2026 - September 30, 2026")
    ):
        draw.text((40, 50 + number * 100), line, fill="black", font=font)
    output = io.BytesIO()
    image.save(output, format="PDF", resolution=resolution)
    return output.getvalue()


def scanned_image(*, image_format="PNG") -> bytes:
    """Original raster document, without a prepared text layer."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1600, 550), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=48)
    for number, line in enumerate(
        ("Charles Schwab statement", "Account 12345678", "September 1, 2026 - September 30, 2026")
    ):
        draw.text((40, 50 + number * 100), line, fill="black", font=font)
    output = io.BytesIO()
    image.save(output, format=image_format)
    return output.getvalue()


@pytest.mark.parametrize("image_format,mime_type", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_original_image_ocr_unavailable_is_explicit_gap(monkeypatch, image_format, mime_type):
    from hushh_mcp.services import drive_document_pages as pages

    monkeypatch.setattr(pages, "TESSERACT_BINARY", "/nonexistent/tesseract")
    original = scanned_image(image_format=image_format)
    result = pages.extract_pages(original, mime_type)
    assert result.complete and result.has_gaps and result.total_pages == 1
    assert result.pages[0].method == "ocr"
    assert result.pages[0].status == "unreadable"
    assert result.pages[0].error_code == "ocr_unavailable"


def test_original_image_ocr_reads_source_when_engine_available(monkeypatch):
    from hushh_mcp.services import drive_document_pages as pages

    binary = os.environ.get("DRIVE_TEST_TESSERACT_BINARY", "/usr/bin/tesseract")
    if not Path(binary).is_file():
        pytest.skip("local Tesseract engine not installed; image build installs it")
    monkeypatch.setattr(pages, "TESSERACT_BINARY", binary)
    result = pages.extract_pages(scanned_image(), "image/png")
    assert result.complete and not result.has_gaps
    assert result.pages[0].method == "ocr"
    assert "Charles Schwab" in result.pages[0].text
    assert "12345678" in result.pages[0].text
    assert "September 30, 2026" in result.pages[0].text


def joined_pdf(*sources: bytes) -> bytes:
    import pypdfium2

    target = pypdfium2.PdfDocument.new()
    try:
        for source in sources:
            with pypdfium2.PdfDocument(source) as document:
                target.import_pages(document)
        output = io.BytesIO()
        target.save(output)
        return output.getvalue()
    finally:
        target.close()


def test_mixed_original_pdf_cannot_hide_unreadable_scanned_page(monkeypatch):
    from hushh_mcp.services import drive_document_pages as pages

    original = joined_pdf(pdf(), scanned_pdf())
    assert parse_document(original, "application/pdf").truncated
    monkeypatch.setattr(pages, "TESSERACT_BINARY", "/nonexistent/tesseract")
    result = pages.extract_pages(original, "application/pdf")
    assert result.complete and result.has_gaps
    assert result.pages[0].status == "extracted"
    assert result.pages[1].status == "unreadable"
    assert result.pages[1].error_code == "ocr_unavailable"


def test_real_original_scanned_pdf_ocr_and_engine_provenance(monkeypatch, record_property):
    from hushh_mcp.services import drive_document_pages as pages

    binary = os.environ.get("DRIVE_TEST_TESSERACT_BINARY", "/usr/bin/tesseract")
    if not Path(binary).is_file():
        pytest.skip("local Tesseract engine not installed; image build installs it")
    monkeypatch.setattr(pages, "TESSERACT_BINARY", binary)
    data = os.environ.get("DRIVE_TEST_TESSDATA_FILE")
    if data:
        monkeypatch.setattr(pages, "TESSDATA_FILE", data)
    original = scanned_pdf()
    started = time.monotonic()
    result = pages.extract_pages(original, "application/pdf")
    elapsed = time.monotonic() - started
    record_property("original_pdf_bytes", len(original))
    record_property("extraction_seconds", round(elapsed, 3))
    assert result.complete and not result.has_gaps
    assert result.pages[0].method == "ocr"
    assert result.pages[0].page_number == 1
    assert "Charles Schwab" in result.pages[0].text
    assert "12345678" in result.pages[0].text
    assert "September 30, 2026" in result.pages[0].text
    assert result.engine_versions["tesseract"].startswith("tesseract 5.")
    assert len(result.engine_versions["tesseract_eng_sha256"]) == 64
    # Oversized page geometry previously failed before OCR even though a
    # modest DPI reduction retains the original image's account and period.
    oversized = pages.extract_pages(scanned_pdf(resolution=45), "application/pdf")
    assert oversized.complete and not oversized.has_gaps
    assert "12345678" in oversized.pages[0].text
    assert "September 30, 2026" in oversized.pages[0].text
    assert pages.MIN_RENDER_DPI <= oversized.pages[0].quality["render_dpi"] < 200
    assert oversized.pages[0].quality["render_pixels"] <= pages.MAX_RENDER_PIXELS
    # Original image-only PDFs beyond both former limits retain a resumable
    # cursor and actual page positions; never materialize every rendered page.
    long_original = joined_pdf(*(original for _ in range(110)))
    assert len(long_original) > MAX_INPUT_BYTES
    tail = pages.extract_pages(long_original, "application/pdf", start_page=109)
    assert tail.total_pages == 110 and tail.complete and not tail.has_gaps
    assert [page.page_number for page in tail.pages] == [109, 110]
    assert all("12345678" in page.text for page in tail.pages)


def test_oversized_pdf_keeps_gap_when_readable_render_cannot_fit():
    from hushh_mcp.services import drive_document_pages as pages

    result = pages.extract_pages(scanned_pdf(resolution=5), "application/pdf")
    assert result.complete and result.has_gaps
    assert result.pages[0].status == "unreadable"
    assert result.pages[0].error_code == "page_render_budget_exceeded"


def test_original_long_pdf_has_explicit_cursor_and_reaches_page_101():
    from hushh_mcp.services.drive_document_pages import extract_pages

    original = joined_pdf(*(pdf() for _ in range(102)))
    first = extract_pages(original, "application/pdf")
    assert [page.page_number for page in first.pages] == [1, 2, 3, 4]
    assert first.next_page == 5 and first.total_pages == 102 and not first.complete
    tail = extract_pages(original, "application/pdf", start_page=100)
    assert [page.page_number for page in tail.pages] == [100, 101, 102]
    assert tail.complete and tail.next_page is None and not tail.has_gaps
    assert "January 2026" in tail.pages[-1].text


def test_long_unicode_text_resumes_without_silent_compatibility_limit_loss():
    from hushh_mcp.services.drive_document_pages import extract_pages

    original_text = "Schwab September ₹ statement\n" * 20000
    content = original_text.encode()
    extracted, cursor = [], 1
    while cursor is not None:
        result = extract_pages(content, "text/plain", start_page=cursor)
        assert not result.has_gaps and result.unit_kind == "text_segment"
        extracted.extend(page.text for page in result.pages)
        cursor = result.next_page
    assert "".join(extracted) == original_text


def docx(xml: bytes, *, extra=None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
        for name, body in (extra or {}).items():
            archive.writestr(name, body)
    return output.getvalue()


def pdf() -> bytes:
    stream = b"BT /F1 12 Tf 40 100 Td (Synthetic bank statement January 2026) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    payload = b"%PDF-1.4\n"
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(payload))
        payload += str(number).encode() + b" 0 obj\n" + value + b"\nendobj\n"
    xref = len(payload)
    payload += b"xref\n0 6\n0000000000 65535 f \n"
    payload += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    return payload + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()


def test_real_pdf_and_docx_text_extraction():
    parsed = parse_document(pdf(), "application/pdf")
    assert parsed.pages == ("Synthetic bank statement January 2026",)
    assert not parsed.truncated
    content = docx(
        b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Private statement</w:t></w:r></w:p></w:body></w:document>'
    )
    assert parse_document(content, DOCX).pages == ("Private statement",)


@pytest.mark.asyncio
async def test_private_embedding_child_caps_native_threads_and_drops_parent_environment(
    monkeypatch,
):
    import asyncio

    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "synthetic-secret-path")
    process = SimpleNamespace(
        stdin=SimpleNamespace(write=lambda _: None, drain=AsyncMock(), close=lambda: None),
        stdout=SimpleNamespace(read=AsyncMock(side_effect=[b"{}", b""])),
        returncode=0,
        wait=AsyncMock(),
    )
    create = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)

    assert await _private_process("embedding", "query", b"{}", timeout=45, limit=64) == {}
    child_env = create.await_args.kwargs["env"]
    assert {
        name: child_env[name]
        for name in (
            "OMP_NUM_THREADS",
            "MKL_NUM_THREADS",
            "OPENBLAS_NUM_THREADS",
            "NUMEXPR_NUM_THREADS",
        )
    } == dict.fromkeys(
        ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"), "1"
    )
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in child_env


@pytest.mark.asyncio
@pytest.mark.parametrize("deadline_owner", ["child", "startup"])
async def test_private_child_is_reaped_and_input_drained_after_timeout(monkeypatch, deadline_owner):
    import asyncio

    writer_cancelled = asyncio.Event()

    async def blocked_input():
        try:
            await asyncio.Event().wait()
        finally:
            writer_cancelled.set()

    async def blocked_output(_limit):
        await asyncio.Event().wait()

    process = SimpleNamespace(
        stdin=SimpleNamespace(write=Mock(), drain=blocked_input, close=Mock()),
        stdout=SimpleNamespace(read=blocked_output),
        returncode=None,
        kill=Mock(),
        wait=AsyncMock(),
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    if deadline_owner == "child":
        with pytest.raises(DriveReadError, match="^processing_timeout$") as error:
            await _private_process("embedding", "query", b"{}", timeout=0.01, limit=64)
        assert error.value.retryable
    else:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.01):
                await _private_process("embedding", "query", b"{}", timeout=100, limit=64)
    process.kill.assert_called_once()
    process.wait.assert_awaited_once()
    assert writer_cancelled.is_set()


def test_private_children_do_not_reload_dotenv_credentials(tmp_path):
    fixture = tmp_path / "synthetic.env"
    fixture.write_text("SYNTHETIC_PRIVATE_CHILD_SECRET=not-a-real-credential\n")
    code = """
import os, sys, dotenv
real = dotenv.load_dotenv
dotenv.load_dotenv = lambda *a, **k: real(sys.argv[1], override=False)
sys.path.insert(0, sys.argv[2])
import drive_document_parser
import drive_document_embedding
assert 'hushh_mcp' not in sys.modules
assert 'SYNTHETIC_PRIVATE_CHILD_SECRET' not in os.environ
print('isolated')
"""
    result = subprocess.run(  # noqa: S603 - authored probe, synthetic input only
        [
            sys.executable,
            "-c",
            code,
            str(fixture),
            str(Path(__file__).resolve().parents[2] / "hushh_mcp/services"),
        ],  # noqa: S603 - authored probe and synthetic dotenv only
        capture_output=True,
        text=True,
        timeout=20,
        env={"PATH": os.defpath, "PYTHON_DOTENV_DISABLED": "1"},
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "isolated"


def test_pdf_only_extracts_bounded_pages(monkeypatch):
    from pdfminer.pdfpage import PDFPage
    from pdfplumber.page import Page

    original = PDFPage.create_pages
    enumerated = []
    extracted = []

    def pages(doc):
        first = next(original(doc))
        for number in range(10000):
            enumerated.append(number)
            yield first

    monkeypatch.setattr(PDFPage, "create_pages", pages)
    monkeypatch.setattr(
        Page, "extract_text", lambda page: extracted.append(page.page_number) or "synthetic"
    )
    parsed = parse_document(pdf(), "application/pdf")
    assert parsed.truncated
    assert len(parsed.pages) == len(extracted) == 100
    assert len(enumerated) == 101


@pytest.mark.parametrize(
    "content,mime,code",
    [
        pytest.param(b"", "text/plain", "no_extractable_text", id="empty-text"),
        pytest.param(b"\xff", "text/plain", "invalid_document", id="invalid-utf8"),
        pytest.param(b" \n\t", "text/plain", "no_extractable_text", id="whitespace"),
        pytest.param(b"not-pdf", "application/pdf", "invalid_document", id="invalid-pdf"),
        pytest.param(b"MZ", "application/x-msdownload", "unsupported_format", id="unsupported"),
        pytest.param(
            b"x" * (MAX_INPUT_BYTES + 1),
            "text/plain",
            "file_too_large",
            id="oversized-text",
        ),
    ],
)
def test_safe_parser_errors(content, mime, code):
    with pytest.raises(ParseError, match=f"^{code}$"):
        parse_document(content, mime)


def test_utf8_truncation_is_explicit_and_valid():
    parsed = parse_document(("₹" * MAX_TEXT_BYTES).encode(), "text/markdown")
    assert parsed.truncated
    assert len(parsed.pages[0].encode()) <= MAX_TEXT_BYTES
    assert "�" not in parsed.pages[0]


@pytest.mark.parametrize(
    "extra",
    [
        {"../secret": "private"},
        {"word/vbaProject.bin": "macro"},
        {"word/embeddings/embedded.bin": "payload"},
        {"large": b"x" * (2 * 1024 * 1024)},
    ],
)
def test_docx_rejects_unsafe_containers(extra):
    with pytest.raises(ParseError, match="invalid_document"):
        parse_document(docx(b"<document/>", extra=extra), DOCX)


def test_docx_does_not_expand_entities():
    xml = b'<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc>&x;</doc>'
    with pytest.raises(ParseError, match="invalid_document"):
        parse_document(docx(xml), DOCX)


@pytest.mark.asyncio
async def test_real_isolated_parser_and_redacted_failure():
    parser = IsolatedDocumentParser()
    if sys.platform == "win32":
        # Windows lacks the POSIX resource boundary required by the private
        # parser child, so the worker must reject before it reads input.
        with pytest.raises(DriveReadError, match="^processor_unavailable$"):
            await parser.parse(content=pdf(), mime_type="application/pdf")
        return
    assert (
        (await parser.parse(content=pdf(), mime_type="application/pdf"))
        .pages[0]
        .startswith("Synthetic")
    )
    with pytest.raises(DriveReadError, match="^invalid_document$"):
        await parser.parse(content=b"PRIVATE malformed PDF", mime_type="application/pdf")


@pytest.mark.asyncio
@pytest.mark.parametrize("slots", [1, 2])
async def test_page_extraction_children_are_bounded_per_process(monkeypatch, slots):
    import asyncio

    from hushh_mcp.services import drive_document_processor

    monkeypatch.setenv("DRIVE_PAGE_EXTRACTION_SLOTS", str(slots))
    in_flight = peak = 0

    async def child(*args, **kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.02)
        in_flight -= 1
        return {"error": "no_extractable_text"}

    monkeypatch.setattr(drive_document_processor, "_private_process", child)
    processor = LocalDocumentProcessor(
        scanner=SimpleNamespace(scan=AsyncMock()), parser=SimpleNamespace(), embedder=None
    )
    results = await asyncio.gather(
        *(processor.extract_pages(content=b"private", mime_type="text/plain") for _ in range(4)),
        return_exceptions=True,
    )
    assert [str(result) for result in results] == ["no_extractable_text"] * 4
    # Concurrent owner jobs overlap downloads; CPU children stay one per slot.
    assert peak == slots


@pytest.mark.asyncio
async def test_embedding_children_share_the_page_slots_so_children_stay_per_vcpu(monkeypatch):
    """A selected-file embedding never runs beside two OCR children (memory bound)."""
    import asyncio

    from hushh_mcp.services import drive_document_processor

    monkeypatch.setenv("DRIVE_PAGE_EXTRACTION_SLOTS", "2")
    in_flight = peak = 0

    async def child(*args, **kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.02)
        in_flight -= 1
        return {"error": "no_extractable_text"}

    async def embedding(*args, **kwargs):
        await child()
        return "prepared"

    monkeypatch.setattr(drive_document_processor, "_private_process", child)
    processor = LocalDocumentProcessor(
        scanner=SimpleNamespace(scan=AsyncMock()),
        parser=SimpleNamespace(parse=AsyncMock(return_value="parsed")),
        embedder=SimpleNamespace(prepare=AsyncMock(side_effect=embedding)),
    )
    results = await asyncio.gather(
        processor.extract_pages(content=b"private", mime_type="text/plain"),
        processor.extract_pages(content=b"private", mime_type="text/plain"),
        processor.prepare(content=b"private", mime_type="text/plain"),
        return_exceptions=True,
    )
    assert results[2] == "prepared"
    assert peak == 2


@pytest.mark.asyncio
async def test_scanner_failure_prevents_parse_and_embedding():
    scanner = SimpleNamespace(scan=AsyncMock(side_effect=DriveReadError("unsafe_document")))
    parser = SimpleNamespace(parse=AsyncMock())
    embedder = SimpleNamespace(prepare=AsyncMock())
    with pytest.raises(DriveReadError, match="unsafe_document"):
        await LocalDocumentProcessor(scanner=scanner, parser=parser, embedder=embedder).prepare(
            content=b"private", mime_type="text/plain"
        )
    parser.parse.assert_not_awaited()
    embedder.prepare.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response,code",
    [
        (b"stream: OK\0", None),
        (b"stream: synthetic FOUND\0", "unsafe_document"),
        (b"stream: ERROR\0", "scanner_unavailable"),
    ],
)
async def test_clamav_fixed_private_stream_protocol(monkeypatch, response, code):
    import asyncio

    sent_version = []
    sent_scan = []

    def connection(reply, sent):
        writer = SimpleNamespace(
            write=sent.append, drain=AsyncMock(), close=lambda: None, wait_closed=AsyncMock()
        )
        return SimpleNamespace(readuntil=AsyncMock(return_value=reply)), writer

    signature_date = datetime.now(UTC).strftime("%a %b %d %H:%M:%S %Y")
    connect = AsyncMock(
        side_effect=[
            connection(f"ClamAV 1.5.4/28440/{signature_date}\n\0".encode(), sent_version),
            connection(response, sent_scan),
        ]
    )
    monkeypatch.setattr(asyncio, "open_connection", connect)
    if code:
        with pytest.raises(DriveReadError, match=code):
            await ClamAvScanner().scan(b"private")
    else:
        await ClamAvScanner().scan(b"private")
    assert connect.await_count == 2
    assert all(
        call.args == ("127.0.0.1", 3310) and call.kwargs == {"limit": 1024}
        for call in connect.await_args_list
    )
    assert sent_version == [b"zVERSION\0"]
    assert sent_scan == [b"zINSTREAM\0", b"\0\0\0\x07private", b"\0\0\0\0"]


@pytest.mark.asyncio
@pytest.mark.parametrize("age_days", [8, -2])
async def test_clamav_rejects_stale_or_future_signatures_before_sending_content(
    monkeypatch, age_days
):
    import asyncio

    sent = []
    writer = SimpleNamespace(
        write=sent.append, drain=AsyncMock(), close=lambda: None, wait_closed=AsyncMock()
    )
    signature_date = (datetime.now(UTC) - timedelta(days=age_days)).strftime("%a %b %d %H:%M:%S %Y")
    connect = AsyncMock(
        return_value=(
            SimpleNamespace(
                readuntil=AsyncMock(return_value=f"ClamAV 1.5.4/28440/{signature_date}\0".encode())
            ),
            writer,
        )
    )
    monkeypatch.setattr(asyncio, "open_connection", connect)

    with pytest.raises(DriveReadError, match="^scanner_unavailable$"):
        await ClamAvScanner().scan(b"private")
    connect.assert_awaited_once()
    assert sent == [b"zVERSION\0"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("version_age_days", "expect_reload"),
    # Stale baked signatures (2026-09-27 UAT outage): reload, still fail closed so the
    # startup loop re-proves freshness. An outage is not staleness: never reload.
    [(8, True), (None, False)],
)
async def test_clamav_startup_reloads_stale_signatures_and_still_fails_closed(
    monkeypatch, version_age_days, expect_reload
):
    import asyncio

    sent = []

    def connection(reply):
        writer = SimpleNamespace(
            write=sent.append, drain=AsyncMock(), close=lambda: None, wait_closed=AsyncMock()
        )
        return SimpleNamespace(readuntil=AsyncMock(return_value=reply)), writer

    if version_age_days is None:
        replies = [connection(b"garbled\0")]
    else:
        stale = (datetime.now(UTC) - timedelta(days=version_age_days)).strftime(
            "%a %b %d %H:%M:%S %Y"
        )
        replies = [
            connection(f"ClamAV 1.5.4/28129/{stale}\0".encode()),
            connection(b"RELOADING\0"),
        ]
    monkeypatch.setattr(asyncio, "open_connection", AsyncMock(side_effect=replies))

    with pytest.raises(DriveReadError, match="^scanner_unavailable$"):
        await ClamAvScanner().check_ready()
    assert (b"zRELOAD\0" in sent) is expect_reload
    assert not any(chunk.startswith(b"zINSTREAM") for chunk in sent)


@pytest.mark.parametrize("baked", [True, False])
def test_embedding_client_prefers_the_baked_model_and_never_the_hub(monkeypatch, tmp_path, baked):
    # UAT 2026-09-27: the default client loaded the hub name, so a new backend
    # instance called Hugging Face on its first turn; a 429 aborted the process.
    import sys

    from hushh_mcp.services import embedding_client_leaf as leaf

    calls = []
    fake = SimpleNamespace(SentenceTransformer=lambda source, **kw: calls.append((source, kw)))
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake)
    monkeypatch.setattr(leaf, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv(leaf.BAKED_MODEL_DIR_ENV, str(tmp_path if baked else tmp_path / "missing"))

    leaf.EmbeddingClient()._load()

    source, kwargs = calls[0]
    if baked:
        assert (source, kwargs["local_files_only"]) == (str(tmp_path), True)
    else:  # no baked copy (local development): the pinned hub revision, as before
        assert (source, kwargs["local_files_only"]) == (leaf.MODEL_ID, False)
    assert kwargs["revision"] == leaf.MODEL_REVISION


@pytest.mark.asyncio
async def test_clamav_startup_requires_eicar_detection():
    scanner = ClamAvScanner()
    scanner.scan = AsyncMock(side_effect=DriveReadError("unsafe_document"))
    await scanner.check_ready()
    scanner.scan.assert_awaited_once_with(ClamAvScanner.EICAR)

    scanner.scan = AsyncMock(return_value=None)
    with pytest.raises(DriveReadError, match="^scanner_unavailable$"):
        await scanner.check_ready()


def test_embedding_chunks_never_silently_drop_unicode_or_exceed_token_budget(monkeypatch):
    embedder = PrivateDocumentEmbedding()
    model = SimpleNamespace(
        tokenizer=SimpleNamespace(encode=lambda value, **kwargs: list(range(len(value) * 3)))
    )
    monkeypatch.setattr(embedder, "_load", lambda: model)
    captured = []

    def vectors(passages):
        captured.extend(passages)
        return [[1.0] + [0.0] * 383 for _ in passages]

    monkeypatch.setattr(embedder, "embed_passages", vectors)
    text = "₹abc" * 600
    prepared = embedder.prepare(ParsedText((text,)))
    assert "".join(captured) == text
    assert all(len("passage: " + part) * 3 <= 480 for part in captured)
    assert not prepared.truncated
    for chunk in prepared.chunks:
        assert text[chunk.start : chunk.end] == chunk.text
    assert embedder.local_files_only


def test_embedding_chunk_cap_reports_truncation(monkeypatch):
    embedder = PrivateDocumentEmbedding()
    monkeypatch.setattr(
        embedder,
        "_load",
        lambda: SimpleNamespace(
            tokenizer=SimpleNamespace(encode=lambda value, **kwargs: list(value))
        ),
    )
    monkeypatch.setattr(
        embedder, "embed_passages", lambda values: [[1.0] + [0.0] * 383 for _ in values]
    )
    result = embedder.prepare(ParsedText(("x" * MAX_TEXT_BYTES,)))
    assert len(result.chunks) == 128
    assert result.truncated
