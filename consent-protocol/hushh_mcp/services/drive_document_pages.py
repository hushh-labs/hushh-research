"""Credential-free, resumable extraction of original document bytes.

This leaf has no owner, credential, database or model access. A finished batch
is not proof of complete evidence: every unreadable/partial page is explicit.
PDF rasterization and OCR are local, bounded, and never follow document links.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import subprocess
import sys
import zipfile
from dataclasses import asdict, dataclass, field
from importlib.metadata import version
from pathlib import Path

if __package__:
    from .drive_document_parser import (
        DOCX,
        ParseError,
        markdown_without_inline_images,
        parse_live_document,
    )
else:
    from drive_document_parser import (
        DOCX,
        ParseError,
        markdown_without_inline_images,
        parse_live_document,
    )

EXTRACTION_PROFILE = "drive-pages-v1:pdfplumber-0.11.10:pdfium:tesseract-5-eng"
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_BATCH_PAGES = 4
MAX_PAGE_TEXT_BYTES = 64 * 1024
MAX_RENDER_PIXELS = 12_000_000
MIN_RENDER_DPI = 150
RENDER_POLICY_VERSION = "bounded-adaptive-dpi-v1"
OCR_SECONDS = 12
TESSERACT_BINARY = "/usr/bin/tesseract"
TESSDATA_FILE = "/usr/share/tesseract-ocr/5/tessdata/eng.traineddata"


def engine_versions() -> dict:
    """Public runtime provenance only; never include process environment."""
    try:
        result = subprocess.run(  # noqa: S603 - fixed local binary and public version argument
            [TESSERACT_BINARY, "--version"],
            capture_output=True,
            timeout=3,
            check=False,
            env={"PATH": os.defpath, "LANG": "C.UTF-8"},
        )
        first_line = result.stdout.decode("ascii", errors="ignore").splitlines()[0]
        tesseract = first_line[:120] if first_line.startswith("tesseract ") else "unavailable"
    except (OSError, subprocess.TimeoutExpired, IndexError):
        tesseract = "unavailable"
    data = Path(TESSDATA_FILE)
    return {
        "render_policy": RENDER_POLICY_VERSION,
        "pdfplumber": version("pdfplumber"),
        "pypdfium2": version("pypdfium2"),
        "tesseract": tesseract,
        "tesseract_eng_sha256": hashlib.sha256(data.read_bytes()).hexdigest()
        if data.is_file()
        else None,
    }


@dataclass(frozen=True)
class PageEvidence:
    page_number: int
    text: str = field(repr=False)
    method: str = "native_text"
    status: str = "extracted"
    error_code: str | None = None
    quality: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ExtractedPages:
    profile: str
    pages: tuple[PageEvidence, ...] = field(repr=False)
    next_page: int | None
    total_pages: int
    complete: bool
    has_gaps: bool
    engine_versions: dict
    unit_kind: str = "page"

    def validate(self) -> None:
        numbers = [page.page_number for page in self.pages]
        if (
            self.profile != EXTRACTION_PROFILE
            or type(self.complete) is not bool
            or type(self.has_gaps) is not bool
            or type(self.total_pages) is not int
            or any(type(number) is not int for number in numbers)
            or (self.next_page is not None and type(self.next_page) is not int)
            or not 1 <= len(numbers) <= MAX_BATCH_PAGES
            or numbers != list(range(numbers[0], numbers[0] + len(numbers)))
            or numbers[0] < 1
            or self.total_pages < numbers[-1]
            or self.complete != (self.next_page is None)
            or (self.next_page is not None and self.next_page != numbers[-1] + 1)
            or (self.complete and numbers[-1] != self.total_pages)
            or (not self.complete and numbers[-1] >= self.total_pages)
            or self.unit_kind not in {"page", "text_segment"}
            or self.has_gaps != any(p.status in {"partial", "unreadable"} for p in self.pages)
            or not isinstance(self.engine_versions, dict)
        ):
            raise ParseError("invalid_document")
        for page in self.pages:
            if (
                page.status not in {"extracted", "blank_verified", "partial", "unreadable"}
                or not isinstance(page.text, str)
                or len(page.text.encode()) > MAX_PAGE_TEXT_BYTES
                or (page.status == "extracted" and not page.text.strip())
                or (page.status in {"partial", "unreadable"} and not page.error_code)
            ):
                raise ParseError("invalid_document")

    @classmethod
    def from_dict(cls, value: dict) -> "ExtractedPages":
        result = cls(**{**value, "pages": tuple(PageEvidence(**page) for page in value["pages"])})
        result.validate()
        return result


def _bounded_page(number: int, text: str, **kwargs) -> PageEvidence:
    text = text.replace("\x00", "")
    raw = text.encode()
    if len(raw) > MAX_PAGE_TEXT_BYTES:
        kwargs.update(status="partial", error_code="page_text_budget_exceeded")
        text = raw[:MAX_PAGE_TEXT_BYTES].decode("utf-8", errors="ignore")
    return PageEvidence(number, text, **kwargs)


def _ocr_page(pdf, number: int) -> tuple[str, dict]:
    page = pdf[number - 1]
    bitmap = None
    try:
        width, height = page.get_size()
        if not all(math.isfinite(value) and value > 0 for value in (width, height)):
            raise ParseError("page_render_budget_exceeded")
        # Tall exported pages can narrowly exceed the pixel budget at 200 DPI.
        # Bound the allocation before rendering, including PDFium's rounding,
        # and preserve a gap instead of silently reducing below readable size.
        dpi = min(200, math.floor(72 * math.sqrt(MAX_RENDER_PIXELS / (width * height))))
        while dpi >= MIN_RENDER_DPI:
            scale = dpi / 72
            if math.ceil(width * scale) * math.ceil(height * scale) <= MAX_RENDER_PIXELS:
                break
            dpi -= 1
        if dpi < MIN_RENDER_DPI:
            raise ParseError("page_render_budget_exceeded")
        bitmap = page.render(scale=dpi / 72)
        image = bitmap.to_pil()
        if image.width * image.height > MAX_RENDER_PIXELS:
            raise ParseError("page_render_budget_exceeded")
        payload = io.BytesIO()
        image.save(payload, format="PNG")
        result = subprocess.run(  # noqa: S603 - fixed local OCR, private stdin, no shell
            [TESSERACT_BINARY, "stdin", "stdout", "-l", "eng", "--psm", "3", "tsv"],
            input=payload.getvalue(),
            capture_output=True,
            timeout=OCR_SECONDS,
            check=False,
            env={"PATH": os.defpath, "LANG": "C.UTF-8", "OMP_THREAD_LIMIT": "1"},
        )
        if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
            raise ParseError("ocr_failed")
        lines: dict[tuple, list[str]] = {}
        confidences = []
        for row in csv.DictReader(io.StringIO(result.stdout.decode("utf-8")), delimiter="\t"):
            word = row.get("text", "").strip()
            if word:
                key = tuple(row.get(k) for k in ("block_num", "par_num", "line_num"))
                lines.setdefault(key, []).append(word)
                confidence = float(row.get("conf", "-1"))
                if confidence >= 0:
                    confidences.append(confidence)
        text = "\n".join(" ".join(words) for words in lines.values())
        if not text.strip():
            raise ParseError("ocr_no_text")
        return text, {
            "ocr_mean_word_confidence": round(sum(confidences) / len(confidences), 2)
            if confidences
            else None,
            "confidence_kind": "ocr_engine_score_not_probability",
            "render_dpi": dpi,
            "render_policy": "bounded-adaptive-dpi-v1",
            "render_pixels": image.width * image.height,
        }
    except FileNotFoundError:
        raise ParseError("ocr_unavailable") from None
    except subprocess.TimeoutExpired:
        raise ParseError("ocr_timeout") from None
    finally:
        if bitmap is not None:
            bitmap.close()
        page.close()


def _pdf_pages(content: bytes, start: int, limit: int) -> tuple[list[PageEvidence], int]:
    import pdfplumber
    import pypdfium2
    from pdfminer.pdfpage import PDFPage
    from pdfplumber.page import Page

    if not content.startswith(b"%PDF-"):
        raise ParseError("invalid_document")
    source = pdfplumber.open(io.BytesIO(content))
    raster = None
    try:
        if source.doc.encryption:
            raise ParseError("encrypted_document")
        raster = pypdfium2.PdfDocument(content)
        total = len(raster)
        if not 1 <= start <= total:
            raise ParseError("invalid_argument")
        end = min(start + limit - 1, total)
        extracted = []
        for number, source_page in enumerate(PDFPage.create_pages(source.doc), 1):
            if number < start:
                continue
            if number > end:
                break
            page = Page(source, source_page, page_number=number)
            try:
                text = page.extract_text() or ""
                # Any image may contain account/date/period evidence even on a
                # page with an existing text layer. Preserve both observations.
                needs_ocr = bool(page.images) or (not text.strip() and bool(page.objects))
                if needs_ocr:
                    try:
                        ocr, quality = _ocr_page(raster, number)
                        body = (text + "\n" + ocr).strip() if text.strip() else ocr
                        extracted.append(
                            _bounded_page(
                                number,
                                body,
                                method="native_text+ocr" if text.strip() else "ocr",
                                quality=quality,
                            )
                        )
                    except ParseError as error:
                        extracted.append(
                            _bounded_page(
                                number,
                                text,
                                method="ocr",
                                status="partial" if text.strip() else "unreadable",
                                error_code=str(error),
                            )
                        )
                elif text.strip():
                    extracted.append(_bounded_page(number, text))
                else:
                    extracted.append(PageEvidence(number, "", status="blank_verified"))
            finally:
                page.close()
        if len(extracted) != end - start + 1:
            raise ParseError("invalid_document")
        return extracted, total
    finally:
        if raster is not None:
            raster.close()
        source.flush_cache()
        source.stream.close()


def extract_pages(
    content: bytes, mime_type: str, *, start_page: int = 1, page_limit: int = MAX_BATCH_PAGES
) -> ExtractedPages:
    """Extract an exact consecutive range; callers persist its explicit cursor."""
    if (
        type(start_page) is not int
        or start_page < 1
        or type(page_limit) is not int
        or not 1 <= page_limit <= MAX_BATCH_PAGES
    ):
        raise ParseError("invalid_argument")
    if not content or len(content) > MAX_SOURCE_BYTES:
        raise ParseError("file_too_large" if content else "no_extractable_text")
    try:
        unit_kind = "page"
        if mime_type == "application/pdf":
            pages, total = _pdf_pages(content, start_page, page_limit)
        else:
            unit_kind = "text_segment"
            # Text documents can resume beyond the compatibility parser's
            # 256 KiB budget; native byte boundaries are never cut mid-codepoint.
            if mime_type in {"text/plain", "text/markdown"}:
                raw = (
                    markdown_without_inline_images(content)
                    if mime_type == "text/markdown"
                    else content
                )
                text = raw.decode("utf-8-sig", errors="strict").replace("\x00", "")
                partial = mime_type == "text/markdown" and (raw != content or "[image]" in text)
            else:
                parsed = parse_live_document(content, mime_type)
                text, partial = "\n\n".join(parsed.pages), parsed.truncated
                if mime_type == DOCX:
                    with zipfile.ZipFile(io.BytesIO(content)) as archive:
                        partial = partial or any(
                            name.startswith(
                                (
                                    "word/media/",
                                    "word/header",
                                    "word/footer",
                                    "word/footnotes",
                                    "word/endnotes",
                                )
                            )
                            for name in archive.namelist()
                        )
            if not text.strip():
                raise ParseError("no_extractable_text")
            # A Unicode scalar occupies at most four UTF-8 bytes.
            width = MAX_PAGE_TEXT_BYTES // 4
            total = (len(text) + width - 1) // width
            if start_page > total:
                raise ParseError("invalid_argument")
            pages = [
                _bounded_page(
                    number,
                    text[(number - 1) * width : number * width],
                    status="partial"
                    if partial
                    else (
                        "extracted"
                        if text[(number - 1) * width : number * width].strip()
                        else "blank_verified"
                    ),
                    error_code="source_extraction_incomplete" if partial else None,
                )
                for number in range(start_page, min(total + 1, start_page + page_limit))
            ]
        next_page = pages[-1].page_number + 1 if pages[-1].page_number < total else None
        result = ExtractedPages(
            EXTRACTION_PROFILE,
            tuple(pages),
            next_page,
            total,
            next_page is None,
            any(page.status in {"partial", "unreadable"} for page in pages),
            engine_versions(),
            unit_kind,
        )
        result.validate()
        return result
    except ParseError:
        raise
    except Exception:
        raise ParseError("invalid_document") from None


def main() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (65, 65))
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
        options = json.loads(sys.argv[1])
        result = extract_pages(sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1), **options)
        payload = asdict(result)
    except ParseError as error:
        payload = {"error": str(error)}
    except Exception:
        payload = {"error": "processor_unavailable"}
    sys.stdout.write(json.dumps(payload))


if __name__ == "__main__":
    main()
