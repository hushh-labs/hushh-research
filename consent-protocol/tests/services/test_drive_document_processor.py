"""Production parser/process boundaries with synthetic private documents."""

from __future__ import annotations

import io
import os
import subprocess
import sys
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

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
)
from hushh_mcp.services.google_drive_adapter import DriveReadError


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
        (b"", "text/plain", "no_extractable_text"),
        (b"\xff", "text/plain", "invalid_document"),
        (b" \n\t", "text/plain", "no_extractable_text"),
        (b"not-pdf", "application/pdf", "invalid_document"),
        (b"MZ", "application/x-msdownload", "unsupported_format"),
        (b"x" * (MAX_INPUT_BYTES + 1), "text/plain", "file_too_large"),
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
    assert (
        (await parser.parse(content=pdf(), mime_type="application/pdf"))
        .pages[0]
        .startswith("Synthetic")
    )
    with pytest.raises(DriveReadError, match="^invalid_document$"):
        await parser.parse(content=b"PRIVATE malformed PDF", mime_type="application/pdf")


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
