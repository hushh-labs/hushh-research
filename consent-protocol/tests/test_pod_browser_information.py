"""Core browser privacy contracts; synthetic fixtures do not qualify cloud isolation."""

import asyncio

import pytest

from hushh_mcp.runtime_providers.gemini_config import SUPPORTED_GEMINI_TEXT_MODELS
from hushh_mcp.services.pod_browser.contracts import BrowserAction, BrowserRefused
from tests.helpers.pod_browser import (
    Authority,
    Executor,
    _BrowserConsent,
    binding,
    control,
    readiness,
)


async def test_browser_resolves_owner_selection_and_fences_a_later_change(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.runtime_providers.azure_browser_adk import AzureBrowserAdkModel
    from hushh_mcp.services import pod_ai_selection as selections
    from hushh_mcp.services.pod_browser.owner_model import resolve_owner_browser_model

    monkeypatch.setattr(selections, "_ACTIVE", None)
    monkeypatch.setattr(selections, "_LOAD_FAILED", False)
    monkeypatch.setattr(selections, "_REVISION", 0)
    selected = selections.AiSelection(
        provider="azure_openai",
        model="owner-browser-deployment",
        api_key="synthetic-owner-key",
        transport=None,
        vertex_project=None,
        vertex_location=None,
        issued_at_ms=1,
        selection_id="synthetic-selection",
        checked_at_ms=1,
        azure_endpoint="https://owner-browser.openai.azure.com/",
    )
    selections.set_active_ai_selection(selected)

    async def held():
        return None

    owned = resolve_owner_browser_model(held)
    assert isinstance(owned.model, AzureBrowserAdkModel) and owned.model.model == selected.model
    await owned.require_current()
    # Equal values selected again still establish a new configuration revision.
    selections.set_active_ai_selection(selected)
    with pytest.raises(BrowserRefused, match="MODEL_SELECTION_CHANGED"):
        await owned.require_current()
    selections.set_active_ai_selection(replace(selected, provider="openai", model="other"))
    with pytest.raises(BrowserRefused, match="TRANSPORT_UNSUPPORTED"):
        resolve_owner_browser_model(held)
    selections.set_active_ai_selection(
        replace(selected, provider="gemini", model="gemini-3.8-flash", transport="developer_api")
    )
    with pytest.raises(BrowserRefused, match="OWNER_MODEL_UNAVAILABLE"):
        resolve_owner_browser_model(held)
    monkeypatch.setattr(selections, "_LOAD_FAILED", True)
    with pytest.raises(BrowserRefused, match="OWNER_MODEL_UNAVAILABLE"):
        resolve_owner_browser_model(held)  # unreadable never falls back to cloud AI


@pytest.mark.parametrize(
    "model_name",
    [name for model in SUPPORTED_GEMINI_TEXT_MODELS for name in (model, "models/" + model)],
)
async def test_model_factory_rejects_custom_transport_and_unverified_native_model(
    monkeypatch, model_name
):
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

    runtime = control(ready=readiness(model_name=model_name))
    process = BrowserModelProcessing(
        BrowserInformation(SimpleNamespace(), _BrowserConsent()),
        runtime.binding,
        (),
        model_name,
        readiness().model_transport,
        ("https://example.com",),
    )
    native = Gemini(model=model_name)
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

    # A matching capability receipt cannot re-admit a retired fleet release.
    with pytest.raises(BrowserRefused, match="MODEL_UNSUPPORTED"):
        build_computer_use_agent(
            manifest,
            control=control(ready=readiness(model_name="gemini-3.6-flash")),
            model=Gemini(model="gemini-3.6-flash"),
            processing=process,
        )


def test_session_review_display_never_exports_sign_in_values():
    from hushh_mcp.services.pod_browser.task_authority import owner_review
    from hushh_mcp.services.pod_browser.task_contracts import BrowserReviewOffer

    offer = BrowserReviewOffer(
        review_id="opaque_review",
        purpose="session_remember",
        terms={
            "site": "opaque_site",
            "generation": 1,
            "origins": ["https://example.com"],
            "state": {
                "cookies": [{"value": "private-login-token"}],
                "origins": [
                    {
                        "origin": "https://example.com",
                        "localStorage": [{"value": "private-storage-token"}],
                    }
                ],
            },
        },
    )
    assert "private-login-token" in str(offer.terms)  # negative control: complete authority terms
    shown = owner_review(offer)
    assert shown.terms == {
        "site": "opaque_site",
        "generation": 1,
        "origins": ["https://example.com"],
        "cookie_count": 1,
        "storage_item_count": 1,
    }
    assert "token" not in str(shown.terms)


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
        async def execute(self, action, *, scope=None):
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


def test_pod_export_returns_only_exact_owner_recipient_revision_ciphertext():
    import base64

    from cryptography.hazmat.primitives import serialization

    from hushh_mcp.services.pod_browser.information_export import (
        BrowserExportSelection,
        selected_export,
    )
    from tests.helpers.pod_browser import browser_export_package

    package, field = browser_export_package(app_id="agent_one")
    public = base64.b64encode(
        package.connector_private_key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
    ).decode()
    selection = BrowserExportSelection(
        owner_id=package.binding.owner_id,
        pod_id=package.binding.pod_id,
        pod_key_id="fixture",
        field=field,
    )
    envelope = package.envelope
    row = {
        "user_id": selection.owner_id,
        "app_id": "agent_one",
        "grant_id": field.grant_ref,
        "scope": field.scope,
        "connector_key_id": "fixture",
        "envelope_version": 2,
        "export_revision": field.export_revision,
        "source_content_revision": field.source_content_revision,
        "source_manifest_revision": field.source_manifest_revision,
        "recipient_key_fingerprint": envelope.aad.recipient_key_fingerprint,
        "is_strict_zero_knowledge": True,
        "export_id": envelope.export_id,
        "envelope_aad": envelope.aad.model_dump(),
        "envelope_aad_sha256": envelope.aad_sha256,
        "ciphertext_sha256": envelope.ciphertext_sha256,
        "ciphertext_bytes": envelope.ciphertext_bytes,
        "scope_handle": envelope.aad.scope_handle,
        "encrypted_data": base64.b64encode(package.ciphertext).decode(),
        "wrapped_key_bundle": package.wrapped_key_bundle,
        "iv": package.iv_b64,
        "tag": package.tag_b64,
        "consent_token": "never-return-this-token",
    }
    result = selected_export(row, selection, public)
    assert result["ciphertext"] == row["encrypted_data"]
    assert '"favorite_color": "blue"' not in __import__("json").dumps(result)
    assert "never-return-this-token" not in str(result)
    for change in (
        {"user_id": "other"},
        {"connector_key_id": "old"},
        {"source_content_revision": 12},
        {"source_manifest_revision": 8},
        {"export_revision": 1},
        {"recipient_key_fingerprint": "sha256:" + "0" * 64},
        {"app_id": "other"},
        {"is_strict_zero_knowledge": False},
    ):
        with pytest.raises(BrowserRefused, match="GRANT_REFUSED"):
            selected_export({**row, **change}, selection, public)
    with pytest.raises(BrowserRefused, match="INFORMATION_UNAVAILABLE"):
        selected_export(None, selection, public)  # revoked or expired export


async def test_browser_export_requires_exact_signed_token_and_recorded_grant(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.consent import token as tokens
    from hushh_mcp.services.pod_browser.information_export import (
        BrowserExportSelection,
        require_export_grant,
    )
    from tests.helpers.pod_browser import browser_export_package

    package, field = browser_export_package(app_id="agent_one")
    selection = BrowserExportSelection(
        owner_id="owner", pod_id="pod", pod_key_id="fixture", field=field
    )
    lineage = {
        "user_id": "owner",
        "agent_id": "agent_one",
        "scope": field.scope,
        "request_id": field.grant_ref,
    }

    class Query:
        def __getattr__(self, name):
            return lambda *args, **kwargs: self

        def execute(self):
            return SimpleNamespace(data=[lineage])

    service = SimpleNamespace(_get_db=lambda: Query())
    claims = SimpleNamespace(user_id="owner", agent_id="agent_one", scope_str=field.scope)
    validate = AsyncMock(return_value=(True, None, claims))
    monkeypatch.setattr(tokens, "validate_token_with_db", validate)
    await require_export_grant(service, {"consent_token": "synthetic-signed-token"}, selection)
    validate.assert_awaited_with("synthetic-signed-token", expected_scope=field.scope)
    for key, value in (
        ("agent_id", "other"),
        ("scope_str", "attr.preferences.*"),
        ("user_id", "other"),
    ):
        old = getattr(claims, key)
        setattr(claims, key, value)
        with pytest.raises(BrowserRefused, match="GRANT_REFUSED"):
            await require_export_grant(
                service, {"consent_token": "synthetic-signed-token"}, selection
            )
        setattr(claims, key, old)
    lineage["request_id"] = "another-grant"
    with pytest.raises(BrowserRefused, match="GRANT_REFUSED"):
        await require_export_grant(service, {"consent_token": "synthetic-signed-token"}, selection)
