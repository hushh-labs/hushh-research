"""Small synthetic PDF/DOCX/image fixtures built in memory (no real user data).

Every builder writes its own bytes: no font files, no network, no third-party
PDF writer. Encrypted fixtures use the PDF Standard security handler (RC4,
revision 2), which is enough for PDFium to tell an owner-only password (opens
without a prompt) from a user password (refuses to open).
"""

from __future__ import annotations

import hashlib
import io
import struct
import zipfile

PAD = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")
HELVETICA = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"


def build_pdf(objects: list[bytes], *, trailer_extra: bytes = b"") -> bytes:
    """Objects are numbered from 1; object 1 must be the catalog."""
    payload = b"%PDF-1.4\n"
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(payload))
        payload += str(number).encode() + b" 0 obj\n" + value + b"\nendobj\n"
    xref = len(payload)
    payload += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    payload += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    return payload + (
        b"trailer\n<< /Size %d /Root 1 0 R " % (len(objects) + 1)
        + trailer_extra
        + b" >>\nstartxref\n%d\n%%%%EOF" % xref
    )


def stream(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length %d %s>>\nstream\n" % (len(data), extra) + data + b"\nendstream"


def _text_ops(lines: list[str], *, mode: int = 0, size: int = 11) -> bytes:
    body = b"BT %d Tr /F1 %d Tf " % (mode, size)
    y = 760
    for line in lines:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        body += b"1 0 0 1 40 %d Tm (%s) Tj " % (y, escaped.encode("latin-1"))
        y -= 16
    return body + b"ET"


def text_pdf(*pages: list[str]) -> bytes:
    """A digital PDF: one list of text lines per page, Helvetica, Letter size."""
    count = len(pages)
    kids = " ".join(f"{3 + 2 * index} 0 R" for index in range(count)).encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [%s] /Count %d >>"]
    objects[1] = objects[1] % (kids, count)
    font_number = 3 + 2 * count
    for index, lines in enumerate(pages):
        content_number = 4 + 2 * index
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
            % (font_number, content_number)
        )
        objects.append(stream(_text_ops(lines)))
    objects.append(HELVETICA)
    return build_pdf(objects)


def statement_lines(code: str = "INV_2026_HDFC_9981") -> list[str]:
    return [
        "HDFC Bank account statement",
        "Statement period: 01 Sep 2026 - 30 Sep 2026",
        f"Reference {code}",
        "Opening balance and closing balance for the savings account holder.",
        "Transactions are listed below with value dates and narration details.",
    ]


def scanned_page_pdf(lines: list[str] | None = None) -> bytes:
    """One raster-only page (a scan): no text layer at all."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("L", (1275, 1650), 255)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=36)
    for number, line in enumerate(lines or ["Scanned HDFC statement", "September 2026"]):
        draw.text((80, 120 + number * 70), line, fill=0, font=font)
    output = io.BytesIO()
    image.save(output, format="PDF", resolution=150)
    return output.getvalue()


def joined_pdf(*sources: bytes) -> bytes:
    import pypdfium2

    target = pypdfium2.PdfDocument.new()
    try:
        for source in sources:
            document = pypdfium2.PdfDocument(source)
            try:
                target.import_pages(document)
            finally:
                document.close()
        output = io.BytesIO()
        target.save(output)
        return output.getvalue()
    finally:
        target.close()


def _gray_image_xobject(width: int = 64, height: int = 64) -> bytes:
    return stream(
        bytes([235]) * (width * height),
        b"/Type /XObject /Subtype /Image /Width %d /Height %d "
        b"/ColorSpace /DeviceGray /BitsPerComponent 8 " % (width, height),
    )


def ocr_layer_pdf(lines: list[str]) -> bytes:
    """A scanner's output: a full-page image under an invisible text layer."""
    content = b"q 612 0 0 792 0 0 cm /Im1 Do Q " + _text_ops(lines, mode=3)
    return build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << "
            b"/Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
            HELVETICA,
            stream(content),
            _gray_image_xobject(),
        ]
    )


def image_banner_pdf(lines: list[str]) -> bytes:
    """Plenty of real text plus an image covering half the page."""
    content = b"q 612 0 0 396 0 0 cm /Im1 Do Q " + _text_ops(lines)
    return build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << "
            b"/Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
            HELVETICA,
            stream(content),
            _gray_image_xobject(),
        ]
    )


def broken_middle_page_pdf() -> bytes:
    """Three pages; the middle page object is not a dictionary (damaged file)."""
    return build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R 7 0 R 8 0 R] /Count 3 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            HELVETICA,
            stream(_text_ops(["Page one HDFC statement September 2026 opening balance"])),
            stream(_text_ops(["Page three HDFC statement closing balance and narration"])),
            b"42",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
        ]
    )


def devanagari_pdf(lines: list[str]) -> bytes:
    """Unicode Devanagari text through a ToUnicode CMap (no font file needed)."""
    characters = sorted({character for line in lines for character in line})
    cid = {character: index + 1 for index, character in enumerate(characters)}
    cmap = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap "
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def "
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def "
        "1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
    )
    items = list(cid.items())
    for start in range(0, len(items), 100):
        chunk = items[start : start + 100]
        cmap += f"{len(chunk)} beginbfchar\n"
        cmap += "".join(f"<{code:04X}> <{ord(character):04X}>\n" for character, code in chunk)
        cmap += "endbfchar\n"
    cmap += "endcmap CMapName currentdict /CMap defineresource pop end end"
    content = b"BT /F1 14 Tf "
    y = 760
    for line in lines:
        codes = "".join(f"{cid[character]:04X}" for character in line)
        content += f"1 0 0 1 40 {y} Tm <{codes}> Tj ".encode()
        y -= 30
    content += b"ET"
    return build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticDeva /Encoding /Identity-H "
            b"/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
            stream(content),
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticDeva "
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            b"/FontDescriptor 8 0 R /DW 600 /CIDToGIDMap /Identity >>",
            stream(cmap.encode()),
            b"<< /Type /FontDescriptor /FontName /SyntheticDeva /Flags 4 "
            b"/FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 "
            b"/CapHeight 700 /StemV 80 >>",
        ]
    )


def _rc4(key: bytes, data: bytes) -> bytes:
    state = list(range(256))
    j = 0
    for i in range(256):
        j = (j + state[i] + key[i % len(key)]) % 256
        state[i], state[j] = state[j], state[i]
    i = j = 0
    out = bytearray()
    for byte in data:
        i = (i + 1) % 256
        j = (j + state[i]) % 256
        state[i], state[j] = state[j], state[i]
        out.append(byte ^ state[(state[i] + state[j]) % 256])
    return bytes(out)


def encrypted_pdf(*, user_password: bytes, owner_password: bytes, lines: list[str]) -> bytes:
    """Standard security handler, RC4 40-bit (revision 2), one text page."""

    def padded(password: bytes) -> bytes:
        return (password + PAD)[:32]

    file_id = hashlib.md5(b"synthetic-fixture-id", usedforsecurity=False).digest()
    permissions = -44
    owner_key = hashlib.md5(
        padded(owner_password or user_password), usedforsecurity=False
    ).digest()[:5]
    owner_entry = _rc4(owner_key, padded(user_password))
    key = hashlib.md5(
        padded(user_password) + owner_entry + struct.pack("<i", permissions) + file_id,
        usedforsecurity=False,
    ).digest()[:5]
    user_entry = _rc4(key, PAD)
    object_key = hashlib.md5(
        key + struct.pack("<I", 5)[:3] + struct.pack("<H", 0), usedforsecurity=False
    ).digest()[:10]
    content = _rc4(object_key, _text_ops(lines))
    return build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            HELVETICA,
            stream(content),
            b"<< /Filter /Standard /V 1 /R 2 /O <%s> /U <%s> /P %d >>"
            % (owner_entry.hex().encode(), user_entry.hex().encode(), permissions),
        ],
        trailer_extra=b"/Encrypt 6 0 R /ID [<%s> <%s>]"
        % (file_id.hex().encode(), file_id.hex().encode()),
    )


def docx(body_xml: bytes, *, extra: dict[str, bytes] | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", body_xml)
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


W = b'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def docx_paragraphs(*runs: bytes) -> bytes:
    body = b"".join(b"<w:p>" + run + b"</w:p>" for run in runs)
    return b"<w:document " + W + b"><w:body>" + body + b"</w:body></w:document>"


def png_image(lines: list[str]) -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1200, 400), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=40)
    for number, line in enumerate(lines):
        draw.text((30, 40 + number * 80), line, fill="black", font=font)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
