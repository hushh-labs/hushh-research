"""Azure web receipts must come from completed tool calls and provider citations."""

import copy

import pytest

from hushh_mcp.one_adk.azure_web_receipts import extract_azure_web_receipts


def response() -> dict:
    text = "Public team page confirms the owner [1]."
    return {
        "status": "completed",
        "tool_usage": {"web_search": {"num_requests": 2}},
        "output": [
            {"type": "reasoning", "summary": []},
            {
                "type": "web_search_call",
                "status": "completed",
                "action": {
                    "type": "search",
                    "sources": [{"url": "https://uncited.example.test/"}],
                },
            },
            {
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": text,
                        "annotations": [
                            {
                                "type": "url_citation",
                                "title": "Public team page",
                                "url": "https://example.test/team/owner",
                                "start_index": 36,
                                "end_index": 39,
                            },
                        ],
                    }
                ],
            },
        ],
    }


def test_completed_search_accepts_only_valid_url_citations_and_provider_billing_count():
    receipts = extract_azure_web_receipts(response())

    assert receipts.observed is True
    assert receipts.num_requests == 2  # One visible call can bill multiple Bing requests.
    assert receipts.answer == "Public team page confirms the owner [1]."
    assert [(source.title, source.url) for source in receipts.sources] == [
        ("Public team page", "https://example.test/team/owner")
    ]
    assert receipts.citations == (
        {
            "start_index": 36,
            "end_index": 39,
            "title": "Public team page",
            "url": "https://example.test/team/owner",
        },
    )


def test_citations_keep_provider_title_and_offsets_across_content_parts():
    raw = response()
    raw["output"][2]["content"][0]["annotations"] = [
        {**raw["output"][2]["content"][0]["annotations"][0], "title": "  Public team page  "}
    ]
    raw["output"][2]["content"].append(
        {
            "type": "output_text",
            "text": "More [2].",
            "annotations": [
                {
                    "type": "url_citation",
                    "title": "Second source",
                    "url": "https://example.test/second",
                    "start_index": 5,
                    "end_index": 8,
                }
            ],
        }
    )
    receipts = extract_azure_web_receipts(raw)
    assert receipts.observed is True
    assert receipts.sources[0].title == "  Public team page  "
    assert receipts.answer == "Public team page confirms the owner [1].\nMore [2]."
    assert receipts.citations[0]["title"] == "  Public team page  "
    assert (
        receipts.citations[1]["start_index"]
        == len("Public team page confirms the owner [1].\n") + 5
    )


def test_overlapping_citations_fail_closed():
    raw = response()
    raw["output"][2]["content"][0]["annotations"] = [
        raw["output"][2]["content"][0]["annotations"][0],
        {
            "type": "url_citation",
            "title": "Other",
            "url": "https://example.test/other",
            "start_index": 37,
            "end_index": 39,
        },
    ]
    receipts = extract_azure_web_receipts(raw)
    assert receipts.observed is False
    assert receipts.answer == ""
    assert receipts.citations == ()


def test_insecure_reference_fails_closed_instead_of_omitting_attribution():
    raw = response()
    raw["output"][2]["content"][0]["annotations"].append(
        {
            "type": "url_citation",
            "title": "Insecure source",
            "url": "http://example.test/owner",
            "start_index": 36,
            "end_index": 39,
        }
    )
    receipts = extract_azure_web_receipts(raw)
    assert receipts.observed is False
    assert receipts.citations == ()


@pytest.mark.parametrize(
    "defect",
    ["no_call", "failed_call", "unknown_action", "invalid_action", "no_citation", "bad_range"],
)
def test_unattributed_or_unobserved_response_cannot_become_evidence(defect):
    raw = response()
    if defect == "no_call":
        raw["output"].pop(1)
    elif defect == "failed_call":
        raw["output"][1]["status"] = "failed"
    elif defect == "unknown_action":
        raw["output"][1]["action"] = {"type": "download"}
    elif defect == "invalid_action":
        raw["output"][1]["action"] = {"type": []}
    elif defect == "no_citation":
        raw["output"][2]["content"][0]["annotations"] = []
    else:
        raw["output"][2]["content"][0]["annotations"][0]["start_index"] = 9000

    receipts = extract_azure_web_receipts(raw)
    assert receipts.observed is False
    assert receipts.answer == ""
    assert receipts.sources == ()
    assert receipts.num_requests == 2


@pytest.mark.parametrize("count", [None, 0, True, -1, 101])
def test_completed_search_rejects_missing_or_invalid_billing_count(count):
    raw = copy.deepcopy(response())
    if count is None:
        del raw["tool_usage"]
    else:
        raw["tool_usage"]["web_search"]["num_requests"] = count
    with pytest.raises(ValueError, match="request count"):
        extract_azure_web_receipts(raw)


@pytest.mark.parametrize("action", ["open_page", "find_in_page"])
@pytest.mark.parametrize("count", [0, 2])
@pytest.mark.parametrize("empty_title", [False, True])
def test_completed_page_retrieval_accepts_explicit_zero_bing_queries(action, count, empty_title):
    raw = response()
    raw["output"][1]["action"] = {"type": action, "url": "https://example.test/team/owner"}
    raw["tool_usage"]["web_search"]["num_requests"] = count
    if empty_title:
        raw["output"][2]["content"][0]["annotations"][0]["title"] = ""
    receipts = extract_azure_web_receipts(raw)
    assert receipts.observed is True
    assert receipts.num_requests == count
    assert len(receipts.sources) == 1
    if empty_title:
        assert receipts.citations[0]["title"] == ""
        assert receipts.sources[0].title == "Public page"


@pytest.mark.parametrize("action", ["open_page", "find_in_page", "search", "unknown"])
def test_page_retrieval_still_requires_explicit_billing_and_search_cannot_claim_zero(action):
    raw = response()
    raw["output"][1]["action"] = {"type": action}
    del raw["tool_usage"]
    with pytest.raises(ValueError, match="request count"):
        extract_azure_web_receipts(raw)
    raw["tool_usage"] = {"web_search": {"num_requests": 0}}
    raw["output"].insert(
        1, {"type": "web_search_call", "status": "completed", "action": {"type": "search"}}
    )
    with pytest.raises(ValueError, match="request count"):
        extract_azure_web_receipts(raw)


def test_answer_and_citation_bounds_stop_oversized_provider_payloads():
    raw = response()
    raw["output"][2]["content"][0]["text"] = "x" * 100_001
    with pytest.raises(ValueError, match="answer exceeds"):
        extract_azure_web_receipts(raw)

    raw = response()
    raw["output"][2]["content"][0]["annotations"] *= 201
    with pytest.raises(ValueError, match="citations exceeds"):
        extract_azure_web_receipts(raw)
