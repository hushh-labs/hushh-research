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
        state = self.state
        arguments = {
            "q": q,
            "max_results": max_results,
            "page_token": page_token,
            "include_clean_body": include_clean_body,
        }
        failure = state.search_failure
        if (
            state.search_in_progress
            or state.search_attempts >= 2
            or (state.search_attempts and failure is None)
        ):
            return {
                "status": "input_required",
                "code": "page_requires_next_user_turn",
                "message": "Use a new turn for another Gmail search page.",
            }
        if failure is not None:
            code, previous = failure
            same_page = page_token == previous["page_token"]
            same_depth = include_clean_body == previous["include_clean_body"]
            corrected = (
                q != previous["q"] and max_results == previous["max_results"]
                if code == "invalid_argument"
                else q == previous["q"] and max_results < previous["max_results"]
            )
            if not (same_page and same_depth and corrected):
                return {
                    "status": "input_required",
                    "code": "search_correction_required",
                    "message": "Correct the failed query or reduce the oversized page without advancing it.",
                }
        state.search_attempts += 1
        state.search_in_progress = True
        state.search_failure = None
        try:
            result = await state.invoke("search_threads", arguments)
        finally:
            state.search_in_progress = False
        code = result.get("code")
        if code in {"invalid_argument", "response_too_large"} and state.search_attempts == 1:
            state.search_failure = (code, arguments)
        if failure and isinstance(result.get("messages"), list):
            if state.read_receipt.get("status") == failure[0]:
                state.read_receipt["status"] = "ok"
        return result

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
        runtime = self.state.runtime
        scan_parse = runtime.attachment_scan_parse
        if scan_parse is not None and not getattr(scan_parse, "available", True):
            self.state.read_receipt["truncated"] = True
            return {"status": "unresolved", "code": "attachment_worker_unavailable", "amount": None}
        blob = await self.state.invoke(
            "get_attachment", {"message_id": message_id, "attachment_id": attachment_id}
        )
        content = blob.get("content") if isinstance(blob, dict) else None
        if not isinstance(content, bytes) or not content or len(content) > 4 * 1024 * 1024:
            self.state.read_receipt["truncated"] = True
            return {"status": "unavailable", "code": "attachment_bytes_unavailable"}
        await self.state.context.require_access()
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        parse_mime = "text/csv" if mime == "application/csv" else mime
        try:
            async with asyncio.timeout(12):
                if scan_parse is not None:
                    parsed = await scan_parse(content=content, mime_type=parse_mime)
                else:
                    from hushh_mcp.services.drive_document_processor import (
                        ClamAvScanner,
                        IsolatedDocumentParser,
                    )

                    scanner = runtime.attachment_scanner or ClamAvScanner()
                    parser = runtime.attachment_parser or IsolatedDocumentParser()
                    await scanner.scan(content)
                    parsed = await parser.parse(content=content, mime_type=parse_mime, live=True)
        except TimeoutError:
            await self.state.context.require_access()
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
