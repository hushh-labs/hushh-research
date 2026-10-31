"""Synthetic OAuth-project grant receipts shared by nearest custody tests."""


def operator_grants(topic, bootstrap, disposition="added"):
    return [
        {
            "step": "iam_gmail_publisher_on_topic",
            "policyResource": "https://pubsub.googleapis.com/v1/" + topic + ":getIamPolicy",
            "role": role,
            "member": member,
            "disposition": disposition,
            "beforeEtag": "v1",
            "afterEtag": "v2",
        }
        for role, member in [
            ("roles/pubsub.publisher", "serviceAccount:gmail-api-push@system.gserviceaccount.com"),
            ("roles/pubsub.subscriber", "serviceAccount:" + bootstrap),
        ]
    ]


def operator_cleanup_session(topic, bootstrap, case):
    from tests.test_byoc_substrate_teardown_is_loud import _Resp, _Session

    session = _Session()
    grants = operator_grants(topic, bootstrap, "already_present" if case == "adopted" else "added")
    policy = {
        "etag": "v2",
        "bindings": [{"role": g["role"], "members": [g["member"]]} for g in grants],
    }
    if case == "shared_policy":
        policy["bindings"].append(
            {"role": "roles/pubsub.viewer", "members": ["user:other@example.test"]}
        )
    if case == "conditional":
        policy["bindings"][0]["condition"] = {"expression": "true"}
    session.rule("GET", ":getIamPolicy", _Resp(200, policy))
    session.rule(
        "GET",
        "/subscriptions",
        _Resp(200, {"subscriptions": ["other"]} if case == "subscribed" else {}),
    )
    reads = iter([_Resp(200, {"name": topic}), _Resp(404)])
    session.rule("GET", topic, lambda *_: next(reads))
    session.rule("DELETE", topic, _Resp(503 if case == "uncertain" else 200))
    return session, grants
