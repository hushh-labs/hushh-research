"""Bounded, credential-free parsing leaf; executed in a disposable process.

Never follows links, renders scripts, extracts archives to disk, or performs OCR.
Input is private and must not be logged, even on malformed parser exceptions.
"""

from __future__ import annotations

import csv
import io
import json
import resource
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from defusedxml import ElementTree

MAX_INPUT_BYTES = 4 * 1024 * 1024
MAX_TEXT_BYTES = 256 * 1024
MAX_PAGES = 100
# Live lane only: a Google Sheets CSV export or an uploaded .csv.
MAX_CSV_ROWS = 2000
MAX_CSV_COLUMNS = 64
MAX_CSV_CELL_CHARS = 1000
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class ParseError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedText:
    pages: tuple[str, ...] = field(repr=False)
    truncated: bool = False


def _bounded(pages) -> ParsedText:
    kept: list[str] = []
    remaining = MAX_TEXT_BYTES
    truncated = False
    for number, value in enumerate(pages):
        if number >= MAX_PAGES:
            truncated = True
            break
        value = value.replace("\x00", "")
        encoded = value.encode("utf-8")
        if len(encoded) > remaining:
            kept.append(encoded[:remaining].decode("utf-8", errors="ignore"))
            truncated = True
            break
        kept.append(value)
        remaining -= len(encoded)
    if not any(page.strip() for page in kept):
        raise ParseError("no_extractable_text")
    return ParsedText(tuple(kept), truncated)


def _docx(content: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(item.file_size for item in entries) > 16 * 1024 * 1024:
            raise ParseError("file_too_large")
        names = [item.filename for item in entries]
        if len(names) != len(set(names)):
            raise ParseError("invalid_document")
        for item in entries:
            path = PurePosixPath(item.filename)
            if (
                item.flag_bits & 1
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in item.filename
                or item.file_size > max(1024 * 1024, item.compress_size * 100)
                or "vbaproject" in item.filename.lower()
                or item.filename.startswith("word/embeddings/")
            ):
                raise ParseError("invalid_document")
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise ParseError("invalid_document")
        # No relationship is dereferenced, including external image/template URLs.
        root = ElementTree.fromstring(archive.read("word/document.xml"))
        namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        lines = []
        for paragraph in root.iter(namespace + "p"):
            lines.append("".join(node.text or "" for node in paragraph.iter(namespace + "t")))
        return "\n".join(lines)


def parse_document(content: bytes, mime_type: str) -> ParsedText:
    if not content or len(content) > MAX_INPUT_BYTES:
        raise ParseError("file_too_large" if content else "no_extractable_text")
    try:
        if mime_type in {"text/plain", "text/markdown"}:
            return _bounded((content.decode("utf-8-sig", errors="strict"),))
        if mime_type == DOCX:
            return _bounded((_docx(content),))
        if mime_type == "application/pdf":
            import pdfplumber
            from pdfminer.pdfpage import PDFPage
            from pdfplumber.page import Page

            if not content.startswith(b"%PDF-"):
                raise ParseError("invalid_document")
            pdf = pdfplumber.open(io.BytesIO(content))
            try:
                if pdf.doc.encryption:
                    raise ParseError("encrypted_document")

                def page_text():
                    for number, source_page in enumerate(PDFPage.create_pages(pdf.doc), 1):
                        if number > MAX_PAGES:
                            yield ""  # Overflow marker; never extract page 101.
                            break
                        page = Page(pdf, source_page, page_number=number)
                        try:
                            yield page.extract_text() or ""
                        finally:
                            page.close()

                return _bounded(page_text())
            finally:
                # PDF.close()/__exit__ accesses .pages and materializes the
                # entire page tree. Close the stream and caches directly.
                pdf.flush_cache()
                pdf.stream.close()
        raise ParseError("unsupported_format")
    except ParseError:
        raise
    except Exception:
        raise ParseError("invalid_document") from None


def parse_live_csv(content: bytes) -> ParsedText:
    """Bounded CSV rows as plain ``a | b`` text lines for the live lane.

    Cells are data, never formulas or links: nothing is evaluated. Stops at the
    row, column, cell and text caps and fails closed on anything not clean
    UTF-8 CSV. Never calls csv.field_size_limit, which is process-global; a
    field over its default limit is a damaged file here.
    """
    if not content or len(content) > MAX_INPUT_BYTES:
        raise ParseError("file_too_large" if content else "no_extractable_text")
    try:
        text = content.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        raise ParseError("invalid_document") from None
    if "\x00" in text:
        raise ParseError("invalid_document")
    lines: list[str] = []
    size = 0
    truncated = False
    try:
        for number, row in enumerate(csv.reader(io.StringIO(text, newline=""), strict=True)):
            if number >= MAX_CSV_ROWS or size > MAX_TEXT_BYTES:
                truncated = True
                break
            cells = [" ".join(cell.split()) for cell in row]
            if any(cells[MAX_CSV_COLUMNS:]):
                truncated = True
            cells = cells[:MAX_CSV_COLUMNS]
            while cells and not cells[-1]:
                cells.pop()  # Sheets pads short rows with empty cells.
            if not cells:
                continue
            if any(len(cell) > MAX_CSV_CELL_CHARS for cell in cells):
                truncated = True
                cells = [cell[:MAX_CSV_CELL_CHARS] for cell in cells]
            line = " | ".join(cells)
            lines.append(line)
            size += len(line.encode("utf-8")) + 1
    except csv.Error:
        raise ParseError("invalid_document") from None
    parsed = _bounded(("\n".join(lines),))
    return ParsedText(parsed.pages, parsed.truncated or truncated)


def parse_live_document(content: bytes, mime_type: str) -> ParsedText:
    """Live lane: ``parse_document`` plus CSV. The selected lane never reads CSV."""
    if mime_type == "text/csv":
        return parse_live_csv(content)
    return parse_document(content, mime_type)


def main() -> None:
    # Linux worker hard limits; parent also kills/reaps on wall-clock timeout.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    try:
        parsed = parse_document(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1), sys.argv[1])
        result = {"pages": parsed.pages, "truncated": parsed.truncated}
    except ParseError as error:
        result = {"error": str(error)}
    except Exception:
        result = {"error": "invalid_document"}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
