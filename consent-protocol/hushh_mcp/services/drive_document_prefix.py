"""Credential-free parsing of only an already bounded original-file prefix.

Never fetches missing ranges, renders, runs OCR or guesses text from PDF strings.
Recovery uses actual typed PDF objects and ZIP/XML members present in these bytes.
Execute inside the same constrained disposable child as the ordinary parser.
"""

from __future__ import annotations

import codecs
import io
import struct
import zipfile
import zlib
from pathlib import PurePosixPath
from xml.etree.ElementTree import ParseError as XMLParseError

from defusedxml.ElementTree import DefusedXMLParser

if __package__:
    from .drive_document_parser import (
        DOCX,
        MAX_TEXT_BYTES,
        ParsedText,
        ParseError,
        _bounded,
        parse_live_document,
    )
else:
    from drive_document_parser import (
        DOCX,
        MAX_TEXT_BYTES,
        ParsedText,
        ParseError,
        _bounded,
        parse_live_document,
    )

PREFIX_LIMIT = 200 * 1024
PREFIX_POLICY = "drive-prefix-v2"
PREFIX_METHODS = frozenset(
    {"standard", "pdf_prefix", "pdf_catalog_recovery", "docx_local_headers", "text_prefix"}
)
_ZIP_HEADER = struct.Struct("<4s5H3I2H")
_WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _text(content: bytes) -> ParsedText:
    if content.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        raise ParseError("unsupported_format")
    encoding = (
        "utf-16" if content.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else "utf-8-sig"
    )
    decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
    value = decoder.decode(content, final=False)
    if "\x00" in value:
        raise ParseError("invalid_document")
    parsed = _bounded((value,))
    return ParsedText(parsed.pages, True, "text_prefix")


class _WordText:
    def __init__(self):
        self.parts = []
        self.in_text = False
        self.size = 0
        self.started = False

    def start(self, tag, attributes):
        if not self.started:
            if tag != _WORD + "document":
                raise ParseError("invalid_document")
            self.started = True
        self.in_text = tag == _WORD + "t"

    def end(self, tag):
        if tag == _WORD + "p" and self.size < MAX_TEXT_BYTES:
            self.parts.append("\n")
            self.size += 1
        self.in_text = False

    def data(self, value):
        if self.in_text and self.size < MAX_TEXT_BYTES:
            raw = value.encode("utf-8")[: MAX_TEXT_BYTES - self.size]
            self.parts.append(raw.decode("utf-8", errors="ignore"))
            self.size += len(raw)

    def close(self):
        return "".join(self.parts)


def _word_xml(xml: bytes, *, complete: bool):
    target = _WordText()
    parser = DefusedXMLParser(
        target=target, forbid_dtd=True, forbid_entities=True, forbid_external=True
    )
    parser.feed(xml)  # Interior corruption and entity declarations always fail.
    try:
        parser.close()
    except XMLParseError:
        if complete:
            raise
        # feed() accepted every supplied byte; only the absent suffix may be ignored.
    return target.close()


def _docx(content: bytes) -> ParsedText:
    # Complete containers keep the ordinary safety checks, including entries
    # recorded only in their central directory. Recovery is for missing tails.
    if zipfile.is_zipfile(io.BytesIO(content)):
        parsed = parse_live_document(content, DOCX)
        return ParsedText(parsed.pages, parsed.truncated, "standard")
    offset, expanded = 0, 0
    seen = set()
    document = None
    while offset + _ZIP_HEADER.size <= len(content):
        signature, _, flags, method, _, _, crc, compressed, uncompressed, namesize, extra = (
            _ZIP_HEADER.unpack_from(content, offset)
        )
        if signature in {b"PK\x01\x02", b"PK\x05\x06"}:
            break
        descriptor = bool(flags & 8)
        if (
            signature != b"PK\x03\x04"
            or flags & ~(2 | 4 | 8 | 2048)
            or method not in {0, 8}
            or (descriptor and method == 0)
        ):
            raise ParseError("invalid_document")
        start = offset + _ZIP_HEADER.size + namesize + extra
        if start > len(content):
            break
        name = content[offset + _ZIP_HEADER.size : offset + _ZIP_HEADER.size + namesize].decode(
            "utf-8" if flags & 2048 else "cp437"
        )
        path = PurePosixPath(name)
        if (
            name in seen
            or len(seen) >= 2000
            or path.is_absolute()
            or ".." in path.parts
            or "\\" in name
            or "\x00" in name
            or "vbaproject" in name.casefold()
            or name.startswith("word/embeddings/")
            or compressed == 0xFFFFFFFF
            or uncompressed == 0xFFFFFFFF
            or uncompressed > max(1024 * 1024, compressed * 100)
        ):
            raise ParseError("invalid_document")
        extra_offset = offset + _ZIP_HEADER.size + namesize
        while extra_offset < start:
            if extra_offset + 4 > start:
                raise ParseError("invalid_document")
            tag, size = struct.unpack_from("<HH", content, extra_offset)
            extra_offset += 4 + size
            if tag == 1 or extra_offset > start:
                raise ParseError("invalid_document")
        seen.add(name)
        available = (
            content[start:]
            if descriptor
            else content[start : min(start + compressed, len(content))]
        )
        complete = not descriptor and len(available) == compressed
        limit = min(16 * 1024 * 1024 - expanded, max(1024 * 1024, len(available) * 100))
        if method == 8:
            decoder = zlib.decompressobj(-zlib.MAX_WBITS)
            xml = decoder.decompress(available, limit + 1)
            consumed = len(available) - len(decoder.unused_data)
            if (
                len(xml) > limit
                or decoder.unconsumed_tail
                or len(xml) > max(1024 * 1024, consumed * 100)
            ):
                raise ParseError("file_too_large")
            if descriptor:
                complete = decoder.eof
                compressed = consumed
            elif decoder.unused_data or decoder.eof != complete:
                raise ParseError("invalid_document")
        else:
            xml = available
            if len(xml) > limit:
                raise ParseError("file_too_large")
        next_offset = start + compressed
        if descriptor and complete:
            offsets = [next_offset]
            if content[next_offset : next_offset + 4] == b"PK\x07\x08":
                offsets.append(next_offset + 4)
            matches = [
                position
                for position in offsets
                if position + 12 <= len(content)
                and struct.unpack_from("<III", content, position)
                == (zlib.crc32(xml), compressed, len(xml))
            ]
            if len(matches) != 1:
                if max(offsets) + 12 > len(content):
                    break  # Do not guess a next member through a missing descriptor.
                raise ParseError("invalid_document")
            crc, uncompressed = zlib.crc32(xml), len(xml)
            next_offset = matches[0] + 12
        if not descriptor or complete:
            if (
                len(xml) > uncompressed
                or complete
                and (len(xml) != uncompressed or zlib.crc32(xml) != crc)
            ):
                raise ParseError("invalid_document")
        expanded += len(xml)
        if name == "word/document.xml":
            document = _word_xml(xml, complete=complete)
        if not complete:
            break
        offset = next_offset
    # Content_Types may be stored after large media beyond the prefix. The
    # exact member path, Word document root and namespace establish this text.
    if document is None:
        raise ParseError("invalid_document")
    parsed = _bounded((document,))
    return ParsedText(parsed.pages, True, "docx_local_headers")


def _pdf(content: bytes) -> ParsedText:
    from pdfminer import settings
    from pdfminer.converter import TextConverter
    from pdfminer.layout import LAParams
    from pdfminer.pdfdocument import PDFDocument, PDFNoValidXRef, PDFXRefFallback
    from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
    from pdfminer.pdfpage import PDFPage
    from pdfminer.pdfparser import PDFParser, PDFSyntaxError
    from pdfminer.pdftypes import PDFObjRef, PDFStream
    from pdfminer.psparser import LIT, PSEOF

    if not content.startswith(b"%PDF-"):
        raise ParseError("invalid_document")
    # Never run structural repair around a visible encryption declaration.
    if b"/Encrypt" in content:
        raise ParseError("encrypted_document")

    class PrefixDocument(PDFDocument):
        recovered = False

        def __init__(self, parser):
            try:
                super().__init__(parser, fallback=False)
            except (PDFSyntaxError, PDFNoValidXRef):
                if self.encryption is not None or self.catalog:
                    raise
                if not self.xrefs:
                    parser.fallback = True
                    xref = PDFXRefFallback()
                    try:
                        xref.load(parser)
                    except PSEOF:
                        # A cut final object must not discard earlier typed objects.
                        pass
                    self.xrefs.append(xref)
                candidates = []
                ids = set()
                for xref in self.xrefs:
                    if "Encrypt" in xref.get_trailer():
                        raise ParseError("encrypted_document")
                    for identity in xref.get_objids():
                        ids.add(identity)
                        if len(ids) > 4096:
                            raise ParseError("file_too_large")
                for identity in ids:
                    try:
                        value = self.getobj(identity)
                    except Exception:
                        continue
                    if isinstance(value, dict):
                        if value.get("Filter") is LIT("Standard"):
                            raise ParseError("encrypted_document")
                        if value.get("Type") is LIT("Catalog"):
                            candidates.append(value)
                if len(candidates) != 1 or "Pages" not in candidates[0]:
                    raise ParseError("invalid_document")
                self.catalog = candidates[0]
                self.recovered = True

    def resolve(value):
        return value.doc.getobj(value.objid) if isinstance(value, PDFObjRef) else value

    def stream(value):
        value = resolve(value)
        if not isinstance(value, PDFStream):
            raise ParseError("invalid_document")
        length = resolve(value.get("Length"))
        if type(length) is not int or length < 0 or len(value.rawdata or b"") < length:
            raise ParseError("invalid_document")
        if (value.rawdata or b"")[length:].strip(b"\r\n\t \x00\x0c"):
            raise ParseError("invalid_document")
        return value

    def rooted_pages(value, inherited=None, *, visited=None, depth=0):
        if depth > 64:
            raise ParseError("invalid_document")
        visited = set() if visited is None else visited
        identity = value.objid if isinstance(value, PDFObjRef) else id(value)
        if identity in visited or len(visited) >= 4096:
            raise ParseError("invalid_document")
        visited.add(identity)
        node = resolve(value)
        if not isinstance(node, dict):
            raise ParseError("invalid_document")
        attrs = {**(inherited or {}), **node}
        if node.get("Type") is LIT("Page"):
            # Validate before PDFPage's permissive resolution can drop a missing ref.
            contents = resolve(attrs.get("Contents", []))
            for item in contents if isinstance(contents, list) else [contents]:
                stream(item)
            yield PDFPage(document, identity, attrs, None)
        elif node.get("Type") is LIT("Pages"):
            kids = resolve(node.get("Kids"))
            if not isinstance(kids, list):
                raise ParseError("invalid_document")
            parent = {key: attrs[key] for key in PDFPage.INHERITABLE_ATTRS if key in attrs}
            for kid in kids:
                yield from rooted_pages(kid, parent, visited=visited, depth=depth + 1)
        else:
            raise ParseError("invalid_document")

    class PrefixInterpreter(PDFPageInterpreter):
        def render_contents(self, resources, streams, *args, **kwargs):
            resources = resolve(resources)
            if not isinstance(resources, dict):
                raise ParseError("invalid_document")
            fonts = resolve(resources.get("Font", {}))
            if not isinstance(fonts, dict):
                raise ParseError("invalid_document")
            for font in fonts.values():
                font = resolve(font)
                if not isinstance(font, dict):
                    raise ParseError("invalid_document")
                if "ToUnicode" in font:
                    stream(font["ToUnicode"])
            for value in streams:
                stream(value)
            return super().render_contents(resources, streams, *args, **kwargs)

    source = io.BytesIO(content)
    document = PrefixDocument(PDFParser(source))
    if document.encryption:
        raise ParseError("encrypted_document")
    output = io.StringIO()
    device = TextConverter(PDFResourceManager(), output, laparams=LAParams())
    interpreter = PrefixInterpreter(device.rsrcmgr, device)
    previous_strict = settings.STRICT
    settings.STRICT = True
    pages = []
    try:
        for number, page in enumerate(rooted_pages(document.catalog.get("Pages")), 1):
            if number > 4:
                break
            start = output.tell()
            interpreter.process_page(page)
            pages.append(output.getvalue()[start:])
            if len(" ".join(pages)) >= 500:
                break
    except ParseError:
        if not any(page.strip() for page in pages):
            raise
    except Exception:
        if not any(page.strip() for page in pages):
            raise ParseError("invalid_document") from None
    finally:
        settings.STRICT = previous_strict
        device.close()
        output.close()
        source.close()
    parsed = _bounded(pages)
    return ParsedText(
        parsed.pages, True, "pdf_catalog_recovery" if document.recovered else "pdf_prefix"
    )


def parse_prefix_document(content: bytes, mime_type: str) -> ParsedText:
    if not content or len(content) > PREFIX_LIMIT:
        raise ParseError("file_too_large" if content else "no_extractable_text")
    try:
        if mime_type in {"text/plain", "text/markdown"}:
            return _text(content)
        if mime_type == DOCX:
            return _docx(content)
        if mime_type == "application/pdf":
            return _pdf(content)
        parsed = parse_live_document(content, mime_type)
        return ParsedText(parsed.pages, parsed.truncated, "standard")
    except ParseError:
        raise
    except Exception:
        raise ParseError("invalid_document") from None
