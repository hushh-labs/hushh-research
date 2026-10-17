"""Credential-free request-time content check, run in a disposable child.

Input on stdin: a 4-byte big-endian header length, a JSON header holding the
request's concept groups (an OR of spellings each), then the file bytes. The
query words travel on stdin, never on the command line, which other
processes can read. Options on the command line carry only the MIME type and
page budgets.

Output on stdout: which concept groups the file's text contains and the
dates written on the first dated line of its opening text. Never the text:
it lives only in this child's memory and is gone when the child exits.

Matching follows Drive's own content search where it is documented and stays
deterministic: Unicode text is NFC-normalised and casefolded, Latin accents
fold ("Résumé" = "resume") while Devanagari vowel signs stay part of their
word, Indic digits read as ASCII digits, an underscore counts as a space
(as it does in Drive's index), and letter/digit runs split, so
``INV_2026_HDFC_9981``, ``INV-2026-HDFC-9981`` and ``INV2026HDFC9981`` all
match the typed code ``INV 2026 HDFC 9981``. A spelling matches as a
contiguous word sequence, never as a fragment inside a longer word.

No owner, credential, database, network or model access. Never imports
``hushh_mcp``.
"""

from __future__ import annotations

import io
import json
import re
import struct
import sys
import unicodedata
import zipfile
from collections import deque
from collections.abc import Iterable, Iterator
from pathlib import PurePosixPath

if __package__:
    from .drive_document_parser import (
        DOCX,
        XLSX,
        ParseError,
        markdown_without_inline_images,
        parse_live_xlsx,
    )
    from .drive_pdf_engine import (
        MAX_RENDER_PIXELS,
        PdfEngineError,
        iter_pdf_pages,
        ocr_png,
        ocr_signal_error,
        open_pdf,
    )
    from .drive_title_dates import parse_title_dates
else:
    from drive_document_parser import (
        DOCX,
        XLSX,
        ParseError,
        markdown_without_inline_images,
        parse_live_xlsx,
    )
    from drive_pdf_engine import (
        MAX_RENDER_PIXELS,
        PdfEngineError,
        iter_pdf_pages,
        ocr_png,
        ocr_signal_error,
        open_pdf,
    )
    from drive_title_dates import parse_title_dates

MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_HEADER_BYTES = 64 * 1024
MAX_GROUPS = 24
MAX_SPELLINGS = 160
MAX_SPELLING_CHARS = 200
MAX_SPELLING_WORDS = 12
MAX_TEXT_PAGES = 200
MAX_OCR_PAGES = 8
# Opening text that may carry the document's own date ("Statement period ...").
HEADER_CHARS = 2048
HEADER_READINGS = 2
# Text budget per file; past it the check stops and says it was not complete.
MAX_MATCH_CHARS = 4_000_000
TEXT_CHUNK_CHARS = 65536
MAX_IMAGE_SOURCE_PIXELS = 64_000_000
MAX_DOCX_PART_BYTES = 16 * 1024 * 1024
MAX_DOCX_TEXT_BYTES = 48 * 1024 * 1024
TEXT_TYPES = frozenset({"text/plain", "text/markdown", "text/csv"})
IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/jpg"})
PDF = "application/pdf"
SUPPORTED_TYPES = frozenset({PDF, DOCX, XLSX, *TEXT_TYPES, *IMAGE_TYPES})
_JOINERS = frozenset({"‌", "‍"})  # ZWNJ/ZWJ inside Indic words
_DIGIT_RUN = re.compile(r"\d+|\D+")
# Normalised ASCII text: letter runs and digit runs, everything else separates.
_ASCII_PARTS = re.compile(r"[a-z]+|[0-9]+")
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_DOCX_TEXT_PARTS = re.compile(
    r"word/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml\Z"
)
_LATIN: dict[str, bool] = {}
_WORD_CHAR: dict[str, bool] = {}


class CheckError(ValueError):
    """A fixed, safe failure code; never carries document content."""


def _is_latin(character: str) -> bool:
    cached = _LATIN.get(character)
    if cached is None:
        cached = character.isascii() or unicodedata.name(character, "").startswith("LATIN")
        if len(_LATIN) < 4096:
            _LATIN[character] = cached
    return cached


def _word_char(character: str) -> bool:
    cached = _WORD_CHAR.get(character)
    if cached is None:
        cached = unicodedata.category(character)[0] in "LMN"
        if len(_WORD_CHAR) < 8192:
            _WORD_CHAR[character] = cached
    return cached


def normalize(text: str) -> str:
    """NFC, Indic digits as ASCII, Latin accents folded, casefolded."""
    if text.isascii():
        return text.lower()
    out = []
    latin_base = False
    for character in unicodedata.normalize("NFD", text):
        category = unicodedata.category(character)
        if category == "Mn" and latin_base:
            continue  # an accent on a Latin letter; Devanagari signs stay
        if category == "Nd" and not character.isascii():
            character = str(unicodedata.decimal(character, 0))
        latin_base = category[0] == "L" and _is_latin(character)
        out.append(character)
    return unicodedata.normalize("NFC", "".join(out)).casefold()


def words(text: str) -> list[str]:
    """Content words of already-normalised text, split at letter/digit runs."""
    if text.isascii():
        return _ASCII_PARTS.findall(text)
    result: list[str] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            word = "".join(current).strip("".join(_JOINERS))
            if word:
                result.extend(part for part in _DIGIT_RUN.findall(word) if part)
            current.clear()

    for character in text:
        if _word_char(character) or (character in _JOINERS and current):
            current.append(character)
        else:
            flush()
    flush()
    return result


def content_words(text: str) -> list[str]:
    return words(normalize(text))


class ConceptMatcher:
    """Which AND-ed concept groups a stream of text contains.

    Each group is an OR of spellings; a spelling matches as a contiguous word
    sequence. Feeding is incremental, so a long document is never held whole.
    """

    def __init__(self, groups: list[list[str]]):
        self.groups = len(groups)
        self.matched: set[int] = set()
        self._by_last: dict[str, list[tuple[int, tuple[str, ...]]]] = {}
        longest = 1
        for index, spellings in enumerate(groups):
            for spelling in spellings:
                sequence = tuple(content_words(spelling))[:MAX_SPELLING_WORDS]
                if not sequence:
                    continue
                longest = max(longest, len(sequence))
                self._by_last.setdefault(sequence[-1], []).append((index, sequence))
        self._window: deque[str] = deque(maxlen=longest)
        # A trailing partial word of one chunk joins the next chunk.
        self._carry = ""

    @property
    def done(self) -> bool:
        return len(self.matched) == self.groups

    def _word(self, word: str) -> None:
        self._window.append(word)
        for index, sequence in self._by_last.get(word, ()):
            if index in self.matched or len(sequence) > len(self._window):
                continue
            if tuple(self._window)[-len(sequence) :] == sequence:
                self.matched.add(index)

    def feed(self, text: str, *, final: bool = False) -> None:
        text = self._carry + text
        self._carry = ""
        if not final:
            # Hold back the last run of word characters: it may continue.
            cut = len(text)
            while cut > 0 and (_word_char(text[cut - 1]) or text[cut - 1] in _JOINERS):
                cut -= 1
            if cut < len(text):
                self._carry = text[cut:]
                text = text[:cut]
        for word in content_words(text):
            self._word(word)

    def boundary(self) -> None:
        """A page or part break: words on either side are still adjacent."""
        self.feed("", final=True)


def header_readings(text: str) -> list:
    """Dates on the first dated line of the opening text (the title rule's parser)."""
    ascii_digits = "".join(
        str(unicodedata.decimal(character, 0))
        if unicodedata.category(character) == "Nd" and not character.isascii()
        else character
        for character in text[:HEADER_CHARS]
    )
    for line in ascii_digits.splitlines():
        readings = parse_title_dates(line)
        if readings:
            return [list(reading) for reading in readings[:HEADER_READINGS]]
    return []


def _text_chunks(content: bytes, mime_type: str) -> Iterator[str]:
    if mime_type == "text/markdown":
        content = markdown_without_inline_images(content)
    text = content.decode("utf-8-sig", errors="replace").replace("\x00", "")
    for start in range(0, len(text), TEXT_CHUNK_CHARS):
        yield text[start : start + TEXT_CHUNK_CHARS]


def _zip_part(archive: zipfile.ZipFile, item: zipfile.ZipInfo, budget: list[int]) -> bytes:
    """Read one entry in 64 KiB steps against a running budget (zip bombs)."""
    data = bytearray()
    with archive.open(item) as stream:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return bytes(data)
            data.extend(chunk)
            budget[0] -= len(chunk)
            if len(data) > MAX_DOCX_PART_BYTES or budget[0] < 0:
                raise CheckError("file_too_large")


def _docx_chunks(content: bytes) -> Iterator[str]:
    """Body, headers, footers, notes and comments; tabs and breaks kept.

    Media and embedded objects (every native chart has one) are skipped, not
    rejected. No relationship or external target is ever followed.
    """
    from defusedxml import ElementTree

    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise CheckError("invalid_document") from None
    with archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if len(entries) > 4000 or len(names) != len(set(names)):
            raise CheckError("invalid_document")
        if "word/document.xml" not in names:
            raise CheckError("invalid_document")
        budget = [MAX_DOCX_TEXT_BYTES]
        parts = [item for item in entries if _DOCX_TEXT_PARTS.match(item.filename)]
        # Reading order: page headers print above the body (a statement's
        # period usually sits there), then the body, then footers and notes.
        parts.sort(
            key=lambda item: (
                0
                if item.filename.startswith("word/header")
                else 1
                if item.filename == "word/document.xml"
                else 2,
                item.filename,
            )
        )
        for item in parts:
            path = PurePosixPath(item.filename)
            if item.flag_bits & 1 or path.is_absolute() or ".." in path.parts:
                raise CheckError("invalid_document")
            try:
                root = ElementTree.fromstring(_zip_part(archive, item, budget))
            except CheckError:
                raise
            except Exception:
                raise CheckError("invalid_document") from None
            lines = []
            for paragraph in root.iter(_W + "p"):
                pieces = []
                for node in paragraph.iter():
                    if node.tag == _W + "t":
                        pieces.append(node.text or "")
                    elif node.tag == _W + "tab":
                        pieces.append("\t")
                    elif node.tag in {_W + "br", _W + "cr"}:
                        pieces.append("\n")
                    elif node.tag == _W + "noBreakHyphen":
                        pieces.append("-")
                lines.append("".join(pieces))
            yield "\n".join(lines) + "\n"


def _image_text(content: bytes, ocr) -> tuple[str, dict]:
    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_SOURCE_PIXELS
    try:
        with Image.open(io.BytesIO(content)) as original:
            if original.format not in {"PNG", "JPEG"}:
                raise CheckError("invalid_document")
            width, height = original.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_SOURCE_PIXELS:
                raise PdfEngineError("page_render_budget_exceeded")
            if original.format == "JPEG":
                original.draft("L", (width, height))
            original.load()
            image = ImageOps.exif_transpose(original).convert("L")
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise CheckError("invalid_document") from None
    if image.width * image.height > MAX_RENDER_PIXELS:
        scale = (MAX_RENDER_PIXELS / (image.width * image.height)) ** 0.5
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))))
    payload = io.BytesIO()
    image.save(payload, format="PNG")
    return ocr(payload.getvalue())


def check(
    content: bytes,
    mime_type: str,
    groups: list[list[str]],
    *,
    max_text_pages: int,
    max_ocr_pages: int,
    ocr=ocr_png,
) -> dict:
    """Match concept groups and read header dates; the text is never returned."""
    if mime_type not in SUPPORTED_TYPES:
        raise CheckError("unsupported_format")
    if not content:
        raise CheckError("no_extractable_text")
    if len(content) > MAX_SOURCE_BYTES:
        raise CheckError("file_too_large")
    matcher = ConceptMatcher(groups)
    header: list[str] = []
    header_size = 0
    seen = 0
    stats = {"pages_read": 0, "total_pages": None, "ocr_pages": 0, "gaps": 0}
    # Whether every page or part was read within the page and text budgets.
    reached_end = False

    def take(text: str) -> bool:
        """Feed one piece of text; False once the text budget is spent."""
        nonlocal header_size, seen
        if header_size < HEADER_CHARS:
            piece = text[: HEADER_CHARS - header_size]
            header.append(piece)
            header_size += len(piece)
        remaining = MAX_MATCH_CHARS - seen
        if remaining <= 0:
            return False
        matcher.feed(text[:remaining])
        seen += min(len(text), remaining)
        return len(text) <= remaining

    def finished() -> bool:
        # Every group matched and the header is known: the rest cannot change
        # the answer, so the check stops early and spends no more CPU.
        return matcher.done and header_size >= HEADER_CHARS

    if mime_type == PDF:
        try:
            pdf = open_pdf(content)
        except PdfEngineError as error:
            raise CheckError(str(error)) from None
        try:
            total = len(pdf)
            if total < 1:
                raise CheckError("no_extractable_text")
            stats["total_pages"] = total
            end = min(total, max_text_pages)
            for page in iter_pdf_pages(pdf, 1, end, ocr=ocr, max_ocr_pages=max_ocr_pages):
                stats["pages_read"] += 1
                if page.method in {"ocr", "native_text+ocr"}:
                    stats["ocr_pages"] += 1
                if page.status in {"partial", "unreadable"}:
                    stats["gaps"] += 1
                if page.text and not take(page.text + "\n"):
                    break
                matcher.boundary()
                if finished():
                    break
            else:
                reached_end = end == total
        finally:
            pdf.close()
    elif mime_type in IMAGE_TYPES:
        stats["total_pages"] = 1
        if max_ocr_pages < 1:
            stats["gaps"] = 1
        else:
            try:
                text, quality = _image_text(content, ocr)
                stats["ocr_pages"] = 1
                stats["pages_read"] = 1
                if ocr_signal_error(quality):
                    stats["gaps"] = 1
                reached_end = take(text)
            except PdfEngineError:
                stats["gaps"] = 1
    else:
        if mime_type == DOCX:
            chunks: Iterable[str] = _docx_chunks(content)
            budget_stop = False
        elif mime_type == XLSX:
            try:
                parsed = parse_live_xlsx(content)
            except ParseError as error:
                raise CheckError(str(error)) from None
            chunks = parsed.pages
            budget_stop = parsed.truncated
        else:
            chunks = _text_chunks(content, mime_type)
            budget_stop = False
        for chunk in chunks:
            if not take(chunk):
                break
            if finished():
                break
        else:
            reached_end = not budget_stop
        stats["pages_read"] = 1
        stats["total_pages"] = 1
    matcher.boundary()
    opening = "".join(header)
    if not opening.strip() and stats["gaps"] == 0 and not matcher.matched:
        raise CheckError("no_extractable_text")
    result = {
        "matched": sorted(matcher.matched),
        "dates": header_readings(opening),
        **stats,
        # Final when nothing more could change the answer: every group
        # matched with the opening text read, or the whole file read cleanly.
        "complete": finished() or (reached_end and stats["gaps"] == 0),
    }
    return result


def _read_input(stream) -> tuple[list[list[str]], bytes]:
    prefix = stream.read(4)
    if len(prefix) != 4:
        raise CheckError("invalid_argument")
    (size,) = struct.unpack("!I", prefix)
    if not 2 <= size <= MAX_HEADER_BYTES:
        raise CheckError("invalid_argument")
    try:
        header = json.loads(stream.read(size))
    except (ValueError, UnicodeDecodeError):
        raise CheckError("invalid_argument") from None
    groups = header.get("concepts") if isinstance(header, dict) else None
    if (
        not isinstance(groups, list)
        or not 1 <= len(groups) <= MAX_GROUPS
        or any(not isinstance(group, list) or not group for group in groups)
        or sum(len(group) for group in groups) > MAX_SPELLINGS
        or any(
            not isinstance(item, str) or not 1 <= len(item) <= MAX_SPELLING_CHARS
            for group in groups
            for item in group
        )
    ):
        raise CheckError("invalid_argument")
    return groups, stream.read(MAX_SOURCE_BYTES + 1)


def main() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (65, 65))
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    except (ImportError, ValueError, OSError):
        # No OS resource boundary: fail closed before reading private input.
        sys.stdout.write(json.dumps({"error": "processor_unavailable"}))
        return
    try:
        options = json.loads(sys.argv[1])
        mime_type = options["mime_type"]
        text_pages = options["max_text_pages"]
        ocr_pages = options["max_ocr_pages"]
        if (
            not isinstance(mime_type, str)
            or type(text_pages) is not int
            or type(ocr_pages) is not int
            or not 1 <= text_pages <= MAX_TEXT_PAGES
            or not 0 <= ocr_pages <= MAX_OCR_PAGES
        ):
            raise CheckError("invalid_argument")
        groups, content = _read_input(sys.stdin.buffer)
        payload = check(
            content, mime_type, groups, max_text_pages=text_pages, max_ocr_pages=ocr_pages
        )
    except (CheckError, ParseError) as error:
        payload = {"error": str(error)}
    except Exception:
        payload = {"error": "processor_unavailable"}
    sys.stdout.write(json.dumps(payload))


if __name__ == "__main__":
    main()
