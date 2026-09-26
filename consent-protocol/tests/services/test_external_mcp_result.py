from mcp.types import CallToolResult, TextContent

from hushh_mcp.services.external_mcp_client import _normalize_and_cap


def test_structured_mcp_output_without_text_is_not_lost():
    result = _normalize_and_cap(
        CallToolResult(content=[], structuredContent={"events": [{"id": "synthetic"}]})
    )
    assert result.payload == {"events": [{"id": "synthetic"}]}
    assert not result.truncated


def test_structured_output_takes_precedence_and_is_still_bounded():
    result = _normalize_and_cap(
        CallToolResult(
            content=[TextContent(type="text", text='{"unsafe_fallback": true}')],
            structuredContent={"large": "x" * 40000},
            isError=True,
        )
    )
    assert result.is_error and result.truncated
    assert len(str(result.payload)) < 32000
    assert "unsafe_fallback" not in result.payload
