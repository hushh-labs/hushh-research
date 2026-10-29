"""Small public synthetic media fixtures for managed capability qualification."""

import io
import struct
import wave
import zlib


def _png(rgb: bytes) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack("!I", len(body))
            + kind
            + body
            + struct.pack("!I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!2I5B", 128, 128, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress((b"\x00" + rgb * 128) * 128))
        + chunk(b"IEND", b"")
    )


def _pdf(text: str) -> bytes:
    stream = f"BT /F1 20 Tf 40 100 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(str(index).encode() + b" 0 obj\n" + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    )
    return bytes(output)


def _wav16(pcm24: bytes) -> bytes:
    samples = [item[0] for item in struct.iter_unpack("<h", pcm24)]
    downsampled = [samples[index] for index in range(len(samples)) if index % 3 != 1]
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(struct.pack(f"<{len(downsampled)}h", *downsampled))
    return buffer.getvalue()
