from api.routes.sse import _sse_payload_from_event_payload


def test_sse_payload_includes_enriched_request_fields():
    payload = _sse_payload_from_event_payload(
        {
            "request_id": "req_123",
            "action": "REQUESTED",
            "scope": "attr.financial.*",
            "agent_id": "developer:demo",
            "scope_description": "Financial Data",
            "issued_at": 1234567890,
            "metadata": {
                "requester_label": "Codex Local Workspace",
                "requester_image_url": "https://example.com/logo.png",
                "requester_website_url": "https://example.com",
                "reason": "Portfolio insights",
                "expiry_hours": 24,
                "approval_timeout_minutes": 5,
                "approval_timeout_at": 1234569999,
            },
        }
    )

    assert payload["request_id"] == "req_123"
    assert payload["request_url"].endswith(
        "/profile?tab=privacy&sheet=consents&consentView=pending&requestId=req_123"
    )
    assert payload["deep_link"] == (
        "/profile?tab=privacy&sheet=consents&consentView=pending&requestId=req_123"
    )
    assert payload["requester_label"] == "Codex Local Workspace"
    assert payload["requester_image_url"] == "https://example.com/logo.png"
    assert payload["requester_website_url"] == "https://example.com"
    assert payload["reason"] == "Portfolio insights"
    assert payload["expiry_hours"] == 24
    assert payload["approval_timeout_minutes"] == 5
    assert payload["approval_timeout_at"] == 1234569999
