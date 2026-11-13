"""One-page PDF inputs without rendering, OCR loss, or filesystem copies."""

from __future__ import annotations

import io


class PdfPageSplitUnsupported(ValueError):
    pass


class PdfPages:
    def __init__(self, content: bytes):
        from pypdf import PdfReader

        self.stream = io.BytesIO(content)
        try:
            self.reader = PdfReader(self.stream, strict=True)
            if self.reader.is_encrypted:
                raise PdfPageSplitUnsupported("encrypted_pdf")
            self.count = len(self.reader.pages)
            if not self.count:
                raise PdfPageSplitUnsupported("empty_pdf")
        except Exception:
            self.stream.close()
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable") from None

    def page_bytes(self, index: int) -> bytes:
        from pypdf import PdfWriter

        try:
            with PdfWriter() as writer, io.BytesIO() as output:
                writer.add_page(self.reader.pages[index], excluded_keys=("/B",))
                writer.write(output)
                return output.getvalue()
        except Exception:
            raise PdfPageSplitUnsupported("pdf_page_split_unavailable") from None

    def close(self) -> None:
        self.reader.close()
        self.stream.close()
