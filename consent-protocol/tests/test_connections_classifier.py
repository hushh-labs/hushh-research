import inspect


def test_connections_require_a_semantic_one_selection() -> None:
    from google.adk.tools.function_tool import FunctionTool

    from hushh_mcp.one_adk import agent_tree

    source = inspect.getsource(agent_tree.ask_consent_agent)
    assert 'Literal["consent", "connections"]' in source
    assert "request words" in source
    assert "agent_connections" in source

    declaration = FunctionTool(agent_tree.ask_consent_agent)._get_declaration()
    schema = declaration.parameters_json_schema
    assert schema is not None
    assert schema["properties"]["target"]["enum"] == ["consent", "connections"]
    assert "tool_context" not in schema["properties"]
