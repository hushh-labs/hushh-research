"""One bounded, memory-only HTTP attachment, saved by the owner into Files.

No website refetch, plaintext file, model payload or second storage authority.
Browser terminal cleanup discards any attachment not saved by the owner.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
from email.message import Message
from uuid import uuid4

from pydantic import Field

from .contracts import BrowserRefused, BrowserResponse, StrictContract


class BrowserDownloadOffer(StrictContract):
    download_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(min_length=1, max_length=255, repr=False)
    size: int = Field(ge=0, le=4 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class BrowserDownloads:
    def __init__(self) -> None:
        self._offer: BrowserDownloadOffer | None = None
        self._data: bytes | None = None
        self._receipt: dict | None = None
        self._terms: tuple[str, str] | None = None
        self._lock = asyncio.Lock()

    @property
    def offers(self) -> tuple[BrowserDownloadOffer, ...]:
        return (self._offer,) if self._offer is not None and self._receipt is None else ()

    def capture(self, response: BrowserResponse) -> BrowserResponse:
        values = [v for n, v in response.headers if n.lower() == "content-disposition"]
        if not values or not 200 <= response.status < 300:
            return response
        if len(values) != 1:
            raise BrowserRefused("BROWSER_DOWNLOAD_INVALID")
        header = Message()
        header["Content-Disposition"] = values[0]
        if header.get_content_disposition() != "attachment":
            return response
        if self._offer is not None:
            raise BrowserRefused("BROWSER_DOWNLOAD_LIMIT")
        from hushh_mcp.services.pod_files.contracts import display_name

        name = header.get_filename() or "download"
        try:
            display_name(name)
        except Exception:
            name = "download"
        self._offer = BrowserDownloadOffer(
            download_id=uuid4().hex,
            name=name,
            size=len(response.body),
            sha256=hashlib.sha256(response.body).hexdigest(),
        )
        self._data = response.body
        # The worker receives only a capture acknowledgement. Chromium never
        # writes a download artifact or receives the attachment's bytes.
        return BrowserResponse(
            status=204,
            headers=tuple((n, v) for n, v in response.headers if n.lower() == "set-cookie"),
            body=b"",
            download_id=self._offer.download_id,
        )

    async def save(
        self, download_id: str, *, name: str, parent: str, check, record_created=None
    ) -> dict:
        from hushh_mcp.services.pod_files.completion import complete_upload
        from hushh_mcp.services.pod_files.runtime import files_access, operation

        async with self._lock:
            await check()
            offer = self._offer
            if offer is None or offer.download_id != download_id:
                raise BrowserRefused("BROWSER_DOWNLOAD_UNAVAILABLE")
            if self._terms is not None and self._terms != (name, parent):
                raise BrowserRefused("BROWSER_DOWNLOAD_DESTINATION_CHANGED")
            self._terms = (name, parent)
            data = self._data  # admitted save owns these bytes until its joined settlement
            with files_access(check, manage=check):
                async with operation() as library:
                    async with operation(mutation=True):
                        entry = await library.create(
                            name=name,
                            parent=parent,
                            size=offer.size,
                            request_id="browser-download-" + download_id,
                        )
                        if record_created is not None:
                            record_created(
                                {
                                    "file_id": entry["id"],
                                    "bytes": offer.size,
                                    "sha256": offer.sha256,
                                    "verified": False,
                                }
                            )
                        if entry["state"] != "ready":
                            if data is None:
                                raise BrowserRefused("BROWSER_DOWNLOAD_UNAVAILABLE")
                            if data:
                                await library.put_chunk(entry["id"], 0, data)

                    async def verify() -> None:
                        actual = await library.read_chunk(entry["id"], 0) if offer.size else b""
                        if not hmac.compare_digest(
                            hashlib.sha256(actual).hexdigest(), offer.sha256
                        ):
                            raise BrowserRefused("BROWSER_DOWNLOAD_INTEGRITY_FAILED")

                    completed = await complete_upload(
                        library, entry["id"], mutation=operation(mutation=True), verify=verify
                    )
                    await check()
                    self._receipt = {
                        "file_id": entry["id"],
                        "sha256": offer.sha256,
                        "bytes": offer.size,
                        "verified": True,
                    }
                    if "organization" in completed:
                        self._receipt["organization"] = completed["organization"]
                    self._data = None
                    return dict(self._receipt)

    def clear(self) -> None:
        self._data = self._receipt = self._offer = None
