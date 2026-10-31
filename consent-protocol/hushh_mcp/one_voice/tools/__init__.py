"""Typed tools: the only path by which One Live Voice reads or changes state.

Every tool binds to a generated action-gateway id, declares pydantic Input and
Output models, and returns a :class:`ToolResult` whose ``status`` vocabulary is
the only thing the model may narrate as fact. See ``base.py`` for the contract
and ``registry.py`` for the assembled catalog.
"""
