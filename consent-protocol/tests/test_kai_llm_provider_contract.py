"""Provider contract checks for Kai LLM operons."""

from __future__ import annotations

from pathlib import Path


def test_llm_operon_does_not_use_legacy_google_generativeai_fallback():
    root = Path(__file__).resolve().parents[1]
    source = (root / "hushh_mcp/operons/kai/llm.py").read_text(encoding="utf-8")

    assert "google.generativeai" not in source
    assert "GenerativeModel(" not in source
    assert "GOOGLE_GENAI_USE_VERTEXAI" in source
    assert "ManagedGeminiRuntimeBinding.from_environment()" in source
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in source
    assert "gcloud" not in source

    factory_source = (root / "hushh_mcp/runtime_providers/factory.py").read_text(encoding="utf-8")
    assert "vertexai=True" in factory_source


def test_managed_gemini_clients_are_constructed_only_by_runtime_provider():
    root = Path(__file__).resolve().parents[1]
    allowed = root / "hushh_mcp/runtime_providers/factory.py"
    offenders: list[str] = []

    for source_path in [*(root / "hushh_mcp").rglob("*.py"), *(root / "api").rglob("*.py")]:
        if source_path == allowed:
            continue
        source = source_path.read_text(encoding="utf-8")
        if "genai.Client(" in source or "genai.Client (" in source:
            offenders.append(str(source_path.relative_to(root)))

    assert offenders == []
