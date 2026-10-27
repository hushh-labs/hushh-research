"""Ordering checks over the actual authored deployment steps."""


def assert_frontend_release_order(steps: list[dict], lane: str) -> None:
    names = [str(step.get("name") or "") for step in steps]
    positions = {step["id"]: index for index, step in enumerate(steps) if "id" in step}
    order = [
        positions[name]
        for name in (
            "start-frontend-image-build",
            "build-backend-image",
            "check-frontend-image",
            "deploy-backend",
            "deploy-frontend",
            "candidate-state",
        )
    ]
    assert order == sorted(order), lane
    joined = positions["build-frontend-image"]
    if lane == "production":
        assert (
            positions["build-backend-image"] < joined < positions["install-account-deletion-fence"]
        )
        assert joined < names.index("Sync canonical hosted runtime secrets")
        assert (
            names.index("Sync frontend hosted runtime secrets")
            < positions["start-frontend-image-build"]
        )
    else:
        assert (
            names.index("Sync canonical hosted runtime secrets")
            < positions["start-frontend-image-build"]
        )
        assert positions["deploy-backend"] < joined
        assert positions["deploy-frontend"] == joined + 1
