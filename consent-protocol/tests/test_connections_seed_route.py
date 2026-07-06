import importlib


def test_seed_dev_user_ids_parses_csv(monkeypatch):
    module = importlib.import_module("api.routes.one.connections")
    monkeypatch.setenv("SOS_SEED_DEV_USER_IDS", " devA , devB ,, devC ")
    assert module._seed_dev_user_ids() == ["devA", "devB", "devC"]


def test_seed_dev_user_ids_empty_when_unset(monkeypatch):
    module = importlib.import_module("api.routes.one.connections")
    monkeypatch.delenv("SOS_SEED_DEV_USER_IDS", raising=False)
    assert module._seed_dev_user_ids() == []


def test_seed_route_is_registered():
    module = importlib.import_module("api.routes.one.connections")
    paths = {getattr(r, "path", None) for r in module.router.routes}
    assert "/api/one/connections/seed-trusted" in paths
