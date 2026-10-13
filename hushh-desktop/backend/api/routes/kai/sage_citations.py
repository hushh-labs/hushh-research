# api/routes/kai/sage_citations.py
"""
Sage's citation-lineage explorer: real academic search plus citation-graph
edges from OpenAlex (free, unauthenticated, no rate-limit wall) -- what a
paper cites (references) and what cites it (cited_by), the "trace the
lineage of an idea" half of turning Sage from a second-brain into an
active researcher.

Semantic Scholar was the original candidate but its unauthenticated tier
returned HTTP 429 on the very first live call made while building this --
OpenAlex covers the same graph (via its `cites:` and id filters) with no
such wall, so it's the one actually wired up.
"""

import asyncio
import json
import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token

logger = logging.getLogger(__name__)

router = APIRouter()

_OPENALEX_BASE = "https://api.openalex.org"
_TIMEOUT = httpx.Timeout(connect=3.0, read=8.0, write=5.0, pool=3.0)
_USER_AGENT = "hushh-desktop-sage/1.0 (personal research assistant)"
_MAX_SEARCH_RESULTS = 6
_MAX_REFERENCES = 15
_MAX_CITED_BY = 10
_MODEL = "gemini-3.1-flash-lite"
_INSIGHT_TIMEOUT_SECONDS = 8.0
_WORK_SELECT_FIELDS = "id,title,display_name,publication_year,authorships,cited_by_count,primary_topic"
_INSIGHT_SELECT_FIELDS = (
    "id,title,display_name,publication_year,authorships,cited_by_count,"
    "primary_topic,abstract_inverted_index,referenced_works"
)


class PaperSummary(BaseModel):
    id: str
    title: str
    year: int | None = None
    authors: list[str] = Field(default_factory=list)
    cited_by_count: int = 0
    topic: str | None = None


class PaperSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=300)


class PaperSearchResponse(BaseModel):
    results: list[PaperSummary] = Field(default_factory=list)


class PaperLineageRequest(BaseModel):
    work_id: str = Field(..., min_length=1, max_length=64)


class PaperLineageResponse(BaseModel):
    paper: PaperSummary
    references: list[PaperSummary] = Field(default_factory=list)
    cited_by: list[PaperSummary] = Field(default_factory=list)


class PaperInsightRequest(BaseModel):
    work_id: str = Field(..., min_length=1, max_length=64)


class PaperInsightResponse(BaseModel):
    insight: str
    topic: str | None = None
    has_abstract: bool = False


def _short_id(raw: str) -> str:
    """OpenAlex ids come back as full URLs (https://openalex.org/W123) --
    normalize to the bare 'W123' form used in filter queries and our own
    responses."""
    return raw.rsplit("/", 1)[-1].strip()


def _authors_from_work(work: dict) -> list[str]:
    names: list[str] = []
    for authorship in (work.get("authorships") or [])[:5]:
        author = authorship.get("author") or {}
        name = str(author.get("display_name") or "").strip()
        if name:
            names.append(name)
    return names


def _topic_from_work(work: dict) -> str | None:
    primary_topic = work.get("primary_topic") or {}
    if not isinstance(primary_topic, dict):
        return None
    name = str(primary_topic.get("display_name") or "").strip()
    return name or None


def _summary_from_work(work: dict) -> PaperSummary:
    return PaperSummary(
        id=_short_id(str(work.get("id") or "")),
        title=str(work.get("title") or work.get("display_name") or "Untitled").strip(),
        year=work.get("publication_year"),
        authors=_authors_from_work(work),
        cited_by_count=int(work.get("cited_by_count") or 0),
        topic=_topic_from_work(work),
    )


def _reconstruct_abstract(inverted_index: dict | None) -> str:
    """OpenAlex stores abstracts as {word: [positions]} to dodge publisher
    copyright on full-text redistribution -- this is the real abstract,
    just word-shuffled; putting it back in order is a one-time O(n log n) sort."""
    if not isinstance(inverted_index, dict) or not inverted_index:
        return ""
    positions: list[tuple[int, str]] = []
    for word, idxs in inverted_index.items():
        if not isinstance(idxs, list):
            continue
        for idx in idxs:
            if isinstance(idx, int):
                positions.append((idx, word))
    positions.sort(key=lambda p: p[0])
    return " ".join(word for _, word in positions)[:3000]


@router.post("/sage/paper-search", response_model=PaperSearchResponse)
async def search_papers(
    payload: PaperSearchRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PaperSearchResponse:
    """
    Free-text search over OpenAlex -- returns a short candidate list for the
    user to pick from rather than trusting the single top hit: relevance-
    ranked full-text search on a generic title can surface an unrelated
    paper (confirmed live while building this), so the caller always picks.

    **Authentication**: Requires valid VAULT_OWNER token, same gate as
    every other Sage endpoint -- this is a proxy the app pays the (small)
    external-call cost for, not something to leave open.
    """
    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Search text is required")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": _USER_AGENT}) as client:
            res = await client.get(
                f"{_OPENALEX_BASE}/works",
                params={
                    "search": query,
                    "per-page": _MAX_SEARCH_RESULTS,
                    "select": _WORK_SELECT_FIELDS,
                },
            )
            res.raise_for_status()
            data = res.json() or {}
    except Exception as exc:
        logger.warning("[sage_citations] paper search failed: %s", exc)
        raise HTTPException(status_code=502, detail="Couldn't search papers just now.")

    results = [_summary_from_work(w) for w in (data.get("results") or [])]
    return PaperSearchResponse(results=results)


@router.post("/sage/paper-lineage", response_model=PaperLineageResponse)
async def paper_lineage(
    payload: PaperLineageRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PaperLineageResponse:
    """
    Traces one paper's citation lineage in both directions: what it cites
    (references) and what cites it (cited_by, sorted by each citing paper's
    own cited_by_count as a rough "which downstream work is actually core"
    signal). Three OpenAlex calls total (the work itself, its references
    batch-fetched by id, and its citing works), all unauthenticated.

    **Authentication**: Requires valid VAULT_OWNER token, same as
    search_papers above.
    """
    work_id = payload.work_id.strip()
    if not work_id:
        raise HTTPException(status_code=400, detail="A paper id is required")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": _USER_AGENT}) as client:
            work_res = await client.get(f"{_OPENALEX_BASE}/works/{work_id}")
            work_res.raise_for_status()
            work = work_res.json() or {}

            reference_ids = [_short_id(r) for r in (work.get("referenced_works") or [])][:_MAX_REFERENCES]
            references: list[PaperSummary] = []
            if reference_ids:
                ref_res = await client.get(
                    f"{_OPENALEX_BASE}/works",
                    params={
                        "filter": f"openalex_id:{'|'.join(reference_ids)}",
                        "per-page": len(reference_ids),
                        "select": _WORK_SELECT_FIELDS,
                    },
                )
                if ref_res.is_success:
                    references = [_summary_from_work(w) for w in (ref_res.json().get("results") or [])]

            cited_by: list[PaperSummary] = []
            citing_res = await client.get(
                f"{_OPENALEX_BASE}/works",
                params={
                    "filter": f"cites:{work_id}",
                    "sort": "cited_by_count:desc",
                    "per-page": _MAX_CITED_BY,
                    "select": _WORK_SELECT_FIELDS,
                },
            )
            if citing_res.is_success:
                cited_by = [_summary_from_work(w) for w in (citing_res.json().get("results") or [])]
    except httpx.HTTPStatusError as exc:
        logger.warning("[sage_citations] lineage fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail="Couldn't trace that paper's citations just now.")
    except Exception as exc:
        logger.warning("[sage_citations] lineage fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail="Couldn't trace that paper's citations just now.")

    return PaperLineageResponse(
        paper=_summary_from_work(work),
        references=references,
        cited_by=cited_by,
    )


@router.post("/sage/paper-insight", response_model=PaperInsightResponse)
async def paper_insight(
    payload: PaperInsightRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PaperInsightResponse:
    """
    Sage explaining what a traced paper actually is and why its position in
    the citation lineage matters -- grounded in OpenAlex's real abstract
    (reconstructed from its word-position index) and primary_topic, not a
    guess from the title alone. Explicitly told to use ONLY the given
    abstract/metadata, same anti-fabrication contract as every other Sage
    endpoint; falls back to an honest, factual, non-LLM line if the
    abstract is missing or the model call fails.

    **Authentication**: Requires valid VAULT_OWNER token, same as the
    other citation endpoints above.
    """
    work_id = payload.work_id.strip()
    if not work_id:
        raise HTTPException(status_code=400, detail="A paper id is required")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers={"User-Agent": _USER_AGENT}) as client:
            res = await client.get(
                f"{_OPENALEX_BASE}/works/{work_id}",
                params={"select": _INSIGHT_SELECT_FIELDS},
            )
            res.raise_for_status()
            work = res.json() or {}
    except Exception as exc:
        logger.warning("[sage_citations] paper-insight fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail="Couldn't load that paper's details just now.")

    title = str(work.get("title") or work.get("display_name") or "Untitled").strip()
    year = work.get("publication_year")
    topic = _topic_from_work(work)
    cited_by_count = int(work.get("cited_by_count") or 0)
    reference_count = len(work.get("referenced_works") or [])
    abstract = _reconstruct_abstract(work.get("abstract_inverted_index"))
    has_abstract = bool(abstract)

    fallback = (
        f"{title}{f' ({year})' if year else ''} sits in the "
        f"{topic.lower() if topic else 'related'} literature, cited by {cited_by_count} "
        f"other work{'s' if cited_by_count != 1 else ''} so far."
    )

    try:
        from google import genai
        from google.genai import types as genai_types
    except Exception:
        return PaperInsightResponse(insight=fallback, topic=topic, has_abstract=has_abstract)

    api_key = (os.getenv("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        return PaperInsightResponse(insight=fallback, topic=topic, has_abstract=has_abstract)

    digest = json.dumps(
        {
            "title": title,
            "year": year,
            "authors": _authors_from_work(work)[:5],
            "topic": topic,
            "cited_by_count": cited_by_count,
            "reference_count": reference_count,
            "abstract": abstract or "(no abstract available -- rely only on title/topic/counts)",
        },
        default=str,
    )[:4000]

    prompt = (
        "You are Sage, a personal researcher explaining one academic paper to someone tracing "
        "its citation lineage. Below is real metadata for the paper, including its actual "
        "abstract when available. Write 2-3 short sentences: (1) what the paper's real "
        "contribution is, using ONLY what the abstract actually states -- never invent findings, "
        "methods, or results it doesn't mention; if no abstract is given, say only what the "
        "title/topic honestly support instead of guessing at content. (2) one sentence on how "
        "significant its position in the citation network is, using the real cited_by_count and "
        "reference_count given (e.g. widely-cited hub vs. a more niche or recent work). Write "
        "like a person explaining why this paper matters, not a database dump. Return ONLY the "
        "sentences, no quotes, no preamble, no markdown.\n\n"
        f"Paper: {digest}"
    )

    try:
        client = genai.Client(api_key=api_key)
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(temperature=0.3),
            ),
            timeout=_INSIGHT_TIMEOUT_SECONDS,
        )
        text = (getattr(response, "text", "") or "").strip().strip('"')
        return PaperInsightResponse(
            insight=text[:500] if text else fallback, topic=topic, has_abstract=has_abstract
        )
    except Exception as exc:
        logger.warning("[sage_citations] paper insight generation failed: %s", exc)
        return PaperInsightResponse(insight=fallback, topic=topic, has_abstract=has_abstract)
