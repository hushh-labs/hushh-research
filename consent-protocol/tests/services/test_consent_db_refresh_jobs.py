from hushh_mcp.services.consent_db import ConsentDBService


def test_normalize_string_list_accepts_json_encoded_lists():
    service = ConsentDBService()

    assert service._normalize_string_list('["analytics", "profile", ""]') == [
        "analytics",
        "profile",
    ]
