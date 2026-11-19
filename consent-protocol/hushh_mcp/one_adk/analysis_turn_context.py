"""Request-only admission of a user-selected stock analysis result."""

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from hushh_mcp.one_adk.request_secrets import store_request_secret

STATE_ANALYSIS_RESULT = "temp:hussh:analysis_result"


class AnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    ticker: str = Field(pattern=r"^[A-Z0-9^][A-Z0-9.\-^=]{0,15}$")
    runId: str = Field(min_length=1, max_length=128)
    decision: str = Field(min_length=1, max_length=80)
    finalStatement: str = Field(min_length=1, max_length=4000)
    confidence: float = Field(ge=0, le=100)
    completedAt: str = Field(min_length=1, max_length=80)


def admit_analysis_result(forwarded: dict, *, owner_admitted: bool) -> str:
    raw = forwarded.pop("financeAnalysisResult", None)
    if not owner_admitted or not isinstance(raw, dict):
        return ""
    try:
        result = AnalysisResult.model_validate(raw)
    except ValidationError:
        return ""
    return store_request_secret(result.model_dump_json(), ttl_seconds=240)
