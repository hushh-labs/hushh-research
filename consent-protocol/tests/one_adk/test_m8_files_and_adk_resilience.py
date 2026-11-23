# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Milestone 8 regression tests for Files<->Chat bridge, ADK resilience, and ace parity."""

from __future__ import annotations

import asyncio
import io
from contextlib import asynccontextmanager, nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import openpyxl
import pytest
from ag_ui.core import (
    EventType,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from fastapi import FastAPI
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from google.genai import types as genai_types
from httpx import ASGITransport, AsyncClient

from hushh_mcp.one_adk import (
    agent_tree,
    external_read_boundary,
    files_tools,
    pod_agui_lifetime,
    pod_chat_stream,
)
from hushh_mcp.one_adk.agui_turn_timing import TimedADKAgent
from hushh_mcp.one_adk.files_agent import build_files_agent
from hushh_mcp.one_adk.tool_scoping import (
    ALL_SCOPED_LEAF_TOOLS,
    CAPABILITY_PACKS_BY_ID,
    POD_FILES_ALWAYS_ON_TOOLS,
    scope_leaf_tools_before_model,
)
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.services.pod_files.library import FilesLibrary
from hushh_mcp.services.pod_files.storage import FilesLocalStore
from hushh_mcp.services.pod_s3_object_store import PodMultiCloudStorageError
from tests.helpers.agui_lifetime import USER_ID, _input, _owner_input


def _make_pdf_bytes(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
    objs = [
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        (
            b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n"
        ),
        f"4 0 obj << /Length {len(stream)} >>\nstream\n".encode("ascii")
        + stream
        + b"\nendstream endobj\n",
        b"5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for obj in objs:
        offsets.append(len(out))
        out.extend(obj)
    xref = len(out)
    out.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    out.extend(
        f"trailer << /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode(
            "ascii"
        )
    )
    return bytes(out)


def _make_xlsx_bytes(rows: list[list[object]]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "Recovery"
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


@pytest.fixture
def files_lib(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FilesLibrary:
    async def allowed(*_args, **_kwargs) -> None:
        return None

    lib = FilesLibrary(
        owner="owner-m8",
        key=b"M" * 32,
        store=FilesLocalStore(str(tmp_path / "files")),
        check=allowed,
    )

    @asynccontextmanager
    async def fake_operation(**_kwargs):
        yield lib

    monkeypatch.setattr(files_tools, "operation", fake_operation)
    monkeypatch.setattr(files_tools, "require_files_access", allowed)
    return lib


async def _upload(
    lib: FilesLibrary,
    name: str,
    data: bytes,
    *,
    parent: str = "root",
    request_id: str,
) -> dict:
    entry = await lib.create(name=name, parent=parent, size=len(data), request_id=request_id)
    chunk_size = 4 * 1024 * 1024
    if data:
        for idx, offset in enumerate(range(0, len(data), chunk_size)):
            await lib.put_chunk(entry["id"], idx, data[offset : offset + chunk_size])
    return await lib.complete(entry["id"])


# ---------------------------------------------------------------------------
# 1. Files <-> Chat Bridge, Routing, Discovery, Multi-Format Read, Safe Write
# ---------------------------------------------------------------------------


def test_one_routing_distinguishes_private_files_from_drive_and_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)
    monkeypatch.setenv("POD_FILES_ENABLED", "true")
    instr = agent_tree._one_runtime_instruction(SimpleNamespace(state={}))
    assert "PRIVATE FILES LIBRARY (/one/files)" in instr
    assert "`files`" in instr
    assert "ask_documents_agent" in instr
    assert "/workspace" in instr

    # Negative control: non-pod mode adds no pod files hint.
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: False)
    non_pod = agent_tree._one_runtime_instruction(SimpleNamespace(state={}))
    assert "PRIVATE FILES LIBRARY (/one/files)" not in non_pod


def test_tool_scoping_keeps_files_always_on_and_avoids_drive_pack_for_private_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_ONE_TOOL_SCOPING_ENABLED", "1")
    assert POD_FILES_ALWAYS_ON_TOOLS.isdisjoint(ALL_SCOPED_LEAF_TOOLS)

    class _StubTool(BaseTool):
        def __init__(self, tool_name: str) -> None:
            super().__init__(name=tool_name, description=tool_name)

    padding = [f"core_{i}" for i in range(25)]
    names = [*padding, "files", "propose_file_schedule", *sorted(ALL_SCOPED_LEAF_TOOLS)]

    def run_scope(prompt: str) -> set[str]:
        req = LlmRequest(
            model="gemini-4-hydrogen",
            contents=[
                genai_types.Content(role="user", parts=[genai_types.Part.from_text(text=prompt)])
            ],
            config=genai_types.GenerateContentConfig(
                tools=[
                    genai_types.Tool(
                        function_declarations=[
                            genai_types.FunctionDeclaration(name=n, description=n) for n in names
                        ]
                    )
                ]
            ),
            tools_dict={n: _StubTool(n) for n in names},
        )
        scope_leaf_tools_before_model(SimpleNamespace(state={}), req)
        return {d.name for d in req.config.tools[0].function_declarations}

    private_kept = run_scope("find my hushh recovery key in /one/files")
    assert "files" in private_kept
    assert "propose_file_schedule" in private_kept
    assert CAPABILITY_PACKS_BY_ID["drive_files"].isdisjoint(private_kept)

    # Positive control: Drive queries still unlock drive_files.
    drive_kept = run_scope("ask Kushal for his 2026 Schwab pdf statement")
    assert CAPABILITY_PACKS_BY_ID["drive_files"].issubset(drive_kept)


async def test_ask_documents_agent_handles_pod_adapter_unavailable_gracefully(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.adk_bridge import dispatch as dispatch_mod
    from hushh_mcp.services.pod_specialist_runtime import PodSpecialistAdapterUnavailable

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_SANDBOX_PROFILE", "virgin_pool_v1")
    monkeypatch.setenv("HUSSH_LEASE_ID", "lease_m8")
    monkeypatch.setenv("HUSSH_ID", "ha1_owner_m8")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner-m8")

    monkeypatch.setattr(
        agent_tree,
        "resolve_specialist_availability",
        lambda **_kw: SimpleNamespace(
            state="ready", reason_code="", as_dict=lambda: {"state": "ready"}
        ),
    )
    monkeypatch.setattr(agent_tree, "_task_from_context", AsyncMock(return_value=SimpleNamespace()))

    async def boom(_agent_id: str, _task: object) -> object:
        raise PodSpecialistAdapterUnavailable("agent_documents")

    monkeypatch.setattr(dispatch_mod, "dispatch", boom)
    monkeypatch.setattr(agent_tree, "dispatch", boom)

    ctx = SimpleNamespace(
        user_id="owner-m8",
        state={
            agent_tree.STATE_USER_ID: "owner-m8",
            agent_tree.STATE_EXECUTION_SURFACE: "typed_chat",
            agent_tree.STATE_CONSENT_TOKEN: "",
            agent_tree.STATE_VOICE_CONTEXT: None,
        },
    )
    result = await agent_tree.ask_documents_agent("check hushh recovery key", ctx)
    assert result["status"] == "unavailable"
    assert result["reason"] == "adapter_unavailable"
    assert result["structured"] == {"connector": "drive", "status": "unavailable"}
    assert result["is_complete"] is True
    assert "/one/files" in result["message"]


async def test_files_agent_chat_mode_returns_non_empty_text_via_agent_tool() -> None:
    manifest = agent_tree._load_product_agent_manifest("agent_files")

    class _EchoModel(BaseLlm):
        async def generate_content_async(self, llm_request, stream=False):
            del llm_request, stream
            yield LlmResponse(
                content=genai_types.Content(
                    role="model",
                    parts=[
                        genai_types.Part.from_text(text="Found hushh-recovery-key.txt in root.")
                    ],
                )
            )

    chat_agent = build_files_agent(manifest, model=_EchoModel(model="echo"), mode="chat")
    assert chat_agent.mode == "chat"
    assert chat_agent.output_schema is None

    task_agent = build_files_agent(manifest, model=_EchoModel(model="echo"))
    assert task_agent.mode == "task"

    # Exercise real ADK AgentTool.run_async on chat_agent.
    tool = AgentTool(agent=chat_agent)
    inv_ctx = SimpleNamespace(
        app_name="hussh_one",
        user_id="owner-m8",
        plugin_manager=SimpleNamespace(plugins=[]),
        memory_service=None,
        credential_service=None,
        events_compaction_config=None,
        context_cache_config=None,
        run_config=None,
        invocation_id="inv-1",
        _abort_signal=None,
        _abort_state=None,
    )
    from google.adk.sessions.state import State

    tool_ctx = SimpleNamespace(
        _invocation_context=inv_ctx,
        actions=SimpleNamespace(skip_summarization=False),
        state=State({}, {}),
    )
    out = await tool.run_async(args={"request": "find hushh recovery key"}, tool_context=tool_ctx)
    assert out == "Found hushh-recovery-key.txt in root."


async def test_files_tools_discovery_and_read_work_with_default_analysis_false_and_respect_exclusions(
    files_lib: FilesLibrary,
) -> None:
    # Default settings: settings.bin does not exist -> analysis == False.
    assert (await files_lib.settings())["analysis"] is False

    folder = await files_lib.create(
        name="Keys", parent="root", size=0, request_id="folder-keys-01", folder=True
    )
    excluded_folder = await files_lib.create(
        name="PrivateExcluded", parent="root", size=0, request_id="folder-excl-01", folder=True
    )
    key_entry = await _upload(
        files_lib,
        "hushh-recovery-key.txt",
        b"RECOVERY-CODE-9942",
        parent=folder["id"],
        request_id="upload-key-01",
    )
    secret_entry = await _upload(
        files_lib,
        "hidden-secret.txt",
        b"DO-NOT-DISCLOSE",
        parent=excluded_folder["id"],
        request_id="upload-excl-01",
    )

    listed_root = await files_tools.list_files()
    assert listed_root["status"] == "ok"
    assert {e["id"] for e in listed_root["entries"]} == {folder["id"], excluded_folder["id"]}

    searched = await files_tools.search_files("hushh recovery key")
    assert searched["status"] == "ok"
    assert searched["matches"][0]["id"] == key_entry["id"]
    assert searched["matches"][0]["path"] == "Keys/hushh-recovery-key.txt"

    # Direct filename read without 32-hex ID succeeds even when analysis == False.
    read_res = await files_tools.read_file("hushh recovery key")
    assert read_res["status"] == "ok"
    assert read_res["file"]["id"] == key_entry["id"]
    assert read_res["untrusted_content"] == "RECOVERY-CODE-9942"

    # Configure exclusion on excluded_folder (keeping analysis=False).
    await files_lib.configure(
        revision=0, analysis=False, automatic=False, excluded=[excluded_folder["id"]]
    )
    assert [e["id"] for e in (await files_tools.list_files())["entries"]] == [folder["id"]]
    excl_search = await files_tools.search_files("hidden secret")
    assert excl_search["matches"] == []
    blocked_read = await files_tools.read_file(secret_entry["id"])
    assert blocked_read == {"status": "blocked", "code": "FILES_EXCLUDED"}

    # Negative control: background job_target still requires analysis=True.
    with files_tools.job_target(key_entry["id"]):
        job_blocked = await files_tools.read_file(key_entry["id"])
        assert job_blocked == {"status": "blocked", "code": "FILES_ANALYSIS_CONSENT_REQUIRED"}


async def test_files_tools_multichunk_multiformat_write_and_storage_errors(
    files_lib: FilesLibrary, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 1. Multi-chunk text beyond 4 MiB chunk 0.
    big_text = ("A" * (4 * 1024 * 1024 + 512)).encode("utf-8")
    await _upload(files_lib, "multi-chunk.txt", big_text, request_id="upload-multi-01")
    big_res = await files_tools.read_file("multi chunk")
    assert big_res["status"] == "ok"
    assert big_res["truncated"] is True
    assert len(big_res["untrusted_content"]) == 32_000

    # 2. PDF extraction via pdfplumber.
    pdf_entry = await _upload(
        files_lib,
        "hushh_recovery_key.pdf",
        _make_pdf_bytes("PDF Recovery Secret 7711"),
        request_id="upload-pdf-01",
    )
    pdf_res = await files_tools.read_file(pdf_entry["id"])
    assert pdf_res["status"] == "ok"
    assert pdf_res["extracted"] is True
    assert pdf_res["detected_format"] == "pdf"
    assert "PDF Recovery Secret 7711" in pdf_res["untrusted_content"]

    # 3. XLSX extraction via openpyxl.
    await _upload(
        files_lib,
        "holdings.xlsx",
        _make_xlsx_bytes([["Asset", "Value"], ["NVDA", 1200]]),
        request_id="upload-xlsx-01",
    )
    xlsx_res = await files_tools.read_file("holdings")
    assert xlsx_res["status"] == "ok"
    assert xlsx_res["extracted"] is True
    assert xlsx_res["detected_format"] == "xlsx"
    assert "NVDA | 1200" in xlsx_res["untrusted_content"]

    # 4. HTML extraction via beautifulsoup4.
    await _upload(
        files_lib,
        "summary.html",
        b"<html><script>bad()</script><body><h1>Summary</h1><p>Alpha</p></body></html>",
        request_id="upload-html-01",
    )
    html_res = await files_tools.read_file("summary.html")
    assert html_res["status"] == "ok"
    assert html_res["detected_format"] == "html"
    assert "Alpha" in html_res["untrusted_content"]
    assert "bad()" not in html_res["untrusted_content"]

    # 5. Binary PNG returns structured metadata fallback instead of failing.
    await _upload(
        files_lib,
        "screenshot.png",
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",
        request_id="upload-png-01",
    )
    png_res = await files_tools.read_file("screenshot.png")
    assert png_res["status"] == "ok"
    assert png_res["extracted"] is False
    assert png_res["detected_format"] == "png"
    assert png_res["untrusted_content"] == ""

    # 6. Safe write_file + idempotency + negative controls.
    written = await files_tools.write_file(
        "agent-note.md", "# Note\nSaved safely.", request_id="write-req-0001"
    )
    assert written["status"] == "ok"
    assert written["file"]["name"] == "agent-note.md"
    replay = await files_tools.write_file(
        "agent-note.md", "# Note\nSaved safely.", request_id="write-req-0001"
    )
    assert replay["status"] == "ok"
    assert replay["file"]["id"] == written["file"]["id"]
    assert (await files_tools.read_file("agent-note.md"))["untrusted_content"] == (
        "# Note\nSaved safely."
    )

    assert (await files_tools.write_file("../bad.txt", "x"))["code"] == "FILES_INVALID_NAME"
    assert (await files_tools.write_file("run.exe", "x"))["code"] == "FILES_FORMAT_UNSUPPORTED"

    # 7. Transient storage error returns structured JSON instead of crashing.
    @asynccontextmanager
    async def failing_op(**_kwargs):
        raise PodMultiCloudStorageError("transient s3 timeout")
        yield  # pragma: no cover

    monkeypatch.setattr(files_tools, "operation", failing_op)
    err_res = await files_tools.search_files("anything")
    assert err_res["status"] == "unavailable"
    assert err_res["code"] == "FILES_STORAGE_UNAVAILABLE"


# ---------------------------------------------------------------------------
# 2. End-of-Turn Final-Step Resilience (run=758ea0f8)
# ---------------------------------------------------------------------------


def test_after_external_read_tool_guards_non_mapping_responses() -> None:
    tool = SimpleNamespace(name="files")
    ctx = SimpleNamespace(invocation_id="inv-1", state={"temp:one_execution_surface": "typed_chat"})
    assert external_read_boundary.after_external_read_tool(tool, {}, ctx, "plain text") is None
    assert external_read_boundary.after_external_read_tool(tool, {}, ctx, None) is None

    drive_tool = SimpleNamespace(name="read_selected_drive_search_result")
    external_read_boundary.after_external_read_tool(
        drive_tool,
        {"mode": "metadata"},
        ctx,
        {"status": "ok", "metadata_only": True, "result": "corrupt-str"},
    )
    assert ctx.state[external_read_boundary.STATE_DRIVE_READ_OUTCOME]["outcome"] == "ok"


async def test_adk_model_retries_empty_candidate_once_unless_safety_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for stream in (False, True):
        calls = 0

        class _Models:
            async def generate_content(self, **_kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    return SimpleNamespace(
                        text="",
                        function_calls=(),
                        candidates=[],
                        model_version="",
                        usage=None,
                    )
                return SimpleNamespace(
                    text="Recovered answer.",
                    function_calls=(),
                    model_version="gemini-4",
                    usage=None,
                )

            async def generate_content_stream(self, **_kwargs):
                nonlocal calls
                calls += 1
                current = calls

                async def _gen():
                    if current == 1:
                        yield SimpleNamespace(
                            text="",
                            function_calls=(),
                            candidates=[],
                            model_version="",
                            usage=None,
                        )
                    else:
                        yield SimpleNamespace(
                            text="Recovered stream.",
                            function_calls=(),
                            model_version="gemini-4",
                            usage=None,
                        )

                return _gen()

        client = SimpleNamespace(aio=SimpleNamespace(models=_Models()))
        model = ProviderAdkModel(model="gemini-4", provider="gemini", credential="k")
        monkeypatch.setattr(model, "_client", lambda c=client: c)
        monkeypatch.setattr(
            "hushh_mcp.runtime_providers.lifecycle.close_owned_model_client", AsyncMock()
        )
        req = LlmRequest(contents=[], config=genai_types.GenerateContentConfig())
        responses = [r async for r in model.generate_content_async(req, stream=stream)]
        assert calls == 2
        assert any(
            r.content and r.content.parts and "Recovered" in (r.content.parts[0].text or "")
            for r in responses
        )

    # Negative control: explicit SAFETY block must NOT retry.
    safety_calls = 0

    class _SafetyModels:
        async def generate_content(self, **_kwargs):
            nonlocal safety_calls
            safety_calls += 1
            return SimpleNamespace(
                text="",
                function_calls=(),
                candidates=[SimpleNamespace(finish_reason="SAFETY")],
                model_version="",
                usage=None,
            )

    safety_client = SimpleNamespace(aio=SimpleNamespace(models=_SafetyModels()))
    safety_model = ProviderAdkModel(model="gemini-4", provider="gemini", credential="k")
    monkeypatch.setattr(safety_model, "_client", lambda: safety_client)
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.lifecycle.close_owned_model_client", AsyncMock()
    )
    req = LlmRequest(contents=[], config=genai_types.GenerateContentConfig())
    _ = [r async for r in safety_model.generate_content_async(req, stream=False)]
    assert safety_calls == 1


async def test_pod_agui_synthesis_guard_streamed_after_run_and_busy_settle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    monkeypatch.setattr(
        pod_agui_lifetime, "ADMISSION", PodUpgradeAdmission(log_resolver=lambda: None)
    )
    monkeypatch.setattr(pod_agui_lifetime, "pod_incarnation", lambda: "synthetic")

    # 1. Multi-step server tool turn with empty assistant text injects deterministic fallback.
    async def empty_tool_sdk(self, inp):
        yield RunStartedEvent(thread_id=inp.thread_id, run_id=inp.run_id)
        yield ToolCallStartEvent(tool_call_id="c1", tool_call_name="files")
        yield ToolCallResultEvent(message_id="m-tool", tool_call_id="c1", content="{}")
        yield RunFinishedEvent(thread_id=inp.thread_id, run_id=inp.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", empty_tool_sdk)
    agent1 = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)
    agent1.close = AsyncMock()
    agent1.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)
    events1 = [ev async for ev in agent1.run(_input())]
    assert any(ev.type == EventType.TEXT_MESSAGE_CONTENT and ev.delta for ev in events1)
    assert events1[-1].type == EventType.RUN_FINISHED

    # Negative control: client-proxy pending tool call (no TOOL_CALL_RESULT) does not emit fallback.
    async def pending_client_sdk(self, inp):
        yield RunStartedEvent(thread_id=inp.thread_id, run_id=inp.run_id)
        yield ToolCallStartEvent(tool_call_id="c_client", tool_call_name="list_recent_receipts")
        yield RunFinishedEvent(thread_id=inp.thread_id, run_id=inp.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", pending_client_sdk)
    agent_pending = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)
    agent_pending.close = AsyncMock()
    agent_pending.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)
    events_pending = [ev async for ev in agent_pending.run(_input())]
    assert not any(ev.type == EventType.TEXT_MESSAGE_CONTENT for ev in events_pending)

    # 2. Streamed assistant answer is NOT overwritten by after_run exception.
    async def streamed_sdk(self, inp):
        yield RunStartedEvent(thread_id=inp.thread_id, run_id=inp.run_id)
        yield TextMessageContentEvent(message_id="m1", delta="Here is your key.")
        yield RunFinishedEvent(thread_id=inp.thread_id, run_id=inp.run_id)

    async def failing_after(_inp):
        raise RuntimeError("snapshot blip")

    monkeypatch.setattr(TimedADKAgent, "run", streamed_sdk)
    agent2 = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)
    agent2.close = AsyncMock()
    agent2.configure_pod_turn(
        require_access=AsyncMock(), runtime_scope=nullcontext, after_run=failing_after
    )
    events2 = [ev async for ev in agent2.run(_input())]
    assert not any(ev.type == EventType.RUN_ERROR for ev in events2)
    assert events2[-1].type == EventType.RUN_FINISHED

    # 3. Settle wait prevents spurious POD_CHAT_BUSY when Turn 1 already hit RUN_FINISHED.
    gate = asyncio.Event()

    async def slow_close_sdk(self, inp):
        yield RunStartedEvent(thread_id=inp.thread_id, run_id=inp.run_id)
        yield TextMessageContentEvent(message_id="m1", delta="Done.")
        yield RunFinishedEvent(thread_id=inp.thread_id, run_id=inp.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", slow_close_sdk)
    slow_agent = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)

    async def delayed_close():
        await gate.wait()

    slow_agent.close = delayed_close
    slow_agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)
    fast_agent = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)
    fast_agent.close = AsyncMock()
    fast_agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)

    stream1 = pod_chat_stream.pod_chat_events(slow_agent, _owner_input(), owner_id=USER_ID)
    frames1 = []
    async for frame in stream1:
        frames1.append(frame)
        if b"RUN_FINISHED" in frame:
            break

    # Release Turn 1 settle shortly after RUN_FINISHED while Turn 2 starts concurrently.
    async def release_soon():
        await asyncio.sleep(0.05)
        gate.set()

    releaser = asyncio.create_task(release_soon())
    frames2 = [
        frame
        async for frame in pod_chat_stream.pod_chat_events(
            fast_agent, _owner_input(), owner_id=USER_ID
        )
    ]
    await releaser
    await stream1.aclose()
    combined2 = b"".join(frames2)
    assert b"POD_CHAT_BUSY" not in combined2
    assert b"RUN_FINISHED" in combined2


def test_edge_gateway_proxy_read_timeout_exceeds_agui_execution_timeout() -> None:
    from hushh_mcp.services.agent_sandbox.edge_gateway_app import SandboxEdgeGatewayManager

    mgr = SandboxEdgeGatewayManager(
        claim_client=SimpleNamespace(),
        master_seed=b"S" * 32,
    )
    assert mgr.proxy_read_timeout_s >= 230.0


# ---------------------------------------------------------------------------
# 3. Fresh ACE / Cutover Parity: Goals, PKM, Browser, Terminal
# ---------------------------------------------------------------------------


async def test_fresh_ace_owner_parity_browser_terminal_pkm_and_goals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from api.routes.one import pod_browser
    from hushh_mcp.one_adk import pod_agui_context, terminal_tools
    from hushh_mcp.services import pod_pkm_resolver
    from hushh_mcp.services.agent_sandbox.virgin_standby import VirginStandbyRuntime
    from hushh_mcp.services.pod_binding_contract import APP_SCOPES

    # A. Browser /tasks returns 200 [] when HUSSH_POD_BROWSER_ENABLED=false.
    authority = SimpleNamespace(environment="development", require_held=AsyncMock())
    monkeypatch.setattr(
        pod_browser,
        "verified_session",
        lambda *_a, **_kw: (
            authority,
            {"user_id": "owner-ace", "hushh_id": "ha1_ace", "exp": 9999999999},
        ),
    )
    monkeypatch.setattr(pod_browser, "pod_incarnation", lambda: "epoch-ace")
    app = FastAPI()
    app.include_router(pod_browser.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://pod") as client:
        tasks_res = await client.get(
            "/api/one/pod/browser/tasks", headers={"Authorization": "Bearer owner"}
        )
        assert tasks_res.status_code == 200
        assert tasks_res.json() == []
        cap_res = await client.get(
            "/api/one/pod/browser/capability", headers={"Authorization": "Bearer owner"}
        )
        assert cap_res.status_code == 200
        assert cap_res.json()["available"] is False

    # B. Terminal hand is bound automatically for fresh ACE owner with APP_SCOPES.
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_SANDBOX_PROFILE", "virgin_pool_v1")
    monkeypatch.setenv("HUSSH_LEASE_ID", "lease_ace_fresh")
    monkeypatch.setenv("HUSSH_ID", "ha1_ace")
    monkeypatch.setattr(agent_tree, "pod_mode", lambda: True)

    ctx = pod_agui_context.PodChatContext.__new__(pod_agui_context.PodChatContext)
    ctx.owner = "owner-ace"
    ctx.hushh_id = "ha1_ace"
    ctx.claims = {"scopes": list(APP_SCOPES), "exp": 9999999999}
    with ctx._terminal_scope():
        assert terminal_tools.terminal_hand_available() is True
        roster = agent_tree._one_roster_tools(specialist_model="test-model")
        assert terminal_tools.terminal_start in roster

    # Negative control: without pod.act scope, terminal hand stays unavailable.
    ctx.claims = {"scopes": ["files.read"], "exp": 9999999999}
    with ctx._terminal_scope():
        assert terminal_tools.terminal_hand_available() is False

    # C. PKM local_pkm_enabled defaults True in activated ace runtime when unset,
    #    and virgin_standby sets POD_LOCAL_PKM_ENABLED="true".
    monkeypatch.delenv("POD_LOCAL_PKM_ENABLED", raising=False)
    assert pod_pkm_resolver.local_pkm_enabled() is True
    monkeypatch.setenv("POD_LOCAL_PKM_ENABLED", "0")
    assert pod_pkm_resolver.local_pkm_enabled() is False

    # Check virgin_standby sets POD_LOCAL_PKM_ENABLED on activation with prefix URL.
    import os as _os

    monkeypatch.setattr(_os, "environ", dict(_os.environ))
    _os.environ.pop("POD_LOCAL_PKM_ENABLED", None)
    _os.environ["HUSSH_POD_SIGNING_KEY"] = "x" * 64
    rt = VirginStandbyRuntime(
        bind_host="127.0.0.1",
        port=0,
        tmp_dir=tmp_path / "standby",
        asgi_launcher=lambda *_a: None,
        uid=10001,
    )
    try:
        rt.start_background()
        async with AsyncClient() as client:
            resp = await client.post(
                f"http://127.0.0.1:{rt.port}/internal/v1/activate-lease",
                json={
                    "hushh_id": "ha1_ace_standby",
                    "owner_id": "owner-ace",
                    "lease_id": "lease_standby_1",
                    "pod_private_key_b64": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                    "pod_storage_prefix_token_url": "https://hub.example/api/one/pod/storage-gateway/pods/ha1_ace_standby",
                },
            )
            assert resp.status_code == 200
            assert _os.environ.get("POD_LOCAL_PKM_ENABLED") == "true"
    finally:
        rt.stop()

    # D. Goals scheduled_one_execution enters files_access so Files/Wiki tools never 403.
    from hushh_mcp.one_adk import scheduled_one_execution
    from hushh_mcp.services.pod_files.runtime import require_files_access

    segment_check = AsyncMock()

    class _FakeSegment:
        def __init__(self, _cap, _lease):
            self.specialists = SimpleNamespace(owner_user_id="owner-ace")
            self.invocation = SimpleNamespace(bind=lambda: nullcontext())
            self.scope = SimpleNamespace()
            self.owner = SimpleNamespace()
            self.storage = SimpleNamespace()
            self.pending = SimpleNamespace()
            self.credential = ""

        check = segment_check

        async def build(self, _stack):
            return SimpleNamespace()

        async def run(self, _runner, _ref, _cont):
            await require_files_access(manage=True)
            return "completed"

    monkeypatch.setattr(scheduled_one_execution, "_Segment", _FakeSegment)
    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.dispatch.bind_specialist_runtime", lambda *a: nullcontext()
    )
    monkeypatch.setattr(scheduled_one_execution, "bind_mcp_turn", lambda *a: nullcontext())
    monkeypatch.setattr(scheduled_one_execution, "bind_mcp_approval_port", lambda *a: nullcontext())
    monkeypatch.setattr(
        scheduled_one_execution, "private_pending_call_scope", lambda *a: nullcontext()
    )
    monkeypatch.setattr(
        scheduled_one_execution, "ScheduledMcpApprovalPort", lambda *a: SimpleNamespace()
    )
    monkeypatch.setattr(scheduled_one_execution, "resolve_request_secret", lambda *_a: "secret")
    monkeypatch.setattr(
        scheduled_one_execution,
        "finish_owned_cleanup",
        lambda coro: coro,
    )
    fake_cap = SimpleNamespace()
    fake_lease = SimpleNamespace()
    fake_cap = SimpleNamespace(
        grants=SimpleNamespace(invocation=lambda _l: SimpleNamespace(bind=lambda: nullcontext()))
    )
    outcome = await scheduled_one_execution.execute_scheduled_one(fake_cap, fake_lease)
    assert outcome == "completed"
    assert segment_check.await_count >= 2


async def test_active_non_terminal_turn_still_returns_pod_chat_busy_and_charset_size_fallbacks(
    files_lib: FilesLibrary, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    # 1. Negative control: active mid-stream turn (NOT terminal) returns POD_CHAT_BUSY immediately.
    monkeypatch.setattr(
        pod_agui_lifetime, "ADMISSION", PodUpgradeAdmission(log_resolver=lambda: None)
    )
    monkeypatch.setattr(pod_agui_lifetime, "pod_incarnation", lambda: "synthetic")
    started, release = asyncio.Event(), asyncio.Event()

    async def active_sdk(self, inp):
        yield RunStartedEvent(thread_id=inp.thread_id, run_id=inp.run_id)
        started.set()
        await release.wait()
        yield RunFinishedEvent(thread_id=inp.thread_id, run_id=inp.run_id)

    monkeypatch.setattr(TimedADKAgent, "run", active_sdk)
    active_agent = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)
    active_agent.close = AsyncMock()
    active_agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)

    second_agent = pod_agui_lifetime.PodTimedADKAgent.__new__(pod_agui_lifetime.PodTimedADKAgent)
    second_agent.close = AsyncMock()
    second_agent.configure_pod_turn(require_access=AsyncMock(), runtime_scope=nullcontext)

    stream1 = pod_chat_stream.pod_chat_events(active_agent, _owner_input(), owner_id=USER_ID)
    await anext(stream1)
    await asyncio.wait_for(started.wait(), 1.0)
    busy_frames = [
        f
        async for f in pod_chat_stream.pod_chat_events(
            second_agent, _owner_input(), owner_id=USER_ID
        )
    ]
    assert b"POD_CHAT_BUSY" in b"".join(busy_frames)
    release.set()
    async for _ in stream1:
        pass
    await stream1.aclose()

    # 2. Latin-1 / UTF-16 fallback via charset_normalizer + >8 MiB size preview fallback.
    latin1_bytes = "Café recovery key - résumé".encode("latin-1")
    await _upload(files_lib, "latin1-note.txt", latin1_bytes, request_id="upload-latin1-01")
    latin_res = await files_tools.read_file("latin1 note")
    assert latin_res["status"] == "ok"
    assert latin_res["extracted"] is True
    assert "Café" in latin_res["untrusted_content"]

    huge_entry = await files_lib.create(
        name="archive-large.bin",
        parent="root",
        size=9 * 1024 * 1024,
        request_id="upload-huge-01",
    )
    # Mark ready via internal write to test >8 MiB metadata preview without uploading 9 MiB.
    raw_entry, gen = await files_lib._read(files_lib._path(huge_entry["id"]))
    raw_entry["state"] = "ready"
    raw_entry["received"] = raw_entry["size"]
    await files_lib._write(files_lib._path(huge_entry["id"]), raw_entry, gen)
    huge_res = await files_tools.read_file(huge_entry["id"])
    assert huge_res["status"] == "ok"
    assert huge_res["extracted"] is False
    assert huge_res["code"] == "FILES_SIZE_PREVIEW_ONLY"
