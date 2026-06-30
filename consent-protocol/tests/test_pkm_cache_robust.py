"""Security tests for PR 3512 — PKM cache security enforcement."""

import importlib.util
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Load pkm_cache_service
_svc_path = os.path.join(os.path.dirname(__file__), "..", "services", "pkm_cache_service.py")
_spec = importlib.util.spec_from_file_location("pkm_cache_service", _svc_path)
_mod = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(_mod)
except Exception:
    _mod = None


def test_pkm_cache_module_loads():
    assert _mod is not None, "pkm_cache_service must import without error"


def test_cache_config_exists():
    assert hasattr(_mod, "CacheConfig"), "CacheConfig must be defined"


def test_cache_has_ttl():
    """Cache config must define a TTL to prevent stale data."""
    cfg = _mod.CacheConfig

    fields = (
        [f.name for f in cfg.__dataclass_fields__.values()]
        if hasattr(cfg, "__dataclass_fields__")
        else []
    )
    assert any("ttl" in f.lower() for f in fields), (
        "CacheConfig must have a TTL field to bound cache staleness"
    )


def test_consent_scopes_not_cached_indefinitely():
    """User consent scopes must have a short TTL (< 3600s) in cache."""
    cfg = _mod.CacheConfig
    if not hasattr(cfg, "__dataclass_fields__"):
        pytest.skip("CacheConfig not a dataclass")
    # Look for any default that constrains scope cache TTL
    defaults = {
        k: v.default
        for k, v in cfg.__dataclass_fields__.items()
        if v.default is not v.default.__class__
    }
    for k, v in defaults.items():
        if "ttl" in k.lower() and isinstance(v, (int, float)):
            assert v <= 3600, f"Cache TTL {k}={v} must be ≤ 3600s for security"
