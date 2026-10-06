"""Core browser privacy contracts; synthetic fixtures do not qualify cloud isolation."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused
from tests.helpers.pod_browser import (
    Authority,
    Executor,
    _BrowserConsent,
    binding,
    control,
    readiness,
)


async def test_model_factory_rejects_custom_transport_and_unverified_native_model(monkeypatch):
    from pathlib import Path

    from google.adk.models import Gemini

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.one_adk.computer_use_agent import build_computer_use_agent

    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[1] / "hushh_mcp/agents/computer_use/agent.yaml")
    )

    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser.information import (
        BrowserInformation,
        BrowserModelProcessing,
    )

    runtime = control()
    process = BrowserModelProcessing(
        BrowserInformation(SimpleNamespace(), _BrowserConsent()),
        runtime.binding,
        (),
        "gemini-3.7-flash",
        readiness().model_transport,
        ("https://example.com",),
    )
    native = Gemini(model="gemini-3.7-flash")
    monkeypatch.delenv("POD_COMPUTER_USE_ENABLED", raising=False)
    with pytest.raises(BrowserRefused, match="DISABLED"):
        build_computer_use_agent(manifest, control=runtime, model=native, processing=process)
    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNSUPPORTED"):
        build_computer_use_agent(manifest, control=runtime, model=object(), processing=process)
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNVERIFIED"):
        build_computer_use_agent(
            manifest,
            control=runtime,
            model=Gemini(model="gemini-3.6-flash"),
            processing=process,
        )
    agent = build_computer_use_agent(manifest, control=runtime, model=native, processing=process)
    assert agent.mode == "task"
    assert agent.model is native
    # Exercise native ADK discovery, which initializes before ToolContext prepare.
    tools = await agent.tools[0].get_tools()
    assert "initialize" not in {tool.name for tool in tools}
    assert "search" not in {tool.name for tool in tools}
    assert "click_at" in {tool.name for tool in tools}


async def test_selected_pkm_needs_processing_and_distinct_exact_website_disclosure():
    from hushh_mcp.services.pod_browser.information import BrowserInformation, InformationField

    class Source:
        revision = 1

        async def read(self, bound, field):
            if field.source_content_revision != self.revision:
                raise BrowserRefused("BROWSER_INFORMATION_CHANGED")
            return {"favorite_color": "blue", "unrelated": "not authorized"}

    source, auth = Source(), _BrowserConsent()
    information = BrowserInformation(source, auth)
    field = InformationField(
        domain="preferences",
        path="favorite_color",
        export_revision=1,
        source_content_revision=1,
        source_manifest_revision=1,
    )
    values = {field.scope: {"preferences": {"favorite_color": "blue"}}}
    args = dict(
        model="gemini-3.7-flash", transport="native", allowed_origins=("https://example.com",)
    )
    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await information.for_model(binding(), (field,), **args)
    auth.approve(
        "model_process",
        {
            "fields": [field.model_dump()],
            "values": values,
            "model": args["model"],
            "transport": "native",
            "origins": list(args["allowed_origins"]),
            "screen_processing": True,
        },
    )
    assert await information.for_model(binding(), (field,), **args) == values
    disclosure = dict(
        destination="https://example.com/autosave",
        action_sequence=1,
        control_epoch=1,
        request_commitment="a" * 64,
    )
    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await information.for_website(binding(), (field,), **disclosure)
    auth.approve(
        "disclose",
        {
            "fields": [field.model_dump()],
            "values": values,
            "destination": disclosure["destination"],
            "sequence": 1,
            "epoch": 1,
            "request_commitment": "a" * 64,
        },
    )
    assert await information.for_website(binding(), (field,), **disclosure) == values
    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await information.for_website(
            binding(), (field,), **{**disclosure, "destination": "https://other.com/autosave"}
        )
    source.revision = 2
    with pytest.raises(BrowserRefused, match="CHANGED"):
        await information.for_model(binding(), (field,), **args)


@pytest.mark.parametrize(
    "domain,path,value",
    [
        ("secrets", "password", "fixture"),
        ("runtime_secrets", "key", "fixture"),
        ("preferences", "tax_id", "fixture"),
        ("preferences", "color", {"password": "hidden"}),
    ],
)
def test_secret_or_unselected_nested_information_never_reaches_model(domain, path, value):
    from hushh_mcp.services.pod_browser.information import InformationField, selected_projection

    with pytest.raises(BrowserRefused, match="SECRET_INFORMATION_REFUSED"):
        selected_projection(
            InformationField(
                domain=domain,
                path=path,
                export_revision=1,
                source_content_revision=1,
                source_manifest_revision=1,
            ),
            {path: value},
        )


async def test_manual_login_observations_never_enter_the_adk_computer():
    from hushh_mcp.services.pod_browser.adk_computer import PodComputer

    recordings = []

    async def processing():
        recordings.append("processing")
        return {}

    runtime = control(auth=Authority(approved=True))
    computer = PodComputer(
        runtime, processing_check=processing, allowed_origins=frozenset({"https://example.com"})
    )
    await computer.initialize()
    await runtime.take_control()
    await runtime.execute(
        BrowserAction(
            operation="type", sequence=1, control_epoch=2, x=1, y=1, text="synthetic-credential"
        ),
        actor="owner",
    )
    with pytest.raises(BrowserRefused, match="OBSERVATION_PAUSED"):
        await computer.current_state()
    assert recordings == []
    await runtime.resume_agent()
    await computer.current_state()
    assert recordings == ["processing", "processing"]


@pytest.mark.parametrize(
    "url,refused",
    [
        ("https://example.com/callback?code=synthetic-code#access_token=synthetic-token", False),
        ("https://other.com/", True),
    ],
)
async def test_provider_observes_only_approved_origin_without_login_url_credentials(url, refused):
    from hushh_mcp.services.pod_browser.adk_computer import PodComputer

    class CallbackExecutor(Executor):
        async def execute(self, action):
            return (await super().execute(action)).model_copy(update={"url": url})

    async def processing():
        return {}

    runtime = control(driver=CallbackExecutor())
    computer = PodComputer(
        runtime, processing_check=processing, allowed_origins=frozenset({"https://example.com"})
    )
    await computer.initialize()
    if refused:
        with pytest.raises(BrowserRefused, match="SCREEN_PROCESSING_REFUSED"):
            await computer.current_state()
    else:
        recorded = await computer.current_state()
        assert recorded.url == "https://example.com"
        assert "synthetic-code" not in str(recorded) and "synthetic-token" not in str(recorded)


async def test_takeover_and_handback_during_processing_do_not_release_a_stale_frame():
    from hushh_mcp.services.pod_browser.adk_computer import PodComputer

    entered, release = asyncio.Event(), asyncio.Event()

    async def processing():
        entered.set()
        await release.wait()
        return {}

    runtime = control()
    computer = PodComputer(
        runtime, processing_check=processing, allowed_origins=frozenset({"https://example.com"})
    )
    await computer.initialize()
    pending = asyncio.create_task(computer.current_state())
    await entered.wait()
    await runtime.take_control()
    await runtime.resume_agent()
    release.set()
    with pytest.raises(BrowserRefused, match="OBSERVATION_PAUSED"):
        await pending


async def test_selected_export_pins_export_and_pkm_source_revisions_independently():
    from dataclasses import replace

    from hushh_mcp.services.pod_browser.information import ScopedProjectionReader
    from tests.helpers.pod_browser import browser_export_package

    package, field = browser_export_package()

    class Source:
        async def load_current(self, bound, selection):
            return package

    reader = ScopedProjectionReader(Source())
    assert await reader.read(binding(), field) == {"favorite_color": "blue"}
    for changes in (
        {"source_content_revision": 12},
        {"source_manifest_revision": 8},
        {"binding": binding(incarnation="old")},
    ):
        package = replace(package, **changes)
        with pytest.raises(BrowserRefused, match="GRANT_REFUSED"):
            await reader.read(binding(), field)
