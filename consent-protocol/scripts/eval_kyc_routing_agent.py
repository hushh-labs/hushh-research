#!/usr/bin/env python3
"""KYC routing eval harness.

Runs an inline labeled dataset through classify_kyc_request and reports
per-case pass/fail + overall accuracy. Mirrors eval_pkm_structure_agent.py
in structure.

Usage (requires real Gemini; set KYC_EVAL_LIVE=1):
    KYC_EVAL_LIVE=1 .venv/bin/python scripts/eval_kyc_routing_agent.py

Under normal import/test the live-LLM path is NEVER reached.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

CONSENT_PROTOCOL_ROOT = Path(__file__).resolve().parents[1]
if str(CONSENT_PROTOCOL_ROOT) not in sys.path:
    sys.path.insert(0, str(CONSENT_PROTOCOL_ROOT))

# ---------------------------------------------------------------------------
# Inline labeled dataset
# ---------------------------------------------------------------------------
# Each case: {subject, body, pkm_index, expected_domain, expected_classification}
#   expected_domain:          first element that must appear in primary_domains
#   expected_classification:  exact match for the 'classification' field
# ---------------------------------------------------------------------------

DATASET: list[dict[str, Any]] = [
    # Case 1 — bug regression: hotel booking must route to identity, not travel
    {
        "id": "hotel_booking_identity",
        "subject": "Action required: confirm your hotel booking",
        "body": (
            "Dear guest, please provide your information to confirm your hotel booking. "
            "We need your full name, address, and date of birth to complete your reservation."
        ),
        "pkm_index": {
            "available_domains": ["identity", "travel"],
            "domain_summaries": {
                "travel": "flight search history, hotel preferences, trip notes",
                "identity": "full name, date of birth, residential address",
            },
        },
        "expected_domain": "identity",
        "expected_classification": "kyc",
    },
    # Case 2 — financial portfolio request
    {
        "id": "financial_portfolio",
        "subject": "Portfolio data request for investment analysis",
        "body": (
            "We are requesting access to your financial portfolio information, "
            "including your current holdings, brokerage accounts, and investment profile, "
            "to complete our investment suitability assessment."
        ),
        "pkm_index": {
            "available_domains": ["financial", "identity"],
            "domain_summaries": {
                "financial": "portfolio holdings, brokerage accounts, investment profile",
                "identity": "full name, date of birth, address",
            },
        },
        "expected_domain": "financial",
        "expected_classification": "kyc_financial",
    },
    # Case 3 — plain identity verification
    {
        "id": "plain_identity_kyc",
        "subject": "Identity verification required",
        "body": (
            "To complete your account setup, we need to verify your identity. "
            "Please provide your full name, date of birth, and government-issued ID number."
        ),
        "pkm_index": {
            "available_domains": ["identity"],
            "domain_summaries": {
                "identity": "full name, date of birth, national ID, address",
            },
        },
        "expected_domain": "identity",
        "expected_classification": "kyc",
    },
    # Case 4 — unsupported: newsletter / marketing email, no data request
    {
        "id": "unsupported_newsletter",
        "subject": "Your weekly newsletter",
        "body": (
            "Hello! Here are this week's top stories and market updates. "
            "Click below to read more. No action is required from you."
        ),
        "pkm_index": {
            "available_domains": ["identity", "financial"],
            "domain_summaries": {
                "identity": "full name, date of birth",
                "financial": "portfolio holdings",
            },
        },
        "expected_domain": None,
        "expected_classification": "unsupported",
    },
    # Case 5 — broker onboarding: identity + financial combined
    {
        "id": "broker_onboarding_kyc_financial",
        "subject": "Complete your broker onboarding",
        "body": (
            "As part of our KYC and AML compliance process, we require your full name, "
            "date of birth, address, employment information, source of funds, "
            "and financial profile including portfolio holdings and net worth."
        ),
        "pkm_index": {
            "available_domains": ["identity", "financial", "professional"],
            "domain_summaries": {
                "identity": "full name, date of birth, address, nationality",
                "financial": "portfolio holdings, net worth, source of funds",
                "professional": "employment history, company name",
            },
        },
        "expected_domain": "identity",
        "expected_classification": "kyc_financial",
    },
    # Case 6 — travel preference survey (unsupported: asks about preferences, not KYC)
    {
        "id": "travel_preference_survey",
        "subject": "Share your travel preferences",
        "body": (
            "We would love to know more about your travel preferences! "
            "What types of destinations do you enjoy? Do you prefer window or aisle seats? "
            "This helps us personalise your experience."
        ),
        "pkm_index": {
            "available_domains": ["travel", "identity"],
            "domain_summaries": {
                "travel": "flight preferences, destination history",
                "identity": "full name, date of birth",
            },
        },
        "expected_domain": None,
        "expected_classification": "unsupported",
    },
    # Case 7 — accredited investor verification: financial primary
    {
        "id": "accredited_investor_financial",
        "subject": "Accredited investor status verification",
        "body": (
            "To participate in this private offering, you must verify your status as an "
            "accredited investor. Please provide your annual income, net worth, and "
            "brokerage statements for the past two years."
        ),
        "pkm_index": {
            "available_domains": ["financial", "identity"],
            "domain_summaries": {
                "financial": "annual income, net worth, brokerage statements",
                "identity": "full name, address",
            },
        },
        "expected_domain": "financial",
        "expected_classification": "kyc_financial",
    },
    # Case 8 — address-only verification: identity domain
    {
        "id": "address_verification",
        "subject": "Address verification for your account",
        "body": (
            "We need to verify your current residential address to comply with our "
            "customer due diligence requirements. Please confirm your street address, "
            "city, state, and postal code."
        ),
        "pkm_index": {
            "available_domains": ["identity", "travel", "shopping"],
            "domain_summaries": {
                "identity": "full name, date of birth, residential address",
                "travel": "trip notes, hotel preferences",
                "shopping": "favourite brands, wishlist",
            },
        },
        "expected_domain": "identity",
        "expected_classification": "kyc",
    },
    # Case 9 — employment verification: identity primary (not professional)
    {
        "id": "employment_for_kyc",
        "subject": "Employment information for KYC",
        "body": (
            "As part of our know-your-customer process, we require your current employer "
            "name, job title, and employment status to complete your profile verification."
        ),
        "pkm_index": {
            "available_domains": ["identity", "professional"],
            "domain_summaries": {
                "identity": "full name, date of birth, employment",
                "professional": "work history, company, title",
            },
        },
        "expected_domain": "identity",
        "expected_classification": "kyc",
    },
    # Case 10 — spam / no personal data requested: unsupported
    {
        "id": "unsupported_promo",
        "subject": "Exclusive offer just for you!",
        "body": (
            "Don't miss our limited-time promotion. Click here to claim your discount. "
            "This offer expires in 24 hours. No personal information needed."
        ),
        "pkm_index": {
            "available_domains": ["shopping", "identity"],
            "domain_summaries": {
                "shopping": "favourite brands, purchase history",
                "identity": "full name, date of birth",
            },
        },
        "expected_domain": None,
        "expected_classification": "unsupported",
    },
]

_REQUIRED_KEYS = frozenset(
    {"id", "subject", "body", "pkm_index", "expected_domain", "expected_classification"}
)


def _case_passes(result: dict[str, Any], case: dict[str, Any]) -> bool:
    """Return True when the routing result satisfies the case's expected labels."""
    expected_cls = case["expected_classification"]
    expected_domain = case["expected_domain"]

    actual_cls = result.get("classification", "")
    primary_domains: list[str] = result.get("primary_domains") or []

    cls_ok = actual_cls == expected_cls
    if expected_domain is None:
        domain_ok = True  # unsupported cases: domain check not applicable
    else:
        domain_ok = expected_domain in primary_domains
    return cls_ok and domain_ok


async def run_eval(
    *,
    classifier: Any = None,
    dataset: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run the eval dataset through classify_kyc_request.

    Args:
        classifier: Optional callable (or service instance) to use instead of
            the real OneEmailKycService. Accepts keyword args
            (subject, body, pkm_index) and returns the routing dict. When
            None and KYC_EVAL_LIVE=1 is set, the real service is used.
        dataset: Override the default DATASET (used by self-tests).

    Returns:
        Dict with keys: cases (list of per-case results), passed, total, accuracy.
    """
    cases_to_run = dataset if dataset is not None else DATASET

    if classifier is None:
        if not os.getenv("KYC_EVAL_LIVE"):
            raise RuntimeError(
                "KYC_EVAL_LIVE=1 must be set to run eval against the real classifier. "
                "Pass a stub via the 'classifier' argument for unit tests."
            )
        from hushh_mcp.services.one_email_kyc_service import get_one_email_kyc_service

        svc = get_one_email_kyc_service()

        async def _real_classify(**kwargs: Any) -> dict[str, Any]:
            return await svc.classify_kyc_request(**kwargs)

        classify_fn = _real_classify
    else:
        # Accept both a plain coroutine function and an object with classify_kyc_request.
        if hasattr(classifier, "classify_kyc_request"):

            async def _method_classify(**kwargs: Any) -> dict[str, Any]:
                return await classifier.classify_kyc_request(**kwargs)

            classify_fn = _method_classify
        else:
            classify_fn = classifier

    results: list[dict[str, Any]] = []
    passed = 0

    for case in cases_to_run:
        result = await classify_fn(
            subject=case["subject"],
            body=case["body"],
            pkm_index=case["pkm_index"],
        )
        ok = _case_passes(result, case)
        if ok:
            passed += 1

        status = "PASS" if ok else "FAIL"
        print(
            f"[{status}] {case['id']}: "
            f"classification={result.get('classification')!r} "
            f"primary_domains={result.get('primary_domains')}"
        )
        results.append(
            {
                "id": case["id"],
                "passed": ok,
                "expected_classification": case["expected_classification"],
                "expected_domain": case["expected_domain"],
                "actual_classification": result.get("classification"),
                "actual_primary_domains": result.get("primary_domains"),
            }
        )

    total = len(cases_to_run)
    accuracy = passed / total if total else 0.0
    print(f"\nAccuracy: {passed}/{total} ({accuracy:.1%})")
    return {"cases": results, "passed": passed, "total": total, "accuracy": accuracy}


if __name__ == "__main__":
    asyncio.run(run_eval())
