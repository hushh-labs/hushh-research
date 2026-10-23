"""Closed text-scope projection of the synthetic runtime receipts."""


def text_probe_verdicts(probes, has_chat_binding, uat):
    one_chat_probe_ok = (
        next(
            (bool(item["ok"]) for item in probes if str(item["probe"]).startswith("one_chat:")),
            False,
        )
        if has_chat_binding and not uat
        else None
    )
    drive_document_requests_probe_ok = next(
        (
            bool(item["ok"])
            for item in probes
            if str(item["probe"]).startswith("drive_document_requests:")
        ),
        None,
    )
    return one_chat_probe_ok, drive_document_requests_probe_ok
