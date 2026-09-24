"""Nonpersisting owner-authorized Drive read; the interpreter has no executable tools."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from google.adk.models import Gemini
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers import build_managed_runtime_client
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.drive_document_retrieval import DriveDocumentReader
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan, interpret_live_search
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DocumentAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    answer: str = Field(min_length=1, max_length=5000)
    source_refs: list[str] = Field(default_factory=list, max_length=8)


async def interpret(*, prompt, user_id, consent_token):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_interpreter")
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid document interpreter")
    agent = build_single_turn_agent(
        gene,
        output_schema=DocumentAnswer,
        model=Gemini(
            model=resolve_fleet_model_name(str(gene.model.name)),
            client=build_managed_runtime_client(gene.model.provider),
        ),
    )
    result = await run_single_turn(
        agent, prompt_parts=prompt, user_id=user_id, consent_token=consent_token, timeout_seconds=20
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


def result(conversation_id, answer, status, *, sources=(), truncated=False):
    return {
        "conversationId": conversation_id,
        "response": answer,
        "isComplete": True,
        "structured": {
            "schema_version": "specialist_read.v1",
            "connector": "drive",
            "status": status,
            "sources": list(sources),
            "truncated": truncated,
            "metadata_only": False,
        },
    }


class DriveChatService:
    def __init__(
        self,
        *,
        reader_factory=None,
        interpreter=interpret,
        oauth=None,
        search_planner=interpret_live_search,
    ):
        self.reader_factory = reader_factory
        self.interpreter = interpreter
        self.oauth = oauth
        self.search_planner = search_planner

    async def handle_delegated_turn(
        self, *, user_id, consent_token, conversation_id, message, require_access
    ):
        await require_access()
        if not message.strip() or len(message.encode()) > 2048:
            return result(
                conversation_id,
                "What would you like to know about your Drive files? Please keep the question brief.",
                "input_required",
            )
        try:
            async with asyncio.timeout(160):
                live = False
                if self.reader_factory:
                    reader = self.reader_factory(user_id=user_id, require_access=require_access)
                else:
                    oauth = self.oauth or get_external_connector_oauth_service().drive()
                    _, credential = await oauth.current_credential(user_id=user_id)
                    live = credential.get("profile") == "live"
                    reader = (DriveLiveReader if live else DriveDocumentReader)(
                        user_id=user_id, require_access=require_access, oauth=oauth
                    )
                query = message
                if live:
                    await require_access()
                    plan = LiveSearchPlan.model_validate(
                        await self.search_planner(
                            prompt=json.dumps(
                                {"document_request": {"purpose": message}}, ensure_ascii=False
                            ),
                            user_id=user_id,
                        )
                    )
                    query = plan.terms
                await require_access()
                retrieved = await reader.search(query=query)
                content = retrieved["untrusted_external_content"]
                if not content:
                    await reader.require_current()
                    return result(
                        conversation_id,
                        (
                            "I couldn't find a readable match. Try a more specific filename or request."
                            if live
                            else "This connection only covers previously selected files. Reconnect Drive to search your Drive."
                        ),
                        "input_required",
                    )
                answer = DocumentAnswer.model_validate(
                    await self.interpreter(
                        prompt=json.dumps(
                            {"user_request": message, "retrieved_documents": retrieved},
                            ensure_ascii=False,
                        ),
                        user_id=user_id,
                        consent_token=consent_token,
                    )
                )
                await reader.require_current()
                known = {item["source_ref"]: item for item in content}
                if not answer.source_refs or set(answer.source_refs) - known.keys():
                    raise ValueError("invalid document citations")
                sources = [
                    {
                        "source_ref": ref,
                        "label": "Document",
                        "kind": "document",
                        "page": known[ref]["page"],
                    }
                    for ref in dict.fromkeys(answer.source_refs)
                ]
                text = answer.answer
                if retrieved["truncated"]:
                    text += (
                        "\n\nThis answer uses bounded excerpts; some document content was omitted."
                    )
                return result(
                    conversation_id, text, "ok", sources=sources, truncated=retrieved["truncated"]
                )
        except PermissionError:
            raise
        except (DriveReadError, DriveOAuthError) as error:
            code = str(error)
            if code in {"connect_required", "not_connected"}:
                return result(
                    conversation_id,
                    "Connect Drive in Connectors to search and read files.",
                    "connect_required",
                )
            if code in {"reconnect_required", "needs_reauth"}:
                return result(
                    conversation_id,
                    "Reconnect Drive in Connectors to continue.",
                    "reconnect_required",
                )
            if code == "narrow_selection_required":
                return result(
                    conversation_id,
                    "Ask for a more specific document or period.",
                    "input_required",
                )
            if code == "invalid_argument":
                return result(
                    conversation_id,
                    "Please ask a shorter question about your Drive files.",
                    "input_required",
                )
            if code in {"source_changed", "connection_changed", "source_unavailable"}:
                return result(
                    conversation_id,
                    "Drive access or the file changed. Try again.",
                    "source_changed",
                )
        except Exception:
            pass  # Never log provider errors, prompts or document contents.
        return result(
            conversation_id,
            "Drive document reading is temporarily unavailable. Please try again.",
            "unavailable",
        )
