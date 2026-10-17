"""One PDF text engine (pypdfium2) for the credential-free parser leaves.

Leaf module: stdlib, pypdfium2 and Pillow only. It has no owner, credential,
database, network or model access and imports nothing from ``hushh_mcp``, so
the disposable parser children can load it next to their own script.

- PDFium reads each page's text layer. Only a page whose layer is missing,
  short or garbled, or whose images cover a large part of the page, is sent
  to OCR. A scanner's invisible OCR layer (text render mode 3) that reads
  well is reused instead of being OCRed again.
- Every page is isolated: a page PDFium cannot load becomes an ``unreadable``
  page and the other pages still extract.
- A PDF with only an owner password opens without a prompt and is read. A
  PDF that needs a user password is ``encrypted_document``. Passwords are
  never guessed.
- OCR is local Tesseract at up to 300 DPI inside a fixed pixel budget, in
  English plus Hindi when the Hindi language data is installed.

Text never leaves the calling process through this module: no logging, no
files, no environment. Callers decide what to return.
"""

from __future__ import annotations

import csv
import io
import math
import os
import subprocess
import unicodedata
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

ENGINE_VERSION = "pdfium-text-v1:ocr-trigger-v2"
MAX_RENDER_PIXELS = 12_000_000
MIN_RENDER_DPI = 150
MAX_RENDER_DPI = 300
# OCR is wanted when images cover this share of the page, when the text layer
# has fewer meaningful characters than this, or when this share is garbage.
OCR_IMAGE_AREA_RATIO = 0.2
MIN_PAGE_TEXT_CHARS = 32
MAX_GARBLED_RATIO = 0.25
MAX_PAGE_TEXT_BYTES = 64 * 1024
MAX_PAGE_OBJECTS = 5000
OCR_SECONDS = 12
MAX_OCR_OUTPUT_BYTES = 2 * 1024 * 1024
MIN_OCR_WORDS = 8
MIN_OCR_MEAN_WORD_CONFIDENCE = 70
TESSERACT_BINARY = "/usr/bin/tesseract"
TESSDATA_DIR = "/usr/share/tesseract-ocr/5/tessdata"
PASSWORD_ERROR = 4  # FPDF_ERR_PASSWORD
_GARBLED_CATEGORIES = frozenset({"Co", "Cn", "Cs"})
_TEXT_RENDER_INVISIBLE = 3  # FPDF_TEXTRENDERMODE_INVISIBLE
_PAGEOBJ_TEXT = 1  # FPDF_PAGEOBJ_TEXT
_PAGEOBJ_IMAGE = 3  # FPDF_PAGEOBJ_IMAGE


class PdfEngineError(ValueError):
    """A fixed, safe failure code; never carries document content."""


@dataclass(frozen=True)
class PdfPage:
    number: int
    text: str = field(repr=False)
    method: str = "native_text"  # native_text | ocr_layer | ocr | native_text+ocr
    status: str = "extracted"  # extracted | blank_verified | partial | unreadable
    error_code: str | None = None
    ocr_reason: str | None = None  # why OCR was wanted, when it was
    quality: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PageLayout:
    objects: int
    image_ratio: float
    text_objects: int
    invisible_text_objects: int

    @property
    def invisible_layer(self) -> bool:
        return self.text_objects > 0 and self.invisible_text_objects == self.text_objects


def text_signals(text: str) -> tuple[int, float]:
    """Meaningful characters (letters, marks, digits) and the garbage share."""
    meaningful = garbled = visible = 0
    for character in text:
        if character.isspace():
            continue
        visible += 1
        category = unicodedata.category(character)
        if category[0] in "LMN":
            meaningful += 1
        elif (
            character == "�"
            or category in _GARBLED_CATEGORIES
            or (category == "Cc" and character not in "\t\n\r")
        ):
            garbled += 1
    return meaningful, (garbled / visible if visible else 0.0)


def ocr_reason(text: str, layout: PageLayout) -> str | None:
    """Why a page needs OCR, or None when its text layer is enough.

    A blank page with no content objects needs nothing. A garbled layer is
    always replaced. A scanner's invisible layer is reused only when it
    reads well; a thin or garbled one is OCRed again.
    """
    meaningful, garbled = text_signals(text)
    if layout.objects == 0 and meaningful == 0:
        return None
    if garbled > MAX_GARBLED_RATIO:
        return "garbled_text"
    if meaningful == 0:
        return "no_text"
    if meaningful < MIN_PAGE_TEXT_CHARS:
        return "short_text"
    if layout.invisible_layer:
        return None
    if layout.image_ratio >= OCR_IMAGE_AREA_RATIO:
        return "image_area"
    return None


def open_pdf(content: bytes):
    """Open bytes with PDFium; owner-password PDFs open, user passwords do not."""
    import pypdfium2

    if not isinstance(content, bytes) or not content.startswith(b"%PDF-"):
        raise PdfEngineError("invalid_document")
    try:
        return pypdfium2.PdfDocument(content)
    except pypdfium2.PdfiumError as error:
        if getattr(error, "err_code", None) == PASSWORD_ERROR:
            raise PdfEngineError("encrypted_document") from None
        raise PdfEngineError("invalid_document") from None


def page_layout(page) -> PageLayout:
    """Content objects on a page: image coverage and text render modes."""
    import pypdfium2.raw as pdfium_c

    width, height = page.get_size()
    area = width * height if math.isfinite(width * height) and width > 0 < height else 0
    objects = images = texts = invisible = 0
    for item in page.get_objects(max_depth=4):
        objects += 1
        if objects > MAX_PAGE_OBJECTS:
            break
        if item.type == _PAGEOBJ_IMAGE and area:
            left, bottom, right, top = item.get_bounds()
            clipped_w = max(0.0, min(right, width) - max(left, 0.0))
            clipped_h = max(0.0, min(top, height) - max(bottom, 0.0))
            images += clipped_w * clipped_h
        elif item.type == _PAGEOBJ_TEXT:
            texts += 1
            if pdfium_c.FPDFTextObj_GetTextRenderMode(item.raw) == _TEXT_RENDER_INVISIBLE:
                invisible += 1
    return PageLayout(objects, min(1.0, images / area) if area else 0.0, texts, invisible)


def render_png(page) -> tuple[bytes, int, int]:
    """Render one page to grayscale PNG at up to 300 DPI inside the pixel cap."""
    width, height = page.get_size()
    if not all(math.isfinite(value) and value > 0 for value in (width, height)):
        raise PdfEngineError("page_render_budget_exceeded")
    dpi = min(MAX_RENDER_DPI, math.floor(72 * math.sqrt(MAX_RENDER_PIXELS / (width * height))))
    while dpi >= MIN_RENDER_DPI:
        scale = dpi / 72
        if math.ceil(width * scale) * math.ceil(height * scale) <= MAX_RENDER_PIXELS:
            break
        dpi -= 1
    if dpi < MIN_RENDER_DPI:
        raise PdfEngineError("page_render_budget_exceeded")
    bitmap = page.render(scale=dpi / 72, grayscale=True)
    try:
        image = bitmap.to_pil()
        pixels = image.width * image.height
        if pixels > MAX_RENDER_PIXELS:
            raise PdfEngineError("page_render_budget_exceeded")
        payload = io.BytesIO()
        image.save(payload, format="PNG")
        return payload.getvalue(), dpi, pixels
    finally:
        bitmap.close()


def ocr_languages() -> str:
    """English, plus Hindi when its language data is installed in the image."""
    return "eng+hin" if Path(TESSDATA_DIR, "hin.traineddata").is_file() else "eng"


def ocr_png(payload: bytes) -> tuple[str, dict]:
    """Local Tesseract over private stdin; no shell, no network, bounded output."""
    languages = ocr_languages()
    try:
        result = subprocess.run(  # noqa: S603 - fixed local OCR, private stdin, no shell
            [TESSERACT_BINARY, "stdin", "stdout", "-l", languages, "--psm", "3", "tsv"],
            input=payload,
            capture_output=True,
            timeout=OCR_SECONDS,
            check=False,
            env={"PATH": os.defpath, "LANG": "C.UTF-8", "OMP_THREAD_LIMIT": "1"},
        )
    except FileNotFoundError:
        raise PdfEngineError("ocr_unavailable") from None
    except subprocess.TimeoutExpired:
        raise PdfEngineError("ocr_timeout") from None
    if result.returncode or len(result.stdout) > MAX_OCR_OUTPUT_BYTES:
        raise PdfEngineError("ocr_failed")
    lines: dict[tuple, list[str]] = {}
    confidences = []
    for row in csv.DictReader(
        io.StringIO(result.stdout.decode("utf-8", errors="replace")), delimiter="\t"
    ):
        word = (row.get("text") or "").strip()
        if not word:
            continue
        key = tuple(row.get(name) for name in ("block_num", "par_num", "line_num"))
        lines.setdefault(key, []).append(word)
        try:
            confidence = float(row.get("conf") or "-1")
        except ValueError:
            continue
        if math.isfinite(confidence) and 0 <= confidence <= 100:
            confidences.append(confidence)
    text = "\n".join(" ".join(words) for words in lines.values())
    if not text.strip():
        raise PdfEngineError("ocr_no_text")
    return text, {
        "ocr_mean_word_confidence": round(sum(confidences) / len(confidences), 2)
        if confidences
        else None,
        "ocr_word_count": sum(len(words) for words in lines.values()),
        "ocr_languages": languages,
        "confidence_kind": "ocr_engine_score_not_probability",
    }


def ocr_signal_error(quality: dict) -> str | None:
    """A legible-looking OCR string is not proof the whole page was read."""
    words = quality.get("ocr_word_count")
    score = quality.get("ocr_mean_word_confidence")
    if type(words) is not int or words < MIN_OCR_WORDS:
        return "ocr_insufficient_text"
    if (
        type(score) not in (int, float)
        or not math.isfinite(score)
        or not 0 <= score <= 100
        or score < MIN_OCR_MEAN_WORD_CONFIDENCE
    ):
        return "ocr_low_confidence"
    return None


def _bounded(page: PdfPage) -> PdfPage:
    raw = page.text.replace("\x00", "").encode("utf-8", errors="ignore")
    if len(raw) <= MAX_PAGE_TEXT_BYTES:
        return page
    return PdfPage(
        page.number,
        raw[:MAX_PAGE_TEXT_BYTES].decode("utf-8", errors="ignore"),
        page.method,
        "partial",
        page.error_code or "page_text_budget_exceeded",
        page.ocr_reason,
        page.quality,
    )


def _one_page(
    pdf,
    number: int,
    *,
    ocr: Callable[[bytes], tuple[str, dict]] | None,
) -> PdfPage:
    page = pdf[number - 1]
    textpage = None
    try:
        textpage = page.get_textpage()
        text = textpage.get_text_bounded().replace("\r\n", "\n").replace("\r", "\n")
        layout = page_layout(page)
        reason = ocr_reason(text, layout)
        meaningful, _ = text_signals(text)
        if reason is None:
            if meaningful:
                method = "ocr_layer" if layout.invisible_layer else "native_text"
                return PdfPage(number, text, method)
            return PdfPage(number, "", status="blank_verified")
        # A garbled layer is noise, never evidence; keep only readable text.
        kept = "" if reason == "garbled_text" else text
        if ocr is None:
            return PdfPage(
                number,
                kept,
                status="partial" if kept.strip() else "unreadable",
                error_code="ocr_not_run",
                ocr_reason=reason,
            )
        try:
            payload, dpi, pixels = render_png(page)
            recognized, quality = ocr(payload)
        except PdfEngineError as error:
            return PdfPage(
                number,
                kept,
                method="ocr",
                status="partial" if kept.strip() else "unreadable",
                error_code=str(error),
                ocr_reason=reason,
            )
        signal = ocr_signal_error(quality)
        both = reason == "image_area" and kept.strip()
        return PdfPage(
            number,
            (kept + "\n" + recognized).strip() if both else recognized,
            method="native_text+ocr" if both else "ocr",
            status="partial" if signal else "extracted",
            error_code=signal,
            ocr_reason=reason,
            quality={**quality, "render_dpi": dpi, "render_pixels": pixels},
        )
    finally:
        if textpage is not None:
            textpage.close()
        page.close()


def iter_pdf_pages(
    pdf,
    start: int,
    end: int,
    *,
    ocr: Callable[[bytes], tuple[str, dict]] | None = None,
    max_ocr_pages: int = 0,
) -> Iterator[PdfPage]:
    """Pages ``start``..``end`` in order; a failing page is ``unreadable``.

    OCR runs on at most ``max_ocr_pages`` pages that need it; later ones keep
    their text layer and say ``ocr_budget_exhausted``.
    """
    used = 0
    for number in range(start, end + 1):
        allowed = ocr if ocr is not None and used < max_ocr_pages else None
        try:
            page = _one_page(pdf, number, ocr=allowed)
        except Exception:  # noqa: BLE001 - one damaged page never fails the file
            page = PdfPage(number, "", status="unreadable", error_code="page_unreadable")
        if page.method in {"ocr", "native_text+ocr"}:
            used += 1
        elif ocr is not None and page.error_code == "ocr_not_run":
            page = PdfPage(
                page.number,
                page.text,
                page.method,
                page.status,
                "ocr_budget_exhausted",
                page.ocr_reason,
                page.quality,
            )
        yield _bounded(page)


def extract_pdf_pages(
    content: bytes,
    *,
    start: int = 1,
    limit: int = 100,
    ocr: Callable[[bytes], tuple[str, dict]] | None = None,
    max_ocr_pages: int = 0,
) -> tuple[list[PdfPage], int]:
    """An exact consecutive range of pages and the document's page count."""
    if type(start) is not int or type(limit) is not int or start < 1 or limit < 1:
        raise PdfEngineError("invalid_argument")
    pdf = open_pdf(content)
    try:
        total = len(pdf)
        if total < 1:
            raise PdfEngineError("no_extractable_text")
        if start > total:
            raise PdfEngineError("invalid_argument")
        end = min(total, start + limit - 1)
        return list(iter_pdf_pages(pdf, start, end, ocr=ocr, max_ocr_pages=max_ocr_pages)), total
    finally:
        pdf.close()


def engine_versions() -> dict:
    """Public provenance only; never the process environment."""
    from importlib.metadata import version

    return {"pdf_engine": ENGINE_VERSION, "pypdfium2": version("pypdfium2")}


__all__ = [
    "ENGINE_VERSION",
    "PageLayout",
    "PdfEngineError",
    "PdfPage",
    "engine_versions",
    "extract_pdf_pages",
    "iter_pdf_pages",
    "ocr_png",
    "ocr_reason",
    "open_pdf",
    "page_layout",
    "render_png",
    "text_signals",
]
