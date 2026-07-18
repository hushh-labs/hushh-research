"""Security tests for PR 3510 — PKM cache optimization."""

import importlib.util
import os

_svc = os.path.join(os.path.dirname(__file__), "..", "services", "pkm_cache_service.py")
spec = importlib.util.spec_from_file_location("pkm_cache_service", _svc)
mod = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(mod)
except Exception:
    mod = None


def test_loads():
    assert mod is not None


def test_has_cache_config():
    assert hasattr(mod, "CacheConfig")


def test_has_ttl():
    cfg = mod.CacheConfig
    fields = list(cfg.__dataclass_fields__.keys()) if hasattr(cfg, "__dataclass_fields__") else []
    assert any("ttl" in f.lower() for f in fields)
