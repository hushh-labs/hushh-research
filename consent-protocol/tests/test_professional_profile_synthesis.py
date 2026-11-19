"""Public professional synthesis API and provider-boundary contracts."""

from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.developer_contract_harness import _build_app, _fake_principal


def _professional_profile_input():
    return {
        "name": "Example Research Subject",
        "dob": "1998-01-11",
        "gender": "self-described",
        "school": "Example School",
        "college": "Example College",
    }


@pytest.mark.parametrize(
    "anchors",
    [
        {"school": "School", "college": "College"},
        {"school": "School", "company": "Company"},
        {"college": "College", "company": "Company"},
        {"school": "School", "college": "College", "company": "Company"},
    ],
)
def test_professional_synthesis_accepts_every_two_anchor_pair_and_all_three(monkeypatch, anchors):
    from api.routes import professional_profile as route
    from hushh_mcp.services.professional_profile_synthesis import ProfessionalProfileReport

    received = []

    async def synthesize(body):
        received.append(body)
        return ProfessionalProfileReport(
            request_id="fixture-request",
            status="partial",
            model="fixture-model",
            point_count=0,
            missing_points=list(range(1, 361)),
            points=[],
            report_markdown="",
            sources=[],
            search_suggestions_html=[],
            failures=[],
        )

    monkeypatch.setattr(route, "synthesize_professional_profile", synthesize)
    monkeypatch.setattr(
        route, "authenticate_developer_principal", lambda **kwargs: _fake_principal()
    )
    body = {
        k: v
        for k, v in _professional_profile_input().items()
        if k not in {"school", "college", "company"}
    }
    body.update(anchors)
    response = TestClient(_build_app()).post("/api/v1/professional-profile/synthesize", json=body)
    assert response.status_code == 200
    assert len(received) == 1
    assert response.json()["verification"] == "model_generated_not_independently_verified"
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize(
    "updates,removed",
    [
        ({"school": None, "college": None}, ()),
        ({"college": None}, ()),
        ({"school": "  ", "college": None, "company": "Company"}, ()),
        ({"school": " \n ", "company": None}, ()),
        ({"dob": "2100-01-01"}, ()),
        ({"dob": "1998-02-30"}, ()),
        ({"dob": "11-01-1998"}, ()),
        ({"dob": 12345678}, ()),
        ({"name": "   "}, ()),
        ({"gender": "   "}, ()),
        ({"prompt": "private injected value"}, ()),
        ({}, ("name",)),
        ({}, ("dob",)),
        ({}, ("gender",)),
    ],
)
def test_professional_synthesis_invalid_input_never_reaches_paid_generation(
    monkeypatch, updates, removed
):
    from api.routes import professional_profile as route

    async def must_not_generate(body):
        pytest.fail("Invalid identity/anchor input reached paid generation")

    monkeypatch.setattr(
        route, "authenticate_developer_principal", lambda **kwargs: _fake_principal()
    )
    monkeypatch.setattr(route, "synthesize_professional_profile", must_not_generate)
    body = _professional_profile_input()
    body.update(updates)
    for key in removed:
        body.pop(key)
    response = TestClient(_build_app()).post("/api/v1/professional-profile/synthesize", json=body)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INVALID_PROFILE_INPUT"
    assert body.get("name", "not-present") not in response.text
    assert "1998-01-11" not in response.text
    assert "private injected value" not in response.text
    assert response.headers["cache-control"] == "private, no-store"


def test_professional_synthesis_auth_and_provider_failures_are_private(monkeypatch):
    from api.routes import professional_profile as route

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DEVELOPER_API_ENABLED", "true")
    calls = []

    async def unavailable(body):
        calls.append(body)
        raise RuntimeError("private-provider-token-and-subject")

    monkeypatch.setattr(route, "synthesize_professional_profile", unavailable)
    client = TestClient(_build_app())
    denied = client.post(
        "/api/v1/professional-profile/synthesize", json=_professional_profile_input()
    )
    assert denied.status_code == 401
    assert calls == []
    assert denied.headers["cache-control"] == "private, no-store"
    monkeypatch.setattr(
        route, "authenticate_developer_principal", lambda **kwargs: _fake_principal()
    )
    failed = client.post(
        "/api/v1/professional-profile/synthesize", json=_professional_profile_input()
    )
    assert failed.status_code == 503
    assert len(calls) == 1
    assert "private-provider-token-and-subject" not in failed.text
    assert failed.headers["cache-control"] == "private, no-store"


@pytest.mark.asyncio
async def test_professional_synthesis_completes_missing_point_without_assessor_or_rewriting(caplog):
    from hushh_mcp.services.professional_profile_synthesis import (
        ProfessionalProfileRequest,
        synthesize_professional_profile,
    )

    calls = []

    async def generate(contents, request_id):
        prompt = contents[-1].parts[0].text
        calls.append((prompt, request_id))
        if "only the missing" in prompt:
            text = "#256 [ECOSYSTEM-CONTEXT] Model-authored repaired point."
        else:
            low, high = map(
                int, re.search(r"ONLY points #(\d{3}) through #(\d{3})", prompt).groups()
            )
            text = "\n".join(
                f"#{n:03} [ECOSYSTEM-CONTEXT] Model-authored point {n}."
                for n in range(low, high + 1)
                if n != 256
            )
        web = SimpleNamespace(uri="https://example.org/public-source", title="Public source")
        grounding = SimpleNamespace(
            grounding_chunks=[SimpleNamespace(web=web)],
            search_entry_point=SimpleNamespace(rendered_content="<div>Provider suggestions</div>"),
        )
        return SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(parts=[SimpleNamespace(text=text, thought=False)]),
                    finish_reason="STOP",
                    grounding_metadata=grounding,
                )
            ]
        )

    report = await synthesize_professional_profile(
        ProfessionalProfileRequest(**_professional_profile_input()),
        generate=generate,
        model="fixture-model",
    )
    assert report.status == "complete"
    assert [point.number for point in report.points] == list(range(1, 361))
    assert report.points[255].markdown == "#256 [ECOSYSTEM-CONTEXT] Model-authored repaired point."
    assert report.points[0].markdown == "#001 [ECOSYSTEM-CONTEXT] Model-authored point 1."
    assert report.missing_points == []
    assert report.verification == "model_generated_not_independently_verified"
    assert len(calls) == 3  # two report pages and one explicit missing-point continuation
    assert len({request_id for _, request_id in calls}) == 1
    assert [source.url for source in report.sources] == ["https://example.org/public-source"]
    assert report.search_suggestions_html == ["<div>Provider suggestions</div>"]
    assert report.persisted is False
    assert "Example Research Subject" not in caplog.text
    assert "1998-01-11" not in caplog.text


@pytest.mark.asyncio
async def test_professional_synthesis_preserves_partial_points_after_other_part_fails():
    from hushh_mcp.services.professional_profile_synthesis import (
        ProfessionalProfileRequest,
        synthesize_professional_profile,
    )

    calls = []

    async def generate(contents, request_id):
        prompt = contents[-1].parts[0].text
        calls.append(prompt)
        low, high = map(int, re.search(r"ONLY points #(\d{3}) through #(\d{3})", prompt).groups())
        if low > 180:
            raise TimeoutError("private-provider-details")
        text = "\n".join(
            f"#{n:03} [UNVERIFIED-USER-INPUT] Unverified supplied context."
            for n in range(low, high + 1)
        )
        return SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(parts=[SimpleNamespace(text=text, thought=False)]),
                    finish_reason="STOP",
                    grounding_metadata=None,
                )
            ]
        )

    report = await synthesize_professional_profile(
        ProfessionalProfileRequest(**_professional_profile_input()),
        generate=generate,
        model="fixture-model",
    )
    assert report.status == "partial"
    assert report.point_count == 180
    assert report.missing_points == list(range(181, 361))
    assert report.sources == []
    assert report.failures[0].reason == "deadline_exceeded"
    assert report.failures[0].outcome_unknown is True
    assert len(calls) == 2  # failed/uncertain page requests are never automatically replayed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tag,finish,reason",
    [
        ("PUBLIC-RECORD-VERIFIED", "STOP", "unsupported_verification_claim"),
        ("ECOSYSTEM-CONTEXT", "MAX_TOKENS", "incomplete_output"),
        ("ECOSYSTEM-CONTEXT", "STOP", None),
    ],
)
async def test_professional_synthesis_completion_requires_finished_output_and_honest_receipts(
    tag, finish, reason
):
    from hushh_mcp.services.professional_profile_synthesis import (
        ProfessionalProfileRequest,
        synthesize_professional_profile,
    )

    async def generate(contents, request_id):
        low, high = map(
            int,
            re.search(r"ONLY points #(\d{3}) through #(\d{3})", contents[0].parts[0].text).groups(),
        )
        text = "\n".join(f"#{n:03} [{tag}] Model-authored paragraph." for n in range(low, high + 1))
        return SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(parts=[SimpleNamespace(text=text, thought=False)]),
                    finish_reason=finish,
                    grounding_metadata=None,
                )
            ]
        )

    report = await synthesize_professional_profile(
        ProfessionalProfileRequest(**_professional_profile_input()),
        generate=generate,
        model="fixture-model",
    )
    assert report.point_count == 360
    assert report.missing_points == []
    assert report.status == ("partial" if reason else "complete")
    assert {x.reason for x in report.failures} == ({reason} if reason else set())
    assert all(point.evidence_tag == tag for point in report.points)


@pytest.mark.asyncio
async def test_professional_synthesis_empty_point_stubs_are_not_a_report():
    from hushh_mcp.services.professional_profile_synthesis import (
        ProfessionalProfileRequest,
        SynthesisUnavailable,
        synthesize_professional_profile,
    )

    async def generate(contents, request_id):
        low, high = map(
            int,
            re.search(r"ONLY points #(\d{3}) through #(\d{3})", contents[0].parts[0].text).groups(),
        )
        text = "\n".join(f"#{n:03} [ECOSYSTEM-CONTEXT]" for n in range(low, high + 1))
        return SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(parts=[SimpleNamespace(text=text, thought=False)]),
                    finish_reason="STOP",
                    grounding_metadata=None,
                )
            ]
        )

    with pytest.raises(SynthesisUnavailable):
        await synthesize_professional_profile(
            ProfessionalProfileRequest(**_professional_profile_input()),
            generate=generate,
            model="fixture-model",
        )


@pytest.mark.asyncio
async def test_professional_synthesis_pins_supported_region_closes_clients_and_bounds_concurrency(
    monkeypatch,
):
    from hushh_mcp.runtime_providers import ManagedGeminiRuntimeBinding
    from hushh_mcp.services.professional_profile_synthesis import (
        ProfessionalProfileRequest,
        _safe_url,
        synthesize_professional_profile,
    )

    settings = {"in_flight": 0, "max_in_flight": 0, "closed_async": False, "closed_sync": False}

    async def generate(**kwargs):
        assert kwargs["config"].automatic_function_calling.disable is True
        settings["in_flight"] += 1
        settings["max_in_flight"] = max(settings["max_in_flight"], settings["in_flight"])
        await asyncio.sleep(0)
        low, high = map(
            int,
            re.search(
                r"ONLY points #(\d{3}) through #(\d{3})", kwargs["contents"][0].parts[0].text
            ).groups(),
        )
        text = "\n".join(
            f"#{n:03} [ECOSYSTEM-CONTEXT] Generic professional context."
            for n in range(low, high + 1)
        )
        settings["in_flight"] -= 1
        return SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(parts=[SimpleNamespace(text=text, thought=False)]),
                    finish_reason="STOP",
                    grounding_metadata=None,
                )
            ]
        )

    async def close_async():
        settings["closed_async"] = True

    def close_sync():
        settings["closed_sync"] = True

    client = SimpleNamespace(
        aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate), aclose=close_async),
        close=close_sync,
    )

    def build_client(**kwargs):
        assert kwargs["location"] == "global"
        assert kwargs["http_options"].retry_options.attempts == 1
        assert kwargs["http_options"].timeout == 600_000
        assert isinstance(
            kwargs["http_options"].async_client_args["transport"], httpx.AsyncHTTPTransport
        )
        return client

    binding = SimpleNamespace(
        auth_mode="vertex_adc",
        locations_for_model=lambda model: ("global", "us-central1"),
        build_direct_client=build_client,
    )
    monkeypatch.setattr(ManagedGeminiRuntimeBinding, "from_environment", lambda **kwargs: binding)
    report = await synthesize_professional_profile(
        ProfessionalProfileRequest(**_professional_profile_input()), model="fixture-model"
    )
    assert report.status == "complete"
    assert settings == {
        "in_flight": 0,
        "max_in_flight": 2,
        "closed_async": True,
        "closed_sync": True,
    }
    assert _safe_url("https://:fixture-password@example.org/source") is None
    assert _safe_url("https://example.org/source") == "https://example.org/source"


def test_professional_synthesis_revoked_credentials_cannot_release_generated_report(monkeypatch):
    from fastapi import HTTPException

    from api.routes import professional_profile as route
    from hushh_mcp.services.professional_profile_synthesis import ProfessionalProfileReport

    checks = []

    def authenticate(**kwargs):
        checks.append(True)
        if len(checks) > 1:
            raise HTTPException(status_code=401, detail="Developer token revoked")
        return _fake_principal()

    async def generate(body):
        return ProfessionalProfileReport(
            request_id="fixture-request",
            status="partial",
            model="fixture-model",
            point_count=0,
            missing_points=list(range(1, 361)),
            points=[],
            report_markdown="private-generated-report",
            sources=[],
            search_suggestions_html=[],
            failures=[],
        )

    monkeypatch.setattr(route, "authenticate_developer_principal", authenticate)
    monkeypatch.setattr(route, "synthesize_professional_profile", generate)
    response = TestClient(_build_app()).post(
        "/api/v1/professional-profile/synthesize", json=_professional_profile_input()
    )
    assert response.status_code == 401
    assert len(checks) == 2
    assert "private-generated-report" not in response.text
    assert response.headers["cache-control"] == "private, no-store"
