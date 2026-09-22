"""Authored factory declarations must construct the runtime they advertise."""

from importlib import import_module
from inspect import isawaitable, signature
from pathlib import Path
from types import SimpleNamespace

import pytest
from google.adk.agents import LlmAgent

from hushh_mcp.hushh_adk.manifest import ManifestLoader

MANIFESTS = Path(__file__).resolve().parents[1] / "hushh_mcp" / "agents"


def _declarations():
    for path in sorted(MANIFESTS.glob("*/agent.yaml")):
        manifest = ManifestLoader.load(str(path))
        for declaration in (manifest, *manifest.subagents):
            if declaration.runtime.factory:
                yield pytest.param(declaration, id=declaration.id)


@pytest.mark.asyncio
@pytest.mark.parametrize("declaration", list(_declarations()))
async def test_factory_builds_declared_runtime_with_authored_instruction(declaration, monkeypatch):
    monkeypatch.setenv("TESTING", "true")
    module, name = declaration.runtime.factory.rsplit(".", 1)
    factory = getattr(import_module(module), name)
    assert callable(factory)
    parameters = signature(factory).parameters
    kwargs = {"model": "gemini-3.7-flash"} if "model" in parameters else {}
    if declaration.id == "agent_connections":
        from hushh_mcp.services.connections_chat_service import ConnectionsChatService

        service = ConnectionsChatService(service=SimpleNamespace(), chat_store=SimpleNamespace())
        kwargs["tools"] = service.build_read_proposal_tools("factory_fixture")
    runtime = factory(**kwargs)
    if declaration.runtime.kind == "deterministic":
        assert callable(runtime)
        return
    assert isinstance(runtime, LlmAgent)
    instruction = runtime.instruction
    if callable(instruction):
        instruction = instruction(SimpleNamespace(state={}))
    if isawaitable(instruction):
        instruction = await instruction
    assert instruction.startswith(declaration.system_instruction.strip())
