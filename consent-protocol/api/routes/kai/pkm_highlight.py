# consent-protocol/api/routes/kai/pkm_highlight.py
"""
Sage: a persistent research agent built on top of the PKM store.

Every endpoint here reasons over data the caller has already decrypted
client-side (this backend never touches the vault directly) and returns
either a genuine LLM-produced result or an honest, non-LLM fallback line --
never a raw error surfaced as if it were a real answer, and never a
fabricated fact not present in the caller-supplied payload.
"""

import asyncio
import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token

logger = logging.getLogger(__name__)

router = APIRouter()

_MODEL = "gemini-3.1-flash-lite"
_TIMEOUT_SECONDS = 8.0
_SAGE_BRIEFING_TIMEOUT_SECONDS = 20.0
_RESEARCH_TIMEOUT_SECONDS = 25.0
_MAX_PAYLOAD_CHARS = 4000
_MAX_QUERY_CHARS = 500
_ANSWER_CHARS = 4000
_DEEP_ANSWER_CHARS = 8000
# Research Threads' answer-length control (deep mode only -- quick Ask Sage
# stays a fixed short answer). Each tier pairs a char budget with how long a
# generation actually takes and how much room the model needs to reach it --
# a bigger cap alone does nothing if the timeout fires or max_output_tokens
# cuts generation off first.
_DEEP_LENGTH_ANSWER_CHARS = {"standard": _DEEP_ANSWER_CHARS, "thorough": 14000, "exhaustive": 20000}
_DEEP_LENGTH_TIMEOUT_SECONDS = {"standard": 35.0, "thorough": 55.0, "exhaustive": 75.0}
_DEEP_LENGTH_MAX_OUTPUT_TOKENS = {"thorough": 6144, "exhaustive": 9216}
_DEEP_LENGTH_INSTRUCTIONS = {
    "standard": (
        "Write a genuinely thorough answer: cover the actual mechanisms or reasoning involved, "
        "concrete evidence or examples, and (where relevant) real open questions or caveats -- "
        "structure it as a few clear markdown paragraphs, with a bulleted list only where it "
        "actually helps. Not one dense block, and not padded filler either."
    ),
    "thorough": (
        "Write a long, deeply detailed answer (aim for roughly 1200-1800 words) structured as a "
        "small set of clearly titled chapters -- start with a 1-2 sentence overview, then break the "
        "rest into 3-5 chapters using markdown `## Chapter Title` headings (a short, specific title "
        "per chapter, not 'Introduction'/'Conclusion'). Each chapter should cover a distinct real "
        "mechanism, comparison, or angle -- use a `### ` sub-heading only if a chapter genuinely "
        "needs a finer split. Never pad with filler or repetition just to hit length; every chapter "
        "must carry real additional substance."
    ),
    "exhaustive": (
        "Write an exhaustive, comprehensive answer (aim for roughly 2000-2800 words) -- treat this "
        "like a real reference write-up the user will keep coming back to, not a quick answer. "
        "Structure it as a sequence of clearly titled chapters: start with a 1-2 sentence overview, "
        "then break the rest into 5-8 chapters using markdown `## Chapter Title` headings (a short, "
        "specific title per chapter, e.g. the mechanism/comparison/angle it covers -- never generic "
        "titles like 'Introduction' or 'Conclusion'). Use a `### ` sub-heading only if a chapter "
        "genuinely needs a finer split. Cover the actual mechanisms or reasoning in full depth, "
        "historical or comparative context where relevant, multiple concrete examples or pieces of "
        "evidence, known edge cases or limitations, and real open research questions -- distributed "
        "across the chapters, not crammed into one. Never pad with filler, repetition, or restating "
        "the question just to hit length -- every chapter must carry real additional substance "
        "grounded in what you actually found."
    ),
}
# The largest an answer can ever be (exhaustive tier) -- conversation-history
# and thread-synthesis fields must accept up to this, not just the standard
# tier's 8000, or a long turn 422s every follow-up/synthesis after it.
_MAX_ANSWER_CHARS_ANY_TIER = _DEEP_LENGTH_ANSWER_CHARS["exhaustive"]
_THREAD_SYNTHESIS_TURN_ANSWER_CHARS = 3000
_THREAD_SYNTHESIS_MAX_PAYLOAD_CHARS = 12000


class PkmHighlightSummaryRequest(BaseModel):
    domain: str = Field(..., max_length=64)
    display_name: str = Field(..., max_length=128)
    raw_summary: dict = Field(default_factory=dict)
    highlights: list[str] = Field(default_factory=list)
    mode: Literal["brief", "rich"] = "brief"


class PkmHighlightSummaryResponse(BaseModel):
    text: str


class SageDomainInput(BaseModel):
    domain: str = Field(..., max_length=64)
    display_name: str = Field(..., max_length=128)
    summary: dict = Field(default_factory=dict)
    attribute_count: int = 0
    last_updated: str | None = None


class PkmSageBriefingRequest(BaseModel):
    domains: list[SageDomainInput] = Field(default_factory=list, max_length=12)


class SageSuggestedFix(BaseModel):
    note_text: str
    from_domain: str
    from_display_name: str
    target_domain: str
    target_display_name: str


class PkmSageBriefingResponse(BaseModel):
    text: str
    suggested_fix: SageSuggestedFix | None = None
    suggested_prompts: list[str] = Field(default_factory=list)


class SageResearchSource(BaseModel):
    title: str
    url: str


class SageConversationTurn(BaseModel):
    query: str = Field(..., max_length=_MAX_QUERY_CHARS)
    # Must match _MAX_ANSWER_CHARS_ANY_TIER -- Research Threads always ask
    # with depth="deep" and echo prior turns' raw answers back as
    # conversation history, so a cap below the largest length tier 422s any
    # follow-up once an earlier turn's answer runs long.
    answer: str = Field(..., max_length=_MAX_ANSWER_CHARS_ANY_TIER)


class PkmSageResearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=_MAX_QUERY_CHARS)
    domains: list[SageDomainInput] = Field(default_factory=list, max_length=12)
    mode: Literal["standard", "challenge"] = "standard"
    conversation_history: list[SageConversationTurn] = Field(default_factory=list, max_length=6)
    # "deep" is for persistent Research Threads, where a short chat-style answer
    # reads as thin -- "quick" (the default) keeps Ask Sage's one-shot answers
    # fast and conversational, unchanged from before this field existed.
    depth: Literal["quick", "deep"] = "quick"
    # Only meaningful when depth="deep" -- the answer-length tier the user
    # picked for a Research Thread. Ignored in "quick" mode, which always
    # stays a short conversational answer.
    length: Literal["standard", "thorough", "exhaustive"] = "standard"


class SageKeyTerm(BaseModel):
    term: str
    definition: str


class SageComparison(BaseModel):
    label: str
    value: float
    unit: str = ""


class PkmSageResearchResponse(BaseModel):
    answer: str
    sources: list[SageResearchSource] = Field(default_factory=list)
    # Both grounded in the SAME answer text the model already wrote (parsed out
    # of a trailing JSON block it's asked to append, deep mode only) -- never a
    # separate generation pass, so nothing here can introduce facts the prose
    # answer doesn't already state.
    key_terms: list[SageKeyTerm] = Field(default_factory=list)
    comparisons: list[SageComparison] = Field(default_factory=list)
    # A well-formed academic-literature search query for this question, or
    # None when the model judged there's no real paper trail to trace --
    # used instead of the raw user question for paper auto-trace, since a
    # natural-language question containing a product/tool name matches
    # unrelated papers on OpenAlex's full-text search far more often than a
    # clean topical query does.
    paper_search_query: str | None = None


class SageRecapDomainInput(BaseModel):
    domain: str = Field(..., max_length=64)
    display_name: str = Field(..., max_length=128)
    previous_summary: dict = Field(default_factory=dict)
    current_summary: dict = Field(default_factory=dict)


class PkmSageRecapRequest(BaseModel):
    domains: list[SageRecapDomainInput] = Field(default_factory=list, max_length=12)


class PkmSageRecapResponse(BaseModel):
    text: str
    has_changes: bool


class PkmSageReviewRequest(BaseModel):
    domain: str = Field(..., max_length=64)
    display_name: str = Field(..., max_length=128)
    fragments: list[str] = Field(default_factory=list, max_length=200)


class PkmSageReviewResponse(BaseModel):
    document: str


class SageThreadTurnInput(BaseModel):
    query: str = Field(..., max_length=_MAX_QUERY_CHARS)
    answer: str = Field(..., max_length=_MAX_ANSWER_CHARS_ANY_TIER)


class SageThreadPaperInput(BaseModel):
    title: str = Field(..., max_length=300)
    year: int | None = None
    topic: str | None = Field(default=None, max_length=200)
    cited_by_count: int = 0


class PkmSageThreadSynthesisRequest(BaseModel):
    title: str = Field(..., max_length=200)
    turns: list[SageThreadTurnInput] = Field(default_factory=list, max_length=20)
    traced_papers: list[SageThreadPaperInput] = Field(default_factory=list, max_length=30)


class PkmSageThreadSynthesisResponse(BaseModel):
    summary: str
    established: list[str] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)


def _get_genai_client(model: str = _MODEL):
    """Builds a genai client via this app's managed provider binding (Vertex
    ADC + GOOGLE_CLOUD_PROJECT in hosted/UAT environments, or a developer API
    key locally) -- the same resolution `hushh_mcp/operons/kai/llm.py` uses.
    Reading GOOGLE_API_KEY directly bypasses Vertex ADC entirely, which is
    the auth mode this app actually runs under outside local dev."""
    try:
        from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding

        return ManagedGeminiRuntimeBinding.from_environment().build_direct_client(model=model)
    except Exception as exc:
        logger.warning("[pkm_highlight] genai client unavailable: %s", exc)
        return None


def _fallback_text(payload: PkmHighlightSummaryRequest) -> str:
    return f"Hushh has been keeping notes on your {payload.display_name.lower()}."


def _recap_fallback_text(payload: PkmSageRecapRequest) -> str:
    if not payload.domains:
        return "Nothing new since your last visit."
    names = [d.display_name for d in payload.domains[:3]]
    joined = ", ".join(names) if len(names) < 2 else f"{', '.join(names[:-1])} and {names[-1]}"
    return f"Your {joined} notes have updated since your last visit."


def _thread_fallback_summary(payload: PkmSageThreadSynthesisRequest) -> str:
    turn_count = len(payload.turns)
    paper_count = len(payload.traced_papers)
    parts = []
    if turn_count:
        parts.append(f"{turn_count} question{'s' if turn_count != 1 else ''} asked")
    if paper_count:
        parts.append(f"{paper_count} paper{'s' if paper_count != 1 else ''} traced")
    detail = " and ".join(parts) if parts else "nothing recorded yet"
    return f"This thread on \"{payload.title}\" has {detail} so far."


def _sage_fallback_text(payload: PkmSageBriefingRequest) -> str:
    count = len(payload.domains)
    if count == 0:
        return "Sage doesn't have enough saved detail yet to make a cross-domain observation."
    names = [d.display_name.lower() for d in payload.domains[:3]]
    joined = ", ".join(names) if len(names) < 2 else f"{', '.join(names[:-1])}, and {names[-1]}"
    return f"Sage is tracking {joined} so far -- a cross-domain read will sharpen as more detail builds up."


@router.post("/pkm/highlight-summary", response_model=PkmHighlightSummaryResponse)
async def summarize_pkm_highlight(
    payload: PkmHighlightSummaryRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PkmHighlightSummaryResponse:
    """
    Turns one PKM domain's raw captured data into a single clean sentence
    for the dashboard card. Best-effort: falls back to a plain, honest
    line (never raw field dumps) if the LLM call fails or isn't configured.

    **Authentication**: Requires valid VAULT_OWNER token -- this reads the
    caller-supplied PKM content, not the vault, but keeps the same gate
    as every other PKM-adjacent endpoint since the content is personal.
    """
    try:
        from google.genai import types as genai_types
    except Exception:
        return PkmHighlightSummaryResponse(text=_fallback_text(payload))

    client = _get_genai_client()
    if client is None:
        return PkmHighlightSummaryResponse(text=_fallback_text(payload))

    digest = {
        "domain": payload.domain,
        "summary": payload.raw_summary,
        "highlights": payload.highlights[:10],
    }
    digest_json = json.dumps(digest, default=str)[:_MAX_PAYLOAD_CHARS]

    # Stay entirely in a "you/your" voice describing the user -- without this,
    # the model sometimes drifts into first person about itself ("I have
    # saved this...", "I'll keep this in mind...", "I look forward to..."),
    # which reads as a confirmation toast bleeding into what should be an
    # observational summary.
    voice_rule = (
        "Write entirely about the user in a 'you/your' voice describing what the data shows "
        "-- never write in first person about yourself as the assistant (no 'I have saved...', "
        "'I'll remember...', 'I look forward to...', or similar). "
    )

    if payload.mode == "rich":
        prompt = (
            "You write 2-3 warm, specific sentences describing what a personal knowledge "
            "assistant remembers about its user, based on the JSON payload below. "
            "Rules: use ONLY facts present in the payload -- never invent numbers, names, "
            "or events not shown. Ignore internal field names like 'Kind', 'Status', "
            "'Summary', or entries that look like raw test input rather than real facts. "
            "Weave the real facts together into a small narrative (what happened, and what "
            "it might mean going forward) rather than a flat list -- but every claim must "
            "still trace back to something actually in the payload. " + voice_rule +
            "Write like a person telling a friend what they noticed, not like a database "
            "describing its own schema. Return ONLY the sentences, no quotes, no JSON, no "
            "preamble.\n\n"
            f"Payload: {digest_json}"
        )
    else:
        prompt = (
            "You write one short, warm, specific sentence describing what a personal "
            "knowledge assistant remembers about its user, based on the JSON payload below. "
            "Rules: use ONLY facts present in the payload -- never invent numbers, names, or "
            "events. Ignore internal field names like 'Kind', 'Status', 'Summary', or entries "
            "that look like raw test input rather than real facts. " + voice_rule +
            "Write like a person telling a friend what they noticed, not like a database "
            "describing its own schema. Return ONLY the sentence, no quotes, no JSON, no "
            "preamble.\n\n"
            f"Payload: {digest_json}"
        )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(temperature=0.3),
            ),
            timeout=_TIMEOUT_SECONDS,
        )
        text = (getattr(response, "text", "") or "").strip().strip('"')
        if not text:
            return PkmHighlightSummaryResponse(text=_fallback_text(payload))
        max_chars = 600 if payload.mode == "rich" else 280
        return PkmHighlightSummaryResponse(text=text[:max_chars])
    except Exception as exc:
        logger.warning("[pkm_highlight] summary generation failed: %s", exc)
        return PkmHighlightSummaryResponse(text=_fallback_text(payload))


@router.post("/pkm/sage-briefing", response_model=PkmSageBriefingResponse)
async def summarize_sage_briefing(
    payload: PkmSageBriefingRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PkmSageBriefingResponse:
    """
    Sage's cross-domain briefing: one Gemini call reasoning across every PKM
    domain's already-computed summary at once (not per-domain in isolation),
    looking for one real, specific, non-obvious connection or observation.

    **Authentication**: Requires valid VAULT_OWNER token, same as the
    per-domain highlight endpoint above.
    """
    if not payload.domains:
        return PkmSageBriefingResponse(text=_sage_fallback_text(payload))

    try:
        from google.genai import types as genai_types
    except Exception:
        return PkmSageBriefingResponse(text=_sage_fallback_text(payload))

    client = _get_genai_client()
    if client is None:
        return PkmSageBriefingResponse(text=_sage_fallback_text(payload))

    known_domains = {d.domain for d in payload.domains}
    display_name_by_domain = {d.domain: d.display_name for d in payload.domains}

    digest = [
        {
            "domain": d.domain,
            "display_name": d.display_name,
            "summary": d.summary,
            "attribute_count": d.attribute_count,
            "last_updated": d.last_updated,
        }
        for d in payload.domains
    ]
    digest_json = json.dumps(digest, default=str)[:_MAX_PAYLOAD_CHARS]

    prompt = (
        "You are Sage, a personal second-brain assistant. Below is a JSON list of every "
        "life domain your user has data in, each with its own small summary. "
        "Rules: use ONLY facts present in the payload -- never invent numbers, names, dates, "
        "or events not shown. Ignore internal field names like 'Kind', 'Status', or raw "
        "test-looking entries. Never give financial, medical, or legal advice -- observe, "
        "don't prescribe. Two real facts sitting in different domains are NOT automatically "
        "related -- never claim one informs, aligns with, reflects, or explains another unless "
        "the payload itself states that link (e.g. a note that explicitly ties them together). "
        "A shared timeframe, life stage, or topic keyword is not evidence of a real connection.\n\n"
        "Return ONLY a single JSON object (no markdown fences, no preamble) shaped exactly like:\n"
        '{"text": "2-3 short sentences making ONE real, specific observation. Prefer a genuine '
        "cross-domain connection ONLY if the payload actually evidences one; otherwise state one "
        "honest, specific fact (from the richest domain, or naming two domains separately without "
        'implying they relate) -- never a per-domain recap, and never a fabricated link.", '
        '"misfiled": {"found": true or false, "note_text": "the exact saved note/fact text '
        "that looks like it belongs in a different domain than the one it's currently filed "
        'under, copied verbatim from the payload", "from_domain": "the domain key it is '
        'currently under (must be one of the domain keys in the payload)", "target_domain": '
        '"the domain key it actually belongs under (must ALSO be one of the domain keys in '
        'the payload, and different from from_domain)"}, '
        '"suggested_prompts": ["a short first-person question (under 90 characters) the user '
        "might genuinely want to ask a personal researcher, grounded in a specific real fact "
        'from the payload", "..." , "..."]}\n'
        "Only set misfiled.found to true if you can point at a specific real note text that "
        "clearly belongs to a different domain already present in the payload -- never guess "
        "or force one. For suggested_prompts, write exactly 3 short questions, each referencing "
        "a different real fact from a different domain where possible (e.g. a specific dollar "
        "amount, holding, job title, or preference) -- never generic questions that could apply "
        "to anyone, and never invent facts not present.\n\n"
        f"Domains: {digest_json}"
    )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    temperature=0.4, response_mime_type="application/json"
                ),
            ),
            timeout=_SAGE_BRIEFING_TIMEOUT_SECONDS,
        )
        raw_text = (getattr(response, "text", "") or "").strip()
        if not raw_text:
            return PkmSageBriefingResponse(text=_sage_fallback_text(payload))

        parsed = json.loads(raw_text)
        text = str(parsed.get("text") or "").strip()
        if not text:
            return PkmSageBriefingResponse(text=_sage_fallback_text(payload))

        suggested_fix = None
        misfiled = parsed.get("misfiled") or {}
        if isinstance(misfiled, dict) and misfiled.get("found"):
            note_text = str(misfiled.get("note_text") or "").strip()
            from_domain = str(misfiled.get("from_domain") or "").strip()
            target_domain = str(misfiled.get("target_domain") or "").strip()
            if (
                note_text
                and from_domain in known_domains
                and target_domain in known_domains
                and from_domain != target_domain
            ):
                suggested_fix = SageSuggestedFix(
                    note_text=note_text[:400],
                    from_domain=from_domain,
                    from_display_name=display_name_by_domain[from_domain],
                    target_domain=target_domain,
                    target_display_name=display_name_by_domain[target_domain],
                )

        raw_prompts = parsed.get("suggested_prompts") or []
        suggested_prompts = [
            str(p).strip()[:200] for p in raw_prompts if isinstance(p, str) and str(p).strip()
        ][:3]

        return PkmSageBriefingResponse(
            text=text[:600], suggested_fix=suggested_fix, suggested_prompts=suggested_prompts
        )
    except Exception as exc:
        logger.warning("[pkm_highlight] sage briefing generation failed: %s", exc)
        return PkmSageBriefingResponse(text=_sage_fallback_text(payload))


@router.post("/pkm/sage-recap", response_model=PkmSageRecapResponse)
async def sage_recap(
    payload: PkmSageRecapRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PkmSageRecapResponse:
    """
    "What's new since last time": the caller has already diffed each
    domain's readable summary against a snapshot from the user's last
    visit (stored client-side) and only sends the domains that actually
    changed, each with its previous_summary and current_summary.

    **Authentication**: Requires valid VAULT_OWNER token, same as the
    other Sage endpoints above.
    """
    if not payload.domains:
        return PkmSageRecapResponse(text="Nothing new since your last visit.", has_changes=False)

    try:
        from google.genai import types as genai_types
    except Exception:
        return PkmSageRecapResponse(text=_recap_fallback_text(payload), has_changes=True)

    client = _get_genai_client()
    if client is None:
        return PkmSageRecapResponse(text=_recap_fallback_text(payload), has_changes=True)

    digest = [
        {
            "domain": d.domain,
            "display_name": d.display_name,
            "previous_summary": d.previous_summary,
            "current_summary": d.current_summary,
        }
        for d in payload.domains
    ]
    digest_json = json.dumps(digest, default=str)[:_MAX_PAYLOAD_CHARS]

    prompt = (
        "You are Sage, a personal second-brain assistant. Below is a JSON list of life domains "
        "that changed since the user's last visit, each with its previous_summary and "
        "current_summary. Write 2-3 short sentences narrating what's genuinely new or changed, "
        "using ONLY facts present in current_summary that actually differ from previous_summary. "
        "Ignore internal field names like 'Kind', 'Status', or raw test-looking entries. "
        "If a domain's current_summary doesn't meaningfully differ in substance from its "
        "previous_summary, don't mention that domain at all. Never invent numbers, names, or "
        "events not shown. Write like a person catching a friend up on what changed, not a diff "
        "tool listing fields. Return ONLY the sentences, no quotes, no JSON, no preamble.\n\n"
        f"Domains: {digest_json}"
    )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(temperature=0.3),
            ),
            timeout=_TIMEOUT_SECONDS,
        )
        text = (getattr(response, "text", "") or "").strip().strip('"')
        if not text:
            return PkmSageRecapResponse(text=_recap_fallback_text(payload), has_changes=True)
        return PkmSageRecapResponse(text=text[:600], has_changes=True)
    except Exception as exc:
        logger.warning("[pkm_highlight] sage recap generation failed: %s", exc)
        return PkmSageRecapResponse(text=_recap_fallback_text(payload), has_changes=True)


_SAGE_DATA_MARKER = "###SAGE_DATA###"


def _parse_deep_extras(raw_text: str) -> tuple[str, list[SageKeyTerm], list[SageComparison], str | None]:
    """Splits the model's trailing ###SAGE_DATA### JSON block (if present)
    off the prose answer. Anything that fails to parse cleanly just means an
    empty extras set -- this is a bonus on top of the real answer, never
    something worth surfacing an error for."""
    if _SAGE_DATA_MARKER not in raw_text:
        return raw_text.strip(), [], [], None
    prose, _, trailer = raw_text.partition(_SAGE_DATA_MARKER)
    prose = prose.strip()
    trailer = trailer.strip().strip("`")
    if trailer.lower().startswith("json"):
        trailer = trailer[4:].strip()
    try:
        parsed = json.loads(trailer)
    except Exception:
        return prose, [], [], None
    if not isinstance(parsed, dict):
        return prose, [], [], None

    key_terms: list[SageKeyTerm] = []
    for item in (parsed.get("key_terms") or [])[:4]:
        if not isinstance(item, dict):
            continue
        term = str(item.get("term") or "").strip()[:80]
        definition = str(item.get("definition") or "").strip()[:300]
        if term and definition:
            key_terms.append(SageKeyTerm(term=term, definition=definition))

    comparisons: list[SageComparison] = []
    for item in (parsed.get("comparisons") or [])[:5]:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()[:60]
        value = item.get("value")
        if not label or not isinstance(value, (int, float)):
            continue
        comparisons.append(SageComparison(label=label, value=float(value), unit=str(item.get("unit") or "")[:20]))

    paper_search_query = parsed.get("paper_search_query")
    paper_search_query = str(paper_search_query).strip()[:200] if isinstance(paper_search_query, str) else None
    paper_search_query = paper_search_query or None

    return prose, key_terms, comparisons, paper_search_query


@router.post("/pkm/sage-research", response_model=PkmSageResearchResponse)
async def sage_research(
    payload: PkmSageResearchRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PkmSageResearchResponse:
    """
    Sage as an actual researcher: answers a real question using Gemini's
    Google Search grounding (a genuine live web search, not a hallucinated
    answer) and personalizes the framing using the user's own PKM domain
    summaries. Every source returned is a real grounding citation from the
    search the model actually ran.

    **Authentication**: Requires valid VAULT_OWNER token, same as the other
    Sage endpoints above -- the personalization context is personal data.
    """
    query = payload.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")

    try:
        from google.genai import types as genai_types
    except Exception:
        raise HTTPException(status_code=503, detail="Research isn't available right now.")

    client = _get_genai_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Research isn't available right now.")

    context_digest = json.dumps(
        [
            {"display_name": d.display_name, "summary": d.summary}
            for d in payload.domains
        ],
        default=str,
    )[:_MAX_PAYLOAD_CHARS]

    history_block = ""
    if payload.conversation_history:
        turns = payload.conversation_history[-4:]
        history_lines = [
            f"User asked: {turn.query}\nYou answered: {turn.answer[:600]}" for turn in turns
        ]
        history_block = (
            "\n\nRecent conversation so far (most recent last -- use this ONLY to understand "
            "follow-up questions like 'what about X' or 'and for Y'; if the new question stands "
            "on its own, ignore this and just answer it):\n" + "\n\n".join(history_lines) + "\n"
        )

    if payload.mode == "challenge":
        prompt = (
            "You are Sage, acting as a rigorous adversarial researcher (a 'red team' pass). "
            "You have live web search available -- use it. Do this in two clearly separated "
            "stages, using real, current, verifiable information for both:\n\n"
            "Stage 1 -- Thesis: give the best direct answer, recommendation, or baseline "
            "position on the user's question, in a few short paragraphs.\n\n"
            "Stage 2 -- Red-Team Critique: actively argue AGAINST the thesis you just gave. "
            "Search for and surface real conflicting evidence, known failure modes, edge "
            "cases, unstated assumptions, or credible alternative positions. Do not soften "
            "this into a generic disclaimer -- find the strongest real counter-case you can. "
            "If you genuinely cannot find a credible counter-case after searching, say so "
            "plainly instead of inventing a weak one.\n\n"
            "Format the response as markdown with exactly two headings: '## Thesis' and "
            "'## Red-Team Critique'. Then briefly personalize the framing using ONLY the "
            "real facts in the JSON context below if genuinely relevant (never force a "
            "connection, never invent facts not present). Never give financial, medical, or "
            "legal advice as a recommendation -- inform, don't prescribe. Do not fabricate "
            "sources or facts."
            f"{history_block}\n\n"
            f"User's question: {query}\n\n"
            f"Personal context (JSON, may be empty): {context_digest}"
        )
    elif payload.depth == "deep":
        length_instruction = _DEEP_LENGTH_INSTRUCTIONS.get(
            payload.length, _DEEP_LENGTH_INSTRUCTIONS["standard"]
        )
        prompt = (
            "You are Sage, a personal researcher building a persistent research thread with the "
            "user -- this isn't a quick chat answer, it's a real investigation they will keep "
            "coming back to and building on, so a thin, generic answer fails them. Answer the "
            "user's question below thoroughly, using real, current information -- you have live "
            "web search available, use it. If the question is a follow-up that only makes sense "
            "given the earlier conversation, use the conversation history below to understand what "
            "it's actually asking, then answer the follow-up itself -- don't just repeat or "
            "re-summarize the earlier answer.\n\n"
            f"{length_instruction} When you cite "
            "something specific from your search, name it inline (e.g. 'the original Transformer "
            "paper found...') instead of leaving an uncited claim. Then briefly personalize the "
            "framing using ONLY the real facts in the JSON context below if genuinely relevant "
            "(never force a connection, never invent facts not present). Never give financial, "
            "medical, or legal advice as a recommendation -- inform, don't prescribe. Do not "
            "fabricate sources or facts.\n\n"
            "After your full answer, on its own new line, output exactly `###SAGE_DATA###` and "
            "then, right after it, a single JSON object (no markdown fence, no commentary after "
            "it) with three fields:\n"
            '- "key_terms": up to 4 objects {"term": string, "definition": string} -- ONLY for '
            "genuinely technical or non-obvious terms you actually used above, each definition "
            "stating ONLY what your answer already established (never new information). Use an "
            "empty list if every term you used is already plain language.\n"
            '- "comparisons": up to 5 objects {"label": string, "value": number, "unit": string} '
            "-- ONLY if your answer already states real, comparable numeric facts worth a quick "
            "visual (e.g. accuracy percentages, benchmark scores, parameter counts, latency). Every "
            "item must share the SAME unit -- if your answer has more than one kind of number (e.g. "
            "both a score and a distance/error metric), pick only the single most illustrative "
            "same-unit set, don't mix different units in one list. Use an empty list if nothing in "
            "your answer is genuinely comparable numbers -- never invent or force a number that "
            "isn't really there.\n"
            '- "paper_search_query": a short, well-formed academic-literature search string (e.g. '
            "\"attention mechanism transformer sequence modeling\") ONLY if this question genuinely "
            "has real academic papers behind it worth tracing. Use `null` if this is about "
            "proprietary tooling, a specific product, or anything else with no real paper trail --"
            " never invent a search query just to have one, and never use the user's raw question "
            "verbatim (it may name things -- like a specific internal tool -- that won't match real "
            "papers)."
            f"{history_block}\n\n"
            f"User's question: {query}\n\n"
            f"Personal context (JSON, may be empty): {context_digest}"
        )
    else:
        prompt = (
            "You are Sage, a personal researcher. Answer the user's question below using real, "
            "current information -- you have live web search available, use it. If the question "
            "is a follow-up that only makes sense given the earlier conversation, use the "
            "conversation history below to understand what it's actually asking, then answer "
            "the follow-up itself -- don't just repeat or re-summarize the earlier answer. "
            "Then briefly personalize the framing using ONLY the real facts in the JSON context "
            "if genuinely relevant (never force a connection, never invent facts not present). "
            "Never give financial, medical, or legal advice as a recommendation -- inform, don't "
            "prescribe. Keep it focused and readable: a few short paragraphs, not an essay. "
            "Do not fabricate sources or facts."
            f"{history_block}\n\n"
            f"User's question: {query}\n\n"
            f"Personal context (JSON, may be empty): {context_digest}"
        )

    generation_kwargs: dict = {
        "temperature": 0.3,
        "tools": [genai_types.Tool(google_search=genai_types.GoogleSearch())],
    }
    if payload.depth == "deep":
        timeout_seconds = _DEEP_LENGTH_TIMEOUT_SECONDS.get(payload.length, _DEEP_LENGTH_TIMEOUT_SECONDS["standard"])
        max_output_tokens = _DEEP_LENGTH_MAX_OUTPUT_TOKENS.get(payload.length)
        if max_output_tokens:
            generation_kwargs["max_output_tokens"] = max_output_tokens
    else:
        timeout_seconds = _RESEARCH_TIMEOUT_SECONDS

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(**generation_kwargs),
            ),
            timeout=timeout_seconds,
        )
        answer = (getattr(response, "text", "") or "").strip()
        if not answer:
            raise HTTPException(status_code=502, detail="Sage couldn't find an answer just now.")

        key_terms: list[SageKeyTerm] = []
        comparisons: list[SageComparison] = []
        paper_search_query: str | None = None
        if payload.depth == "deep":
            answer, key_terms, comparisons, paper_search_query = _parse_deep_extras(answer)

        sources: list[SageResearchSource] = []
        seen_urls: set[str] = set()
        candidates = getattr(response, "candidates", None) or []
        grounding_metadata = getattr(candidates[0], "grounding_metadata", None) if candidates else None
        chunks = getattr(grounding_metadata, "grounding_chunks", None) or []
        for chunk in chunks:
            web = getattr(chunk, "web", None)
            if not web:
                continue
            url = str(getattr(web, "uri", "") or "").strip()
            title = str(getattr(web, "title", "") or "").strip() or url
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            sources.append(SageResearchSource(title=title[:200], url=url))
            if len(sources) >= 8:
                break

        answer_cap = (
            _DEEP_LENGTH_ANSWER_CHARS.get(payload.length, _DEEP_ANSWER_CHARS)
            if payload.depth == "deep"
            else _ANSWER_CHARS
        )
        return PkmSageResearchResponse(
            answer=answer[:answer_cap],
            sources=sources,
            key_terms=key_terms,
            comparisons=comparisons,
            paper_search_query=paper_search_query,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[pkm_highlight] sage research failed: %s", exc)
        raise HTTPException(status_code=502, detail="Sage couldn't research that just now.")


@router.post("/pkm/sage-review", response_model=PkmSageReviewResponse)
async def sage_review(
    payload: PkmSageReviewRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PkmSageReviewResponse:
    """
    Sage drafting a structured self-assessment / performance-review document
    from real, already-saved fragments in one PKM domain (typically
    "professional") -- the caller has already decrypted the domain client-
    side and flattened it into plain-text fragments; this endpoint never
    sees encrypted data, only the fragments it's given.

    **Authentication**: Requires valid VAULT_OWNER token, same as the other
    Sage endpoints above.
    """
    display_name = payload.display_name.strip() or payload.domain
    fragments = [f.strip() for f in payload.fragments if f.strip()][:200]
    if not fragments:
        return PkmSageReviewResponse(
            document=f"Not enough saved {display_name.lower()} history yet to draft a self-assessment."
        )

    try:
        from google.genai import types as genai_types
    except Exception:
        return PkmSageReviewResponse(document="Review drafting isn't available right now.")

    client = _get_genai_client()
    if client is None:
        return PkmSageReviewResponse(document="Review drafting isn't available right now.")

    fragments_text = "\n".join(f"- {f}" for f in fragments)[:_MAX_PAYLOAD_CHARS]

    prompt = (
        "You are Sage, drafting a professional self-assessment / performance-review document for "
        f"the user, based ONLY on real notes they've saved about their {display_name} life domain "
        "over time (each line below is one real saved fragment, in no particular order). "
        "Rules: use ONLY facts present in the fragments -- never invent accomplishments, numbers, "
        "dates, or outcomes not stated. Ignore fragments that look like raw test data, internal "
        "field names, or aren't real personal facts. Structure the document with clear markdown "
        "section headings such as Key Updates & Milestones, and Highlights -- only include a Growth "
        "Areas section if the fragments genuinely support one, never invent generic filler for it. "
        "If the fragments are sparse, write a short, honest document rather than padding it with "
        "generic language -- never fabricate volume or achievements. Return the document as "
        "markdown, no preamble, no meta-commentary about the fragments themselves.\n\n"
        f"Saved fragments:\n{fragments_text}"
    )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(temperature=0.3),
            ),
            timeout=_RESEARCH_TIMEOUT_SECONDS,
        )
        text = (getattr(response, "text", "") or "").strip()
        if not text:
            return PkmSageReviewResponse(
                document=f"Sage couldn't draft a {display_name.lower()} self-assessment just now."
            )
        return PkmSageReviewResponse(document=text[:6000])
    except Exception as exc:
        logger.warning("[pkm_highlight] sage review generation failed: %s", exc)
        return PkmSageReviewResponse(
            document=f"Sage couldn't draft a {display_name.lower()} self-assessment just now."
        )


@router.post("/pkm/sage-thread-synthesis", response_model=PkmSageThreadSynthesisResponse)
async def sage_thread_synthesis(
    payload: PkmSageThreadSynthesisRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> PkmSageThreadSynthesisResponse:
    """
    Sage keeping a running synthesis of one persistent Research Thread: a
    short summary plus what's been established vs. what's still an open
    question, reasoning over ONLY the real Q&A turns and traced papers the
    caller has already accumulated for this thread (never re-fetched here --
    this endpoint has no access to the encrypted vault, same boundary as
    every other Sage endpoint). Refreshed on thread creation, every new
    turn, and whenever the thread's detail view is opened.

    **Authentication**: Requires valid VAULT_OWNER token, same as the other
    Sage endpoints above.
    """
    if not payload.turns and not payload.traced_papers:
        return PkmSageThreadSynthesisResponse(
            summary=f"Ask something to get \"{payload.title}\" started.",
            established=[],
            open_questions=[],
        )

    try:
        from google.genai import types as genai_types
    except Exception:
        return PkmSageThreadSynthesisResponse(summary=_thread_fallback_summary(payload))

    client = _get_genai_client()
    if client is None:
        return PkmSageThreadSynthesisResponse(summary=_thread_fallback_summary(payload))

    digest = json.dumps(
        {
            "title": payload.title,
            "turns": [
                {"query": t.query, "answer": t.answer[:_THREAD_SYNTHESIS_TURN_ANSWER_CHARS]}
                for t in payload.turns[-20:]
            ],
            "traced_papers": [
                {"title": p.title, "year": p.year, "topic": p.topic, "cited_by_count": p.cited_by_count}
                for p in payload.traced_papers[:30]
            ],
        },
        default=str,
    )[:_THREAD_SYNTHESIS_MAX_PAYLOAD_CHARS]

    prompt = (
        "You are Sage, keeping a running synthesis of a user's ongoing research thread. Below is "
        "the thread's title, every question asked so far with its answer, and every paper they've "
        "traced. Rules: use ONLY facts present in the turns/papers below -- never invent findings, "
        "numbers, or sources not shown. Never give financial, medical, or legal advice -- observe, "
        "don't prescribe.\n\n"
        "Return ONLY a single JSON object (no markdown fences, no preamble) shaped exactly like:\n"
        '{"summary": "1-2 short sentences on what this research thread is actually about and how '
        'far it has gotten", "established": ["a short, specific thing genuinely settled by the '
        'turns/papers so far", "..."], "open_questions": ["a short, specific thing still '
        'unresolved or worth investigating next, grounded in what\'s already been asked/traced", '
        '"..."]}\n'
        "Return at most 5 established items and 4 open questions -- fewer is fine if the thread is "
        "thin, never pad with generic filler. If there truly isn't enough here yet, say so plainly "
        "in summary and return empty lists rather than inventing content.\n\n"
        f"Thread: {digest}"
    )

    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_MODEL,
                contents=prompt,
                config=genai_types.GenerateContentConfig(
                    temperature=0.3, response_mime_type="application/json"
                ),
            ),
            timeout=_TIMEOUT_SECONDS,
        )
        raw_text = (getattr(response, "text", "") or "").strip()
        if not raw_text:
            return PkmSageThreadSynthesisResponse(summary=_thread_fallback_summary(payload))

        parsed = json.loads(raw_text)
        summary = str(parsed.get("summary") or "").strip()
        if not summary:
            return PkmSageThreadSynthesisResponse(summary=_thread_fallback_summary(payload))

        established = [
            str(item).strip()[:300]
            for item in (parsed.get("established") or [])
            if isinstance(item, str) and str(item).strip()
        ][:5]
        open_questions = [
            str(item).strip()[:300]
            for item in (parsed.get("open_questions") or [])
            if isinstance(item, str) and str(item).strip()
        ][:4]

        return PkmSageThreadSynthesisResponse(
            summary=summary[:600], established=established, open_questions=open_questions
        )
    except Exception as exc:
        logger.warning("[pkm_highlight] sage thread synthesis failed: %s", exc)
        return PkmSageThreadSynthesisResponse(summary=_thread_fallback_summary(payload))
