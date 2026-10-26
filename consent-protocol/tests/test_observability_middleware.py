import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.middlewares import observability
from api.middlewares.observability import (
    AUTH_RELIABILITY_FLAGS,
    FEATURE_FLAGS_HEADER,
    REQUEST_ID_HEADER,
    TRACE_ID_HEADER,
    _status_bucket,
    capture_request_trace_events,
    get_request_id,
    get_request_trace_events,
    get_request_trace_metadata,
    observability_middleware,
    request_feature_enabled,
    request_feature_overrides,
    request_trace_span,
)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.middleware("http")(observability_middleware)

    @app.get("/ok")
    async def ok_route():
        return {"ok": True}

    @app.get("/metadata")
    async def metadata_route():
        metadata = get_request_trace_metadata()
        return {
            "request_id": get_request_id(),
            "trace_id": metadata.trace_id if metadata else None,
            "method": metadata.method if metadata else None,
            "route_template": metadata.route_template if metadata else None,
        }

    @app.get("/boom")
    async def boom_route():
        raise RuntimeError("boom")

    @app.get("/flags")
    async def flags_route():
        before = request_feature_enabled("AUTH_PHONE_RECOVERY_ENABLED")
        await asyncio.sleep(0)
        return {
            "enabled": before,
            "after_yield": request_feature_enabled("AUTH_PHONE_RECOVERY_ENABLED"),
        }

    @app.get("/trace-loop")
    async def trace_route():
        with request_trace_span("receive"):
            with request_trace_span("provider"):
                pass
            with request_trace_span("persist"):
                pass
        return {"ok": True}

    @app.get("/trace-failure")
    async def trace_failure_route():
        with request_trace_span("provider"):
            raise RuntimeError("private-provider-message-do-not-record")

    @app.get("/api/account/phone/stages")
    async def phone_stages_route(fail: bool = False):
        with request_trace_span("provider"):
            if fail:
                raise RuntimeError("private-provider-message-do-not-record")
        with request_trace_span("persist"):
            pass
        return {"ok": True}

    return app


def test_request_id_generated_when_missing():
    client = TestClient(_build_app())

    response = client.get("/ok")

    assert response.status_code == 200
    request_id = response.headers.get(REQUEST_ID_HEADER)
    assert isinstance(request_id, str)
    assert len(request_id) >= 8


def test_request_id_preserved_when_provided():
    client = TestClient(_build_app())

    response = client.get("/ok", headers={REQUEST_ID_HEADER: "req_test_12345678"})

    assert response.status_code == 200
    assert response.headers.get(REQUEST_ID_HEADER) == "req_test_12345678"
    assert response.headers.get(TRACE_ID_HEADER) == "req_test_12345678"


def test_trace_metadata_reused_inside_request_flow():
    client = TestClient(_build_app())

    response = client.get(
        "/metadata",
        headers={
            REQUEST_ID_HEADER: "req_test_12345678",
            TRACE_ID_HEADER: "trace_test_12345678",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(REQUEST_ID_HEADER) == "req_test_12345678"
    assert response.headers.get(TRACE_ID_HEADER) == "trace_test_12345678"
    assert response.json() == {
        "request_id": "req_test_12345678",
        "trace_id": "trace_test_12345678",
        "method": "GET",
        "route_template": "/metadata",
    }
    assert get_request_trace_metadata() is None


def test_unknown_private_locator_never_becomes_a_route_template(caplog):
    import logging

    locator = "11111111-1111-4111-8111-111111111111-private-token"
    with caplog.at_level(logging.INFO):
        response = TestClient(_build_app()).get(f"/missing/{locator}?secret=private-query")
    assert response.status_code == 404
    summaries = [item.message for item in caplog.records if "request.summary" in item.message]
    assert summaries and '"route_template":"<unmatched>"' in summaries[-1]
    assert locator not in "".join(summaries)
    assert "private-query" not in "".join(summaries)


def test_audit_and_request_metadata_share_the_resolved_trace():
    from hushh_mcp.consent.audit_logger import get_trace_id

    app = _build_app()

    @app.get("/audit-correlation")
    async def correlation():
        return {"audit": get_trace_id(), "metadata": get_request_trace_metadata().trace_id}

    response = TestClient(app).get(
        "/audit-correlation",
        headers={REQUEST_ID_HEADER: "request-id-123", TRACE_ID_HEADER: "trace-id-456"},
    )
    assert response.json() == {"audit": "trace-id-456", "metadata": "trace-id-456"}


def test_traceparent_header_reuses_distributed_trace_id():
    client = TestClient(_build_app())
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

    response = client.get(
        "/metadata",
        headers={
            REQUEST_ID_HEADER: "req_test_abcdefgh",
            "traceparent": f"00-{trace_id}-00f067aa0ba902b7-01",
        },
    )

    assert response.status_code == 200
    assert response.headers.get(TRACE_ID_HEADER) == trace_id
    assert response.json()["trace_id"] == trace_id


def test_unhandled_exception_returns_request_id_header():
    client = TestClient(_build_app(), raise_server_exceptions=False)

    response = client.get("/boom")

    assert response.status_code == 500
    assert response.headers.get(REQUEST_ID_HEADER)
    assert response.headers.get(TRACE_ID_HEADER)


def test_expected_status_bucket_classification():
    assert _status_bucket("POST", "/api/kai/analyze/run/start", 409) == "4xx_expected"
    assert _status_bucket("GET", "/api/kai/analyze/run/active", 404) == "4xx_expected"
    assert _status_bucket("GET", "/api/kai/analyze/run/active", 401) == "4xx_unexpected"
    assert _status_bucket("GET", "/health", 200) == "2xx"


def test_unhandled_exception_response_body_does_not_leak_runtime_detail():
    client = TestClient(_build_app(), raise_server_exceptions=False)

    response = client.get("/boom")

    body = response.json()
    assert "boom" not in body.get("detail", "").lower()


def test_malformed_request_id_header_is_replaced_with_fresh_id():
    client = TestClient(_build_app())

    response = client.get("/ok", headers={REQUEST_ID_HEADER: "bad id!!!"})

    returned_id = response.headers.get(REQUEST_ID_HEADER)
    assert returned_id is not None
    assert returned_id != "bad id!!!"
    assert len(returned_id) >= 8


@pytest.mark.parametrize(
    "method,route,status,expected_bucket",
    [
        ("GET", "/anything", 200, "2xx"),
        ("POST", "/anything", 201, "2xx"),
        ("GET", "/anything", 301, "3xx"),
        ("GET", "/anything", 302, "3xx"),
        ("GET", "/anything", 400, "4xx_unexpected"),
        ("GET", "/anything", 422, "4xx_unexpected"),
        ("GET", "/anything", 500, "5xx"),
        ("GET", "/anything", 503, "5xx"),
        ("GET", "/api/pkm/metadata/{user_id}", 401, "4xx_expected"),
        ("GET", "/api/pkm/metadata/{user_id}", 404, "4xx_expected"),
        ("GET", "/api/kai/market/insights/{user_id}", 401, "4xx_expected"),
        ("POST", "/db/vault/get", 404, "4xx_expected"),
        ("POST", "/db/vault/bootstrap-state", 404, "4xx_expected"),
        ("POST", "/api/kai/analyze/run/start", 409, "4xx_expected"),
    ],
)
def test_status_bucket_parametrized(method, route, status, expected_bucket):
    assert _status_bucket(method, route, status) == expected_bucket


@pytest.fixture
def local_diagnostics(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("OTEL_ENABLED", "false")
    for name in (
        *AUTH_RELIABILITY_FLAGS,
        *observability._HOSTED_RUNTIME_MARKERS,
        "HUSHH_DEPLOY_ENV",
        "APP_RUNTIME_PROFILE",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("header", [FEATURE_FLAGS_HEADER, "baggage"])
@pytest.mark.parametrize("enabled", [False, True])
def test_phone_reliability_request_override_is_scoped(local_diagnostics, header, enabled):
    client = TestClient(_build_app())
    response = client.get(
        "/flags", headers={header: f"AUTH_PHONE_RECOVERY_ENABLED={str(enabled).lower()}"}
    )
    assert response.json() == {"enabled": enabled, "after_yield": enabled}
    assert client.get("/flags").json() == {"enabled": False, "after_yield": False}


@pytest.mark.parametrize(
    "value",
    [
        "AUTH_PHONE_RECOVERY_ENABLED=yes",
        "AUTH_PHONE_RECOVERY_ENABLED=TRUE",
        "AUTH_PHONE_RECOVERY_ENABLED=1",
        "UNKNOWN_FLAG=true",
        "AUTH_PHONE_RECOVERY_ENABLED=true,AUTH_PHONE_RECOVERY_ENABLED=false",
    ],
)
def test_invalid_reliability_overrides_fail_closed(local_diagnostics, value):
    response = TestClient(_build_app()).get("/flags", headers={FEATURE_FLAGS_HEADER: value})
    assert response.json()["enabled"] is False


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize(
    "deployment,value",
    [
        ("ENVIRONMENT", "production"),
        ("ENVIRONMENT", "uat"),
        ("HUSHH_DEPLOY_ENV", "uat"),
        ("K_SERVICE", "hosted-test"),
        ("CONTAINER_APP_NAME", "hosted-test"),
        ("APP_RUNTIME_PROFILE", "production"),
    ],
)
def test_hosted_runtime_rejects_header_and_context_overrides(
    local_diagnostics, monkeypatch, deployment, value
):
    monkeypatch.setenv(deployment, value)
    client = TestClient(_build_app())
    for header in (FEATURE_FLAGS_HEADER, "baggage"):
        assert (
            client.get("/flags", headers={header: "AUTH_PHONE_RECOVERY_ENABLED=true"}).json()[
                "enabled"
            ]
            is False
        )
    with pytest.raises(PermissionError):
        with request_feature_overrides({"AUTH_PHONE_RECOVERY_ENABLED": True}):
            pass
    with pytest.raises(PermissionError):
        with capture_request_trace_events():
            pass


def test_feature_context_and_environment_values_are_strict(local_diagnostics, monkeypatch):
    name = "AUTH_PHONE_RECOVERY_ENABLED"
    monkeypatch.setenv(name, "true")
    with request_feature_overrides({name: False}):
        assert request_feature_enabled(name) is False
        with request_feature_overrides({name: True}):
            assert request_feature_enabled(name) is True
        assert request_feature_enabled(name) is False
    assert request_feature_enabled(name) is True
    monkeypatch.setenv(name, "yes")
    assert request_feature_enabled(name, default=True) is False
    with pytest.raises(ValueError):
        with request_feature_overrides({name: "false"}):
            pass
    with pytest.raises(ValueError):
        request_feature_enabled("DISABLE_AUTHENTICATION")


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
async def test_concurrent_phone_flag_overrides_do_not_cross_requests(local_diagnostics):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_build_app()), base_url="http://test"
    ) as client:
        on, off = await asyncio.gather(
            client.get(
                "/flags", headers={FEATURE_FLAGS_HEADER: "AUTH_PHONE_RECOVERY_ENABLED=true"}
            ),
            client.get(
                "/flags", headers={FEATURE_FLAGS_HEADER: "AUTH_PHONE_RECOVERY_ENABLED=false"}
            ),
        )
    assert on.json() == {"enabled": True, "after_yield": True}
    assert off.json() == {"enabled": False, "after_yield": False}
    assert request_feature_enabled("AUTH_PHONE_RECOVERY_ENABLED") is False


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("cancelled", [False, True])
async def test_request_flag_snapshot_and_context_cleanup_on_failure(
    local_diagnostics, monkeypatch, cancelled
):
    name = "AUTH_PHONE_RECOVERY_ENABLED"
    monkeypatch.setenv(name, "true")

    async def cancel_request(request):
        assert request_feature_enabled(name) is True
        monkeypatch.setenv(name, "false")
        assert request_feature_enabled(name) is True
        if cancelled:
            raise asyncio.CancelledError()
        raise RuntimeError("private-provider-message-do-not-record")

    request = Request(
        {"type": "http", "method": "GET", "path": "/api/account/phone/cancel", "headers": []}
    )
    if cancelled:
        with pytest.raises(asyncio.CancelledError):
            await observability_middleware(request, cancel_request)
    else:
        assert (await observability_middleware(request, cancel_request)).status_code == 500
    assert get_request_trace_metadata() is None
    assert request_feature_enabled(name) is False


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
def test_trace_off_does_not_start_spans_or_retain_events(local_diagnostics, monkeypatch):
    from opentelemetry import trace

    def unexpected_tracer(*args, **kwargs):
        raise AssertionError("Tracing is off")

    monkeypatch.setattr(trace, "get_tracer", unexpected_tracer)
    assert TestClient(_build_app()).get("/trace-loop").status_code == 200
    assert get_request_trace_events() == ()


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
def test_phone_trace_capture_is_bounded_correlated_and_payload_free(local_diagnostics, caplog):
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    client = TestClient(_build_app())
    with capture_request_trace_events(max_events=3) as events:
        response = client.get(
            "/trace-loop", headers={"traceparent": f"00-{trace_id}-00f067aa0ba902b7-01"}
        )
        assert response.headers[TRACE_ID_HEADER] == trace_id
        assert [event["name"] for event in events] == [
            "auth.phone.receive",
            "auth.phone.provider",
            "auth.phone.persist",
        ]
        assert {event["trace_id"] for event in events} == {trace_id}
        assert {event["request_id"] for event in events} == {response.headers[REQUEST_ID_HEADER]}
        assert events[1]["parent_span_id"] == events[0]["span_id"]
        assert all(event["duration_ms"] >= 0 for event in events)
        assert events[0]["feature_flags"] == {name: False for name in AUTH_RELIABILITY_FLAGS}
        snapshot = get_request_trace_events()
        snapshot[0]["feature_flags"]["AUTH_PHONE_RECOVERY_ENABLED"] = True
        assert events[0]["feature_flags"]["AUTH_PHONE_RECOVERY_ENABLED"] is False
        failed = client.get("/trace-failure")
        assert failed.status_code == 500
        assert len(events) == 3
        assert events[-1]["status"] == "error"
        assert set(events[-1]) == {
            "name",
            "trace_id",
            "request_id",
            "span_id",
            "parent_span_id",
            "status",
            "duration_ms",
            "feature_flags",
        }
        assert "private-provider-message-do-not-record" not in str(events)
    assert get_request_trace_events() == ()
    assert "private-provider-message-do-not-record" not in caplog.text


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("failed", [False, True])
def test_phone_http_receive_and_response_bound_internal_stages(local_diagnostics, failed):
    with capture_request_trace_events() as events:
        response = TestClient(_build_app()).get(
            "/api/account/phone/stages",
            params={"fail": str(failed).lower()},
            headers={FEATURE_FLAGS_HEADER: "AUTH_PHONE_RECOVERY_ENABLED=true"},
        )
    assert response.status_code == (500 if failed else 200)
    stages = (
        ["receive", "provider", "response"]
        if failed
        else ["receive", "provider", "persist", "response"]
    )
    assert [event["name"] for event in events] == [f"auth.phone.{stage}" for stage in stages]
    assert {event["request_id"] for event in events} == {response.headers[REQUEST_ID_HEADER]}
    assert all(event["feature_flags"]["AUTH_PHONE_RECOVERY_ENABLED"] is True for event in events)
    assert events[1]["parent_span_id"] == events[0]["span_id"]
    assert events[0]["status"] == ("error" if failed else "ok")
    assert events[-1]["status"] == "ok"


@pytest.mark.parametrize(
    "traceparent",
    [
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
    ],
)
def test_invalid_traceparent_does_not_claim_distributed_correlation(traceparent):
    response = TestClient(_build_app()).get(
        "/metadata", headers={REQUEST_ID_HEADER: "req_fallback_123456", "traceparent": traceparent}
    )
    assert response.json()["trace_id"] == "req_fallback_123456"
