# tests/agents/kai/providers/__init__.py
"""
Unit tests for the Kai provider adapter, scope gating, and audit telemetry.

Test files
----------
- test_base_contract.py        ABC + dataclass contract
- test_scopes.py               Scope hierarchy / authorization helpers
- test_audit.py                Hash-only invariant, latency capture
- test_registry_dispatch.py    Consent gate, fallback, default routing
- test_provider_gemini.py      Gemini delegation preserves behavior
- test_provider_openai.py      OpenAI request shape, error mapping
- test_provider_anthropic.py   Anthropic request shape, system handling
- test_provider_vllm.py        vLLM OpenAI-compatible client
- test_provider_llamacpp.py    llama.cpp transport + parsing
- test_llm_adapter_v2.py       Migrated synthesis function: fallback + adapter mode
"""
