"""Bounded native Gmail reads and the existing isolated attachment parser."""

import asyncio

from .protocol import _await


class GmailReadTools:
    def __init__(self, state):
        self.state = state

    async def search_threads(
        self,
        q: str,
        max_results: int = 25,
        page_token: str | None = None,
        include_clean_body: bool = False,
    ):
        if self.state.search_started:
            return {
                "status": "input_required",
                "code": "page_requires_next_user_turn",
                "message": "This turn already read one search page. Ask to continue on the next turn.",
            }
        self.state.search_started = True
        return await self.state.invoke(
            "search_threads",
            {
                "q": q,
                "max_results": max_results,
                "page_token": page_token,
                "include_clean_body": include_clean_body,
            },
        )

    async def get_message(self, message_id: str):
        return await self.state.invoke("get_message", {"message_id": message_id})

    async def get_thread(self, thread_id: str):
        return await self.state.invoke("get_thread", {"thread_id": thread_id})

    async def get_attachment(self, message_id: str, attachment_id: str):
        message = self.state.message_inventory.get(message_id)
        if message is None:
            message = await self.state.invoke("get_message", {"message_id": message_id})
        inventory = message.get("attachments", []) if isinstance(message, dict) else []
        meta = next(
            (item for item in inventory if item.get("attachment_id") == attachment_id), None
        )
        if meta is None:
            self.state.read_receipt["truncated"] = True
            return {"status": "unavailable", "code": "attachment_not_in_message"}
        mime = str(meta.get("mime_type") or "")
        if mime not in {"application/pdf", "text/csv", "application/csv"}:
            self.state.read_receipt["truncated"] = True
            return {"status": "unsupported", "attachment": meta}
        blob = await self.state.invoke(
            "get_attachment", {"message_id": message_id, "attachment_id": attachment_id}
        )
        content = blob.get("content") if isinstance(blob, dict) else None
        if not isinstance(content, bytes) or not content or len(content) > 4 * 1024 * 1024:
            self.state.read_receipt["truncated"] = True
            return {"status": "unavailable", "code": "attachment_bytes_unavailable"}
        from hushh_mcp.services.drive_document_processor import (
            ClamAvScanner,
            IsolatedDocumentParser,
        )

        scanner = self.state.runtime.attachment_scanner or ClamAvScanner()
        parser = self.state.runtime.attachment_parser or IsolatedDocumentParser()
        await self.state.context.require_access()
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        try:
            async with asyncio.timeout(12):
                await scanner.scan(content)
                parsed = await parser.parse(
                    content=content,
                    mime_type="text/csv" if mime == "application/csv" else mime,
                    live=True,
                )
        except TimeoutError:
            self.state.read_receipt["truncated"] = True
            return {"status": "unresolved", "code": "attachment_timeout", "amount": None}
        except DriveReadError:
            await self.state.context.require_access()
            self.state.read_receipt["truncated"] = True
            return {"status": "unresolved", "code": "attachment_unreadable", "amount": None}
        await self.state.context.require_access()
        text = "\n\n".join(parsed.pages)
        self.state.read_receipt["metadata_only"] = False
        self.state.read_receipt["truncated"] |= bool(parsed.truncated or len(text) > 30000)
        if text.strip():
            self.state.read_sources[f"{message_id}/{attachment_id}"] = text[:30000]
        return {
            "status": "ok",
            "message_id": message_id,
            "attachment_id": attachment_id,
            "source_ref": f"{message_id}/{attachment_id}",
            "filename": meta.get("filename"),
            "mime_type": mime,
            "text": text[:30000],
            "truncated": parsed.truncated or len(text) > 30000,
        }

    async def get_connection_status(self):
        await self.state.context.require_access()
        if self.state.runtime.connection_status_port is None:
            return {"status": "unavailable", "connected": None, "sync_status": "unknown"}
        result = await _await(self.state.runtime.connection_status_port(self.state.context))
        await self.state.context.require_access()
        if isinstance(result, dict) and result.get("connected") is False:
            self.state.read_receipt["status"] = "connect_required"
        return result
