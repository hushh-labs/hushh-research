"""No-tools suggestion stage fenced by a durable, narrowly consented job.

The background runner is NOT an A2A caller and has no Vault Owner token. Its
information authority is the current preparation lease and exact per-document
processing consent, rechecked before every read/model call and publication.
"""

import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Literal

from google.adk.models import Gemini
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
from hushh_mcp.runtime_providers import build_managed_runtime_client
from hushh_mcp.runtime_providers.gemini_config import resolve_fleet_model_name
from hushh_mcp.services.drive_document_retrieval import (
    DriveDocumentReader,
    DriveSuggestionRetrievalStore,
)
from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    LiveReviewedSource,
    ReviewedSource,
)
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError


class SuggestedFile(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    document_ref: str = Field(min_length=36, max_length=36)
    source_refs: list[str] = Field(min_length=1, max_length=8)


class DocumentSuggestions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    files: list[SuggestedFile] = Field(max_length=8)
    coverage_summary: str = Field(min_length=1, max_length=2000)
    gaps: list[str] = Field(max_length=24)
    coverage_status: Literal["complete", "partial", "unknown"]
    covered_periods: list["CoveredPeriod"] = Field(default_factory=list, max_length=24)


class CoveredPeriod(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    period_start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    period_end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source_refs: list[str] = Field(min_length=1, max_length=8)


def period_covered(
    purpose: dict, periods: list[CoveredPeriod], known: dict, ids: list[str]
) -> bool:
    start_text, end_text = purpose.get("periodStart"), purpose.get("periodEnd")
    if not start_text or not end_text:
        return True
    try:
        start, end = (
            date.fromisoformat(start_text).toordinal(),
            date.fromisoformat(end_text).toordinal(),
        )
        spans = []
        for item in periods:
            if any(
                ref not in known or known[ref]["document_ref"] not in ids
                for ref in item.source_refs
            ):
                return False
            left = date.fromisoformat(item.period_start).toordinal()
            right = date.fromisoformat(item.period_end).toordinal()
            if right < left:
                return False
            spans.append((left, right))
    except ValueError:
        return False
    cursor = start
    for left, right in sorted(spans):
        if left > cursor:
            return False
        cursor = max(cursor, right + 1)
        if cursor > end:
            return True
    return False


class LiveSearchPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    terms: list[str] = Field(min_length=1, max_length=3)


async def interpret_live_search(*, prompt, user_id):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_live_search")
    agent = build_single_turn_agent(
        gene,
        output_schema=LiveSearchPlan,
        model=Gemini(
            model=resolve_fleet_model_name(str(gene.model.name)),
            client=build_managed_runtime_client(gene.model.provider),
        ),
    )
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token="",
        timeout_seconds=20,  # nosec B106
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


async def interpret_suggestions(*, prompt, user_id):
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == "agent_documents_suggestions")
    if (
        gene.privacy.plaintext_telemetry
        or gene.runtime.adk_mode != "single_turn"
        or gene.runtime.transport != ["in_process"]
    ):
        raise ValueError("invalid suggestion interpreter")
    agent = build_single_turn_agent(
        gene,
        output_schema=DocumentSuggestions,
        model=Gemini(
            model=resolve_fleet_model_name(str(gene.model.name)),
            client=build_managed_runtime_client(gene.model.provider),
        ),
    )
    # Empty context grants no tool capability. Never mint/persist an owner
    # session to emulate an online user. The caller owns durable job fences.
    result = await run_single_turn(
        agent,
        prompt_parts=prompt,
        user_id=user_id,
        consent_token="",
        timeout_seconds=20,  # nosec B106
    )
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


class DriveSuggestionService:
    def __init__(
        self,
        *,
        oauth=None,
        store=None,
        interpreter=interpret_suggestions,
        search_planner=interpret_live_search,
        reader_factory=None,
    ):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveSuggestionStore(db=self.oauth.lifecycle.db)
        self.interpreter = interpreter
        self.search_planner = search_planner
        self.reader_factory = reader_factory

    def _reader(self, job):
        async def require_access():
            await self.store.require_preparation_current(job)

        if self.reader_factory:
            return self.reader_factory(user_id=job["user_id"], require_access=require_access)
        if job.get("live"):
            return DriveLiveReader(
                user_id=job["user_id"], require_access=require_access, oauth=self.oauth
            )
        return DriveDocumentReader(
            user_id=job["user_id"],
            require_access=require_access,
            oauth=self.oauth,
            store=DriveSuggestionRetrievalStore(db=self.store.db, cipher=self.store.cipher),
        )

    async def run_one(self, *, user_id, request_id):
        job = await self.store.claim_preparation(user_id=user_id, request_id=request_id)
        if job is None:
            return "not_claimed"
        try:
            async with asyncio.timeout(160):
                reader = self._reader(job)
                query = job["purpose"]["purpose"]
                if len(query.encode()) > 2048:
                    raise DriveSharingError("narrow_selection_required")
                if job.get("live"):
                    plan = LiveSearchPlan.model_validate(
                        await self.search_planner(
                            prompt=json.dumps(
                                {"document_request": job["purpose"]}, ensure_ascii=False
                            ),
                            user_id=user_id,
                        )
                    )
                    await self.store.require_preparation_current(job)
                    retrieved = await reader.search(query=plan.terms)
                else:
                    retrieved = await reader.search(query=query)
                if not retrieved["untrusted_external_content"]:
                    await self.store.fail_preparation(
                        job,
                        code="no_ready_files",
                        retryable=await self.store.indexing_pending(job),
                    )
                    return "no_ready_files"
                await reader.require_current()
                await self.store.require_preparation_current(job)
                answer = DocumentSuggestions.model_validate(
                    await self.interpreter(
                        prompt=json.dumps(
                            {"document_request": job["purpose"], "retrieved_documents": retrieved},
                            ensure_ascii=False,
                        ),
                        user_id=user_id,
                    )
                )
                payload = answer.model_dump(mode="json")
                if len(json.dumps(payload, ensure_ascii=False).encode()) > 12 * 1024:
                    raise ValueError("suggestions exceed budget")
                known = {
                    item["source_ref"]: item for item in retrieved["untrusted_external_content"]
                }
                ids = [item.document_ref for item in answer.files]
                if len(ids) != len(set(ids)) or (
                    answer.coverage_status == "complete" and (retrieved["truncated"] or not ids)
                ):
                    raise ValueError("unsupported coverage")
                for item in answer.files:
                    if len(item.source_refs) != len(set(item.source_refs)) or any(
                        ref not in known or known[ref]["document_ref"] != item.document_ref
                        for ref in item.source_refs
                    ):
                        raise ValueError("invented suggestion reference")
                if answer.coverage_status == "complete" and not period_covered(
                    job["purpose"], answer.covered_periods, known, ids
                ):
                    raise ValueError("unsupported coverage")
                await reader.require_current()
                await self.store.require_preparation_current(job)
                observed = {
                    str(row["document_id"]): (
                        LiveReviewedSource if row.get("_live") else ReviewedSource
                    ).model_validate(self.store._source_terms(row))
                    for row in reader._rows
                }
                if set(ids) - observed.keys():
                    raise ValueError("unobserved suggestion source")
                await self.store.prepare_review(
                    user_id=user_id,
                    generation=job["generation"],
                    request_id=request_id,
                    expected_revision=job["revision"],
                    document_ids=ids,
                    observed_sources=[observed[identifier] for identifier in ids],
                    coverage={
                        **payload,
                        "truncated": retrieved["truncated"],
                        "semanticStage": "completed",
                    },
                    preparation_lease_id=job["lease_id"],
                    read_sources=list(observed.values()),
                    live_sources=reader._rows if job.get("live") else None,
                )
                await wake_drive_work("sharing")
                return "review_ready"
        except Exception as error:
            code = str(error) if isinstance(error, DriveReadError) else "preparation_unavailable"
            await self.store.fail_preparation(
                job, code=code, retryable=not isinstance(error, DriveReadError) or error.retryable
            )
            return "unavailable"
