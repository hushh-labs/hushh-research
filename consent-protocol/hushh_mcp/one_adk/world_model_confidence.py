"""Deterministic evidence-strength check for PWM's reviewable web draft.

This is a review signal, not a probability that a statement is true. Gemini
supplies the claim and its citations; the host scores only evidence it received.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from hushh_mcp.one_adk.profile_research import ProfileFact, ProfileSourceRef

PREFERENCE_TOPICS = frozenset(
    {
        "interests",
        "preferences",
        "dislikes",
        "style",
        "food",
        "travel",
        "entertainment",
        "shopping",
        "communication",
    }
)


def evidence_rating(
    *,
    fact: ProfileFact[ProfileSourceRef],
    topic: str,
    identity_state: str,
    receipts: dict[str, dict[str, str]],
) -> dict[str, int | str]:
    """Rate received citations, source independence and the identity gate.

    A search receipt alone cannot prove the cited page says the claim, so this
    score measures only a source trail and never rises above the review band.
    """
    urls = {
        receipts[source.ref]["url"]
        for source in fact.sources
        if source.ref in receipts and receipts[source.ref].get("url")
    }
    hosts = {(urlsplit(url).hostname or "").removeprefix("www.").casefold() for url in urls} - {""}
    if not urls:
        return {"evidence_score": 1, "evidence_reason": "No usable public source receipt."}

    score = 2 + min(1, max(0, len(hosts) - 1))
    if identity_state == "owner_linked":
        score += 1
    if fact.confidence == "conflicting":
        score = 1
    if identity_state == "candidate_for_review":
        score = min(score, 2)
    elif identity_state != "owner_linked":
        score = 1
    if topic in PREFERENCE_TOPICS:
        score = min(score, 3)
    score = max(1, min(4, score))

    source_count = len(urls)
    source_line = f"{source_count} cited public {'page' if source_count == 1 else 'pages'}"
    if identity_state != "owner_linked":
        reason = f"{source_line}; this public profile is not linked to your account. Source content is unverified."
    elif fact.confidence == "conflicting":
        reason = f"{source_line}; the sources disagree. Source content is unverified."
    elif topic in PREFERENCE_TOPICS:
        reason = f"{source_line}; a public trace cannot confirm a personal preference. Source content is unverified."
    else:
        reason = f"{source_line}; linked candidate, but source content is unverified."
    return {"evidence_score": score, "evidence_reason": reason}
