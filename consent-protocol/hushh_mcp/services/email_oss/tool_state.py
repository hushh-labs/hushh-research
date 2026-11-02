"""One invocation's review, effect settlement, and read-evidence authority."""

import asyncio
import json

from .protocol import _await, review_arguments_digest


class ToolState:
    def __init__(
        self, runtime, context, execution, directives, effects, uncertain_effects, read_receipt
    ):
        self.runtime, self.context, self.execution = (runtime, context, execution)
        self.directives, self.effects = (directives, effects)
        self.uncertain_effects, self.read_receipt = (uncertain_effects, read_receipt)
        self.effect_attempts = set()
        self.review_lock = asyncio.Lock()
        self.read_sources, self.message_inventory, self.source_refs = ({}, {}, {})
        self.search_started = False

    async def review(self, name, arguments):
        if self.runtime.review_port is None:
            return {"status": "confirmation_required", "executed": False}
        async with self.review_lock:
            if self.directives:
                return {
                    "status": "confirmation_required",
                    "executed": False,
                    "code": "another_review_pending",
                }
            review = await _await(self.runtime.review_port.review(self.context, name, arguments))
            await self.context.require_access()
            if not isinstance(review, dict):
                raise PermissionError("Invalid Email review outcome")
            if isinstance(review.get("directive"), dict):
                self.directives.append(review["directive"])
        if not (
            review.get("status") == "approved"
            and review.get("approved") is True
            and (review.get("tool_name") == name)
            and (review.get("arguments_sha256") == review_arguments_digest(arguments))
            and isinstance(review.get("receipt"), str)
            and review["receipt"]
        ):
            return {**review, "executed": False}

    async def invoke(self, name, arguments, *, mutation=False):
        await self.context.require_access()
        if mutation:
            review = await self.review(name, arguments)
            if review is not None:
                return review
        is_effect = mutation or name == "create_draft"
        if is_effect:
            identity = (name, review_arguments_digest(arguments))
            if identity in self.effect_attempts:
                return {
                    "status": "outcome_unknown",
                    "code": "duplicate_effect_blocked",
                    "executed": False,
                }
            self.effect_attempts.add(identity)
        method = getattr(self.execution, name)
        try:
            result = await _await(method(**arguments))
        except asyncio.CancelledError:
            if is_effect:
                self.uncertain_effects.append({"tool": name, "status": "outcome_unknown"})
            raise
        except Exception as error:
            if is_effect and getattr(error, "outcome_unknown", False):
                self.uncertain_effects.append({"tool": name, "status": "outcome_unknown"})
            if not is_effect or not getattr(error, "outcome_unknown", False):
                states = {
                    "GMAIL_NOT_CONNECTED": "connect_required",
                    "GMAIL_READ_PERMISSION_REQUIRED": "reconnect_required",
                    "GMAIL_REAUTH_REQUIRED": "reconnect_required",
                    "GMAIL_COMPOSE_PERMISSION_REQUIRED": "permission_denied",
                    "GMAIL_CONNECTION_CHANGED": "connection_changed",
                    "reconnect_required": "reconnect_required",
                    "permission_denied": "permission_denied",
                    "not_found": "not_found",
                    "response_too_large": "response_too_large",
                    "invalid_argument": "invalid_argument",
                }
                state = states.get(getattr(error, "code", None))
                if state:
                    await self.context.require_access()
                    self.read_receipt["status"] = (
                        "source_changed" if state == "not_found" else state
                    )
                    return {"status": state, "code": state}
            raise
        if (
            is_effect
            and isinstance(result, dict)
            and (result.get("status") in {"success", "sent", "draft_created"})
        ):
            self.effects.append({"tool": name})
        await self.context.require_access()
        return self.record_read(name, result)

    def record_read(self, name, result):
        if name in {"search_threads", "get_thread", "get_message"} and isinstance(result, dict):
            if len(json.dumps(result, ensure_ascii=False).encode()) > 256 * 1024:
                self.read_receipt.update(status="response_too_large", truncated=True)
                return {
                    "status": "response_too_large",
                    "code": "response_too_large",
                    "message": "Request a smaller page or one exact message.",
                }
            rows = [result] if name == "get_message" else result.get("messages", [])
            self.read_receipt["truncated"] |= bool(
                result.get("truncated") or result.get("failed_count")
            )
            for row in rows:
                if isinstance(row, dict) and isinstance(row.get("id"), str):
                    self.message_inventory[row["id"]] = row
                    if row["id"] not in self.source_refs and len(self.source_refs) < 60:
                        source = {
                            "source_ref": f"mail:{len(self.source_refs) + 1}",
                            "label": str(row.get("subject") or "Mail")[:80],
                            "kind": "message" if "body" in row else "metadata",
                        }
                        self.source_refs[row["id"]] = source
                        self.read_receipt["sources"].append(source)
                    elif row["id"] not in self.source_refs:
                        self.read_receipt["truncated"] = True
                    elif "body" in row:
                        self.source_refs[row["id"]]["kind"] = "message"
                    if "body" in row:
                        self.read_receipt["metadata_only"] = False
                    self.read_receipt["truncated"] |= bool(
                        row.get("body_truncated")
                        or row.get("attachment_inventory_complete") is False
                    )
                if (
                    isinstance(row, dict)
                    and isinstance(row.get("body"), str)
                    and row["body"].strip()
                ):
                    self.read_sources[str(row.get("id"))] = row["body"]
        return result
