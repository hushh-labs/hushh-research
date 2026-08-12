"""Read a claimed adviser's Form ADV Part 2A brochure into profile fields.

Services, fees, and the engagement minimum are NOT in the SEC identity API.
They exist only as narrative prose inside the adviser's Form ADV Part 2
brochure PDFs, whose URLs the claim snapshot already carries in
``firm_record.brochures``. This module fetches that filing, reads a bounded
slice of it, and asks the repo's existing Gemini runtime to return the few
structured facts the profile shows.

Three rules keep this honest rather than merely convenient:

1. **Category, never rate.** A Part 2A fee schedule is typically tiered *and*
   negotiable ("$0-$250,000 1.25% ... Fees for portfolio management services
   are negotiable"). Publishing "1.25%" as *the* fee would misstate a
   negotiable schedule, so ``fee_structure`` stays at the category level
   ("Percentage of assets under management") and any entry carrying a rate is
   dropped on the way out.
2. **A stated absence is not a value.** Olympus Peaks' brochure says "There is
   no account minimum for any of OPFL's services" — the only time the word
   appears in 23 pages. A keyword grab near "minimum" would publish a number
   the filing explicitly denies, so the prompt and the validator both treat a
   stated absence as ``None``.
3. **Never raise.** This is best-effort enrichment behind a claim that must
   always stand. Every fault — fetch, size, parse, model, JSON — returns the
   empty shape with an ``"error"`` key.

Nothing from the PDF body is ever logged.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
from typing import Any

import httpx

from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.services.ria_claim_service import title_case_name

logger = logging.getLogger(__name__)

# Hard bounds. A Form ADV Part 2A is a ~20-30 page narrative; anything past
# these limits is a filing we should decline rather than pay to read.
FETCH_TIMEOUT_SECONDS = 20.0
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PAGES = 15
MAX_TEXT_CHARS = 40_000

# Shape guards for what we are willing to publish onto a profile.
MAX_LIST_ITEMS = 12
MAX_ITEM_CHARS = 120
# A plausible engagement minimum. Anything larger is a parse artefact
# (an AUM figure, a fee table cell) rather than a stated minimum.
MAX_MIN_ENGAGEMENT = 1_000_000_000.0

_HTTP_HEADERS = {
    "User-Agent": "hushh-consent-protocol/1.0 (+https://hushh.ai) Form ADV reader",
    "Accept": "application/pdf,*/*",
}

# Table-of-contents debris: the section headers appear twice in a Part 2A,
# once with dotted leaders and a page number, once as real content. Feeding
# the leader lines to the model teaches it that "Item 5 Fees ... 7" is the
# fee section, so they are stripped before the slice is taken.
_TOC_LEADER_LINE = re.compile(r"\.{2,}\s*\d{1,3}\s*$")
_TOC_HEADING_LINE = re.compile(r"^\s*table of contents\s*$", re.IGNORECASE)
_TOC_ITEM_LINE = re.compile(r"^\s*item\s+\d+\b.*\s{2,}\d{1,3}\s*$", re.IGNORECASE)

# A fee entry carrying a number is a rate, not a category.
_RATE_LIKE = re.compile(
    r"(\d\s*%|%\s*\d|\$\s*[\d,]|\b\d+(?:\.\d+)?\s*(?:bps|basis points)\b)", re.I
)

_EXTRACTION_PROMPT = """You are reading an investment adviser's Form ADV Part 2A brochure for {firm_name}.

Extract ONLY what this brochure states. You are not summarising, advertising, or inferring.

RULES — these override any instinct to be helpful:
1. If the brochure does not state something, return an empty list or null. Never guess, never
   generalise from what advisers usually offer, never carry a fact over from another firm.
2. "services_offered" is a short list of the advisory services this brochure says the firm
   provides (Item 4 / Item 7 territory). Use plain service names, e.g. "Portfolio management",
   "Financial planning", "Retirement plan consulting". Do not include client types
   ("Individuals", "High-net-worth individuals", "Pension plans") — those are who, not what.
3. "fee_structure" is a list of fee CATEGORIES only, e.g. "Percentage of assets under
   management", "Hourly", "Fixed fees", "Performance-based". NEVER return a rate, a
   percentage, a dollar amount, a tier, or a basis-point figure. Fee schedules are commonly
   tiered and negotiable, so a single number would misstate them.
4. "min_engagement_amount" is the minimum account size or minimum engagement the brochure
   REQUIRES, as a plain number. If the brochure says there is NO minimum (for example
   "there is no account minimum"), return null. If it is silent, return null. A stated
   absence is null, never zero and never a guessed figure.

Return STRICT JSON, nothing else, in exactly this shape:
{{"services_offered": ["..."], "fee_structure": ["..."], "min_engagement_amount": null}}

BROCHURE TEXT:
{brochure_text}
"""

# Every word this module is allowed to add to a factual bio beyond the facts
# themselves. The bio must read as a restatement of the profile, not as copy.
BIO_CONNECTIVE_TOKENS = frozenset(
    {
        "is",
        "an",
        "a",
        "at",
        "in",
        "investment",
        "adviser",
        "firm",
        "registered",
        "since",
        "crd",
        "sec",
        "state",
    }
)


# Strong references keep fire-and-forget workers alive until they finish
# (asyncio holds tasks weakly); mirrors the dossier lane's tracked-task set.
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()

# The label persisted as ria_profiles.profile_source so the UI can say where
# these words came from rather than presenting them as the adviser's own.
PROFILE_SOURCE_LABEL = "form_adv_part2"


def _track_background_task(task: asyncio.Task[Any]) -> None:
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _empty_result(
    *,
    error: str = "",
    source_url: str = "",
    source_name: str = "",
    source_filed_on: str = "",
) -> dict[str, Any]:
    """The published shape with nothing in it. Errors always land here."""
    result: dict[str, Any] = {
        "services_offered": [],
        "fee_structure": [],
        "min_engagement_amount": None,
        "min_engagement_currency": "USD",
        "source_url": source_url,
        "source_name": source_name,
        "source_filed_on": source_filed_on,
    }
    if error:
        result["error"] = error
    return result


# ---------------------------------------------------------------------------
# Brochure selection
# ---------------------------------------------------------------------------


def select_brochure(brochures: Any) -> dict[str, str]:
    """Pick the firm brochure to read: Part 2A first, then anything filed.

    Part 2B is a *supplement* about one individual — education, exams, other
    business activities. It says nothing authoritative about what the firm
    offers or charges, so it is only ever a fallback.

    Accepts both the shaped claim snapshot (``date_submitted``) and the raw
    identity-API payload (``dateSubmitted``); returns ``{}`` when nothing
    usable is on file.
    """
    entries: list[dict[str, str]] = []
    for item in brochures if isinstance(brochures, list) else []:
        if not isinstance(item, dict):
            continue
        url = _clean_text(item.get("url"))
        if not url:
            continue
        entries.append(
            {
                "url": url,
                "name": _clean_text(item.get("name")),
                "filed_on": _clean_text(item.get("date_submitted") or item.get("dateSubmitted")),
            }
        )
    if not entries:
        return {}
    for entry in entries:
        if "2a" in entry["name"].lower():
            return entry
    return entries[0]


# ---------------------------------------------------------------------------
# Fetch (bounded) and text extraction (bounded)
# ---------------------------------------------------------------------------


async def _fetch_pdf_bytes(url: str) -> tuple[bytes, str]:
    """Download the filing under a hard timeout and a hard size cap.

    The SEC URLs are ``.aspx`` redirectors in front of the PDF, so redirects
    are followed. The cap is enforced on the streamed body, not just on
    Content-Length, so a server that lies about the length still cannot make
    us hold 200 MB.
    """
    try:
        async with httpx.AsyncClient(
            timeout=FETCH_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers=_HTTP_HEADERS,
        ) as client:
            async with client.stream("GET", url) as response:
                if response.status_code != 200:
                    return b"", f"fetch_status_{response.status_code}"
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_PDF_BYTES:
                    return b"", "brochure_too_large"
                buffer = bytearray()
                async for chunk in response.aiter_bytes():
                    buffer.extend(chunk)
                    if len(buffer) > MAX_PDF_BYTES:
                        return b"", "brochure_too_large"
                return bytes(buffer), ""
    except httpx.HTTPError as exc:
        logger.info("ria.brochure_fetch_failed error=%s", type(exc).__name__)
        return b"", f"fetch_failed:{type(exc).__name__}"
    except Exception as exc:  # noqa: BLE001 - enrichment never raises
        logger.info("ria.brochure_fetch_error error=%s", type(exc).__name__)
        return b"", f"fetch_error:{type(exc).__name__}"


def strip_table_of_contents(text: str) -> str:
    """Drop the dotted-leader contents block so headers are read once.

    A Part 2A lists every Item twice: page 1-3 as a contents table with dotted
    leaders and page numbers, then again as the body. Searching the raw text
    for "Advisory Business" matches the contents entry first and yields a page
    number where the content should be.
    """
    kept: list[str] = []
    for line in str(text or "").splitlines():
        if _TOC_HEADING_LINE.match(line):
            continue
        if _TOC_LEADER_LINE.search(line):
            continue
        if _TOC_ITEM_LINE.match(line):
            continue
        kept.append(line)
    return "\n".join(kept)


def _extract_pdf_text(data: bytes) -> str:
    """Read at most MAX_PAGES pages of text. Blocking; call in a thread."""
    import pdfplumber

    pages: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages[:MAX_PAGES]:
            try:
                pages.append(page.extract_text() or "")
            except Exception:  # noqa: BLE001 - one bad page is not a failed read
                continue
    return "\n".join(pages)


async def _brochure_text(data: bytes) -> tuple[str, str]:
    try:
        raw = await asyncio.to_thread(_extract_pdf_text, data)
    except Exception as exc:  # noqa: BLE001 - a corrupt filing is an empty result
        logger.info("ria.brochure_parse_failed error=%s", type(exc).__name__)
        return "", f"parse_failed:{type(exc).__name__}"
    text = strip_table_of_contents(raw).strip()
    if not text:
        return "", "no_text_extracted"
    return text[:MAX_TEXT_CHARS], ""


# ---------------------------------------------------------------------------
# Model call + defensive validation
# ---------------------------------------------------------------------------


async def _run_model(prompt: str) -> tuple[dict[str, Any], str]:
    """Ask the managed Gemini runtime for strict JSON. Never raises."""
    try:
        from google.genai import types as genai_types

        from hushh_mcp.runtime_providers import (
            build_generate_content_config,
            build_managed_runtime_client,
        )

        client = build_managed_runtime_client("gemini")
    except Exception as exc:  # noqa: BLE001 - no brain is an empty result
        logger.info("ria.brochure_model_unavailable error=%s", type(exc).__name__)
        return {}, f"model_unavailable:{type(exc).__name__}"
    if client is None:
        return {}, "model_unavailable"

    try:
        config = build_generate_content_config(
            genai_types,
            GEMINI_MODEL,
            response_mime_type="application/json",
            temperature=0.1,
        )
        response = await client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=config,
        )
    except Exception as exc:  # noqa: BLE001 - enrichment never raises
        logger.info("ria.brochure_model_failed error=%s", type(exc).__name__)
        return {}, f"model_failed:{type(exc).__name__}"

    try:
        parsed = json.loads(_clean_text(getattr(response, "text", "")))
    except (TypeError, ValueError):
        # Never log the body: it is the filing's text, not ours to emit.
        logger.info("ria.brochure_model_json_invalid")
        return {}, "model_json_invalid"
    if not isinstance(parsed, dict):
        return {}, "model_json_not_an_object"
    return parsed, ""


def _coerce_str_list(value: Any, *, drop_rates: bool = False) -> list[str]:
    """Strings only, trimmed, deduped, bounded. Wrong types collapse to []."""
    if not isinstance(value, list):
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        entry = " ".join(item.split())
        if not entry or len(entry) > MAX_ITEM_CHARS:
            continue
        if not any(char.isalpha() for char in entry):
            continue
        if drop_rates and _RATE_LIKE.search(entry):
            # A tiered, negotiable schedule cannot be published as one number.
            continue
        key = entry.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(entry)
        if len(cleaned) >= MAX_LIST_ITEMS:
            break
    return cleaned


def _coerce_minimum(value: Any) -> float | None:
    """A stated minimum, or None. Zero means 'no minimum', which is None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        amount = float(value)
    elif isinstance(value, str):
        digits = re.sub(r"[^0-9.]", "", value)
        if digits.count(".") > 1 or not digits.strip("."):
            return None
        try:
            amount = float(digits)
        except ValueError:
            return None
    else:
        return None
    if amount <= 0 or amount > MAX_MIN_ENGAGEMENT or amount != amount:
        return None
    return amount


def validate_model_payload(payload: Any) -> dict[str, Any]:
    """Reduce whatever the model returned to values we are willing to publish."""
    body = payload if isinstance(payload, dict) else {}
    return {
        "services_offered": _coerce_str_list(body.get("services_offered")),
        "fee_structure": _coerce_str_list(body.get("fee_structure"), drop_rates=True),
        "min_engagement_amount": _coerce_minimum(body.get("min_engagement_amount")),
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def extract_profile_from_brochure(brochures: list[dict], *, firm_name: str) -> dict[str, Any]:
    """Read the firm's Form ADV Part 2A into the profile's narrative fields.

    Best-effort by contract: every failure returns the empty shape with an
    ``"error"`` key, and nothing here ever raises into the claim.
    """
    selected = select_brochure(brochures)
    if not selected:
        return _empty_result(error="no_brochure_on_file")

    url = selected["url"]
    source = {
        "source_url": url,
        "source_name": selected["name"],
        "source_filed_on": selected["filed_on"],
    }
    logger.info(
        "ria.brochure_extract_started brochure=%s",
        selected["name"] or "unnamed",
    )

    data, fetch_error = await _fetch_pdf_bytes(url)
    if fetch_error:
        return _empty_result(error=fetch_error, **source)

    text, parse_error = await _brochure_text(data)
    if parse_error:
        return _empty_result(error=parse_error, **source)

    prompt = _EXTRACTION_PROMPT.format(
        firm_name=_clean_text(firm_name) or "this firm",
        brochure_text=text,
    )
    payload, model_error = await _run_model(prompt)
    if model_error:
        return _empty_result(error=model_error, **source)

    fields = validate_model_payload(payload)
    logger.info(
        "ria.brochure_extract_done services=%d fees=%d minimum=%s",
        len(fields["services_offered"]),
        len(fields["fee_structure"]),
        fields["min_engagement_amount"] is not None,
    )
    return {
        **fields,
        "min_engagement_currency": "USD",
        **source,
    }


# ---------------------------------------------------------------------------
# Post-claim dispatch: background, best-effort, blanks-only
# ---------------------------------------------------------------------------


async def enrich_claimed_profile(
    *,
    ria_profile_id: str,
    reference_metadata: dict[str, Any],
    iam_service: Any = None,
) -> dict[str, Any]:
    """Read the brochure, build the bio, and fill only what is still blank.

    Returns a small status dict for tests and logs. Never raises: the claim
    that dispatched this has already succeeded and must stay succeeded.
    """
    profile_id = _clean_text(ria_profile_id)
    metadata = reference_metadata if isinstance(reference_metadata, dict) else {}
    if not profile_id:
        return {"status": "skipped", "reason": "missing_profile_id"}

    firm_raw = metadata.get("firm_record")
    firm = firm_raw if isinstance(firm_raw, dict) else {}

    extracted = _empty_result(error="not_attempted")
    try:
        extracted = await extract_profile_from_brochure(
            firm.get("brochures") or [],
            firm_name=_clean_text(firm.get("name")),
        )
    except Exception:  # noqa: BLE001 - extraction is contractually non-raising
        logger.warning("ria.brochure_extract_unexpected_error", exc_info=True)

    try:
        bio = build_factual_bio(metadata)
    except Exception:  # noqa: BLE001 - a missing bio is not a failed claim
        logger.warning("ria.brochure_bio_failed", exc_info=True)
        bio = ""

    has_brochure_values = bool(
        extracted.get("services_offered")
        or extracted.get("fee_structure")
        or extracted.get("min_engagement_amount") is not None
    )
    if not has_brochure_values and not bio:
        return {"status": "nothing_to_write", "error": _clean_text(extracted.get("error"))}

    try:
        if iam_service is None:
            from hushh_mcp.services.ria_iam_service import RIAIAMService

            iam_service = RIAIAMService()
        filled = await iam_service.apply_brochure_profile_fields(
            profile_id,
            services_offered=extracted.get("services_offered") or [],
            fee_structure=extracted.get("fee_structure") or [],
            min_engagement_amount=extracted.get("min_engagement_amount"),
            min_engagement_currency=_clean_text(extracted.get("min_engagement_currency")) or "USD",
            bio=bio,
            # Provenance only means anything when a brochure supplied it; a
            # bio-only write restates facts the profile already shows.
            profile_source=PROFILE_SOURCE_LABEL if has_brochure_values else "",
            profile_source_url=(
                _clean_text(extracted.get("source_url")) if has_brochure_values else ""
            ),
            profile_source_filed_on=(
                _clean_text(extracted.get("source_filed_on")) if has_brochure_values else ""
            ),
        )
    except Exception:  # noqa: BLE001 - the profile write can never fail a claim
        logger.warning("ria.brochure_profile_write_failed", exc_info=True)
        return {"status": "write_failed"}

    logger.info("ria.brochure_profile_written filled=%s", bool(filled))
    return {"status": "written" if filled else "no_blanks_to_fill"}


def dispatch_profile_enrichment(
    *,
    ria_profile_id: str,
    reference_metadata: dict[str, Any],
) -> bool:
    """Fire the enrichment behind the claim. Returns whether a task started."""
    try:
        task = asyncio.create_task(
            enrich_claimed_profile(
                ria_profile_id=ria_profile_id,
                reference_metadata=reference_metadata,
            )
        )
    except RuntimeError:
        # No running loop (sync call path): the profile simply stays blank.
        logger.info("ria.brochure_dispatch_no_event_loop")
        return False
    _track_background_task(task)
    return True


# ---------------------------------------------------------------------------
# The factual bio — no model, no adjectives
# ---------------------------------------------------------------------------


def _bio_location(reference_metadata: dict[str, Any]) -> str:
    """City, ST from the same source the profile's LOCATION block uses."""
    firm_raw = reference_metadata.get("firm_record")
    firm = firm_raw if isinstance(firm_raw, dict) else {}
    advisor_raw = reference_metadata.get("advisor_record")
    advisor = advisor_raw if isinstance(advisor_raw, dict) else {}
    branch_raw = advisor.get("branch")
    branch = branch_raw if isinstance(branch_raw, dict) else {}

    # A private-residence branch is somebody's home; it never reaches a profile.
    if branch and not branch.get("private_residence"):
        city, state = _clean_text(branch.get("city")), _clean_text(branch.get("state"))
        if city or state:
            return ", ".join(part for part in (title_case_name(city), state.upper()) if part)
    city, state = _clean_text(firm.get("city")), _clean_text(firm.get("state"))
    if city or state:
        return ", ".join(part for part in (title_case_name(city), state.upper()) if part)
    return ""


def build_factual_bio(reference_metadata: dict) -> str:
    """One factual sentence built only from facts already shown on the profile.

    Name, firm, city/state, CRD, registration status and year, exam codes —
    every one of them already visible above the bio. No adjective, no claim
    about quality, specialisation, or client outcome enters here, because
    nothing in the SEC record supports one. Returns "" when the facts are too
    thin to say anything true.
    """
    metadata = reference_metadata if isinstance(reference_metadata, dict) else {}
    firm_raw = metadata.get("firm_record")
    firm = firm_raw if isinstance(firm_raw, dict) else {}
    advisor_raw = metadata.get("advisor_record")
    advisor = advisor_raw if isinstance(advisor_raw, dict) else {}

    claim_type = _clean_text(metadata.get("claim_type")).lower()
    firm_name = title_case_name(_clean_text(firm.get("name")))
    person_name = title_case_name(_clean_text(metadata.get("display_name")))
    location = _bio_location(metadata)
    regulator = "SEC" if _clean_text(firm.get("registration_type")).lower() == "sec" else "State"

    if claim_type == "firm" or not person_name:
        subject = firm_name
        crd = _clean_text(metadata.get("firm_crd")) or _clean_text(firm.get("crd"))
        opening = f"{subject} is an investment adviser firm"
    else:
        subject = person_name
        crd = _clean_text(metadata.get("individual_crd")) or _clean_text(advisor.get("crd"))
        opening = f"{subject} is an investment adviser"
        if firm_name:
            opening += f" at {firm_name}"
    if not subject:
        return ""

    # Registration year only: a full filing date would be a fact the profile
    # does not otherwise show.
    since = ""
    match = re.search(r"\b(19|20)\d{2}\b", _clean_text(advisor.get("registered_since")))
    if match:
        since = match.group(0)

    exams = [
        _clean_text(exam.get("code"))
        for exam in (advisor.get("exams") or [])
        if isinstance(exam, dict) and _clean_text(exam.get("code"))
    ]

    # A name on its own is not a bio; it must carry at least one hard fact.
    if not (location or crd or since or exams or (claim_type != "firm" and firm_name)):
        return ""

    sentences: list[str] = [f"{opening} in {location}." if location else f"{opening}."]

    registration = f"{regulator}-registered"
    if since:
        registration += f" since {since}"
    if crd:
        registration += f" (CRD {crd})"
    if since or crd:
        sentences.append(f"{registration}.")

    if exams:
        sentences.append(f"{', '.join(dict.fromkeys(exams))}.")

    return " ".join(sentences)
