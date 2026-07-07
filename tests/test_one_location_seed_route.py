def test_seed_trusted_routes_removed():
    from api.routes.one import router  # aggregate One router

    paths = {r.path for r in router.routes}
    assert "/api/one/location/seed-trusted" not in paths
    assert "/api/one/connections/seed-trusted" not in paths
