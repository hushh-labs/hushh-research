# consent-protocol/api/routes/kai/chat.py
"""
Kai Chat API Route - Conversational endpoint for Agent Kai.

Handles:
- Natural language chat with Kai
- Auto-learning of user attributes
- Insertable UI component responses
- Conversation history management

Authentication:
- All endpoints require VAULT_OWNER token (consent-first architecture)
- Token contains user_id, proving both identity and consent
- Firebase is only used for bootstrap (issuing VAULT_OWNER token)
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.kai_chat_service import KaiChatResponse, get_kai_chat_service

logger = logging.getLogger(__name__)

router = APIRouter()


class KaiChatRequest(BaseModel):
    """Request body for Kai chat endpoint."""

    user_id: str = Field(..., description="User's Firebase UID")
    message: str = Field(..., description="User's message to Kai", min_length=1, max_length=4000)
    conversation_id: Optional[str] = Field(None, description="Existing conversation ID to continue")


class KaiChatResponseModel(BaseModel):
    """Response from Kai chat endpoint."""

    conversation_id: str = Field(..., description="Conversation ID for continuity")
    response: str = Field(..., description="Kai's response text")
    component_type: Optional[str] = Field(None, description="UI component type to render")
    component_data: Optional[dict] = Field(None, description="Data for the UI component")
    learned_attributes: list[dict] = Field(
        default_factory=list, description="Attributes learned from this exchange"
    )
    tokens_used: Optional[int] = Field(None, description="Tokens used for this response")


class ConversationHistoryResponse(BaseModel):
    """Response for conversation history endpoint."""

    conversation_id: str
    messages: list[dict]


@router.post("/chat", response_model=KaiChatResponseModel)
async def kai_chat(
    request: KaiChatRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> KaiChatResponseModel:
    """
    Main conversational endpoint for Kai.

    - Processes natural language messages
    - Returns responses with optional UI components
    - Auto-learns user attributes from conversation
    - Maintains conversation history

    **Authentication**: Requires valid VAULT_OWNER token in Authorization header.
    The token proves both identity (user_id) and consent (vault unlocked).

    **Example Request**:
    ```json
    {
        "user_id": "firebase-uid-123",
        "message": "I'm interested in tech stocks and have a moderate risk tolerance",
        "conversation_id": null
    }
    ```

    **Example Response**:
    ```json
    {
        "conversation_id": "conv-uuid-456",
        "response": "Great! I'll remember that you're interested in tech stocks...",
        "component_type": null,
        "component_data": null,
        "learned_attributes": [
            {"domain": "financial", "key": "sector_interest", "value": "tech"},
            {"domain": "financial", "key": "risk_tolerance", "value": "moderate"}
        ]
    }
    ```
    """
    # Verify user_id matches token (consent-first: token contains user_id)
    if token_data["user_id"] != request.user_id:
        logger.warning(
            f"User ID mismatch: token={token_data['user_id']}, request={request.user_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    # Process message
    service = get_kai_chat_service()
    response: KaiChatResponse = await service.process_message(
        user_id=request.user_id,
        message=request.message,
        conversation_id=request.conversation_id,
    )

    return KaiChatResponseModel(
        conversation_id=response.conversation_id,
        response=response.response,
        component_type=response.component_type,
        component_data=response.component_data,
        learned_attributes=response.learned_attributes,
        tokens_used=response.tokens_used,
    )


@router.get("/chat/history/{conversation_id}", response_model=ConversationHistoryResponse)
async def get_conversation_history(
    conversation_id: str,
    token_data: dict = Depends(require_vault_owner_token),
    limit: int = 50,
) -> ConversationHistoryResponse:
    """
    Get conversation history for a specific conversation.

    **Authentication**: Requires valid VAULT_OWNER token.
    """
    service = get_kai_chat_service()

    # Enforce conversation ownership to prevent cross-user history access.
    conversation = await service.chat_db.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found")
    if conversation.user_id != token_data["user_id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Conversation does not belong to authenticated user",
        )

    messages = await service.get_conversation_history(conversation_id, limit=limit)

    return ConversationHistoryResponse(
        conversation_id=conversation_id,
        messages=messages,
    )


@router.get("/chat/conversations/{user_id}")
async def list_user_conversations(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
    limit: int = 20,
    offset: int = 0,
) -> dict:
    """
    List all conversations for a user.

    **Authentication**: Requires valid VAULT_OWNER token matching user_id.
    """
    # Verify user_id matches token (consent-first: token contains user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    service = get_kai_chat_service()
    conversations = await service.chat_db.list_conversations(user_id, limit=limit, offset=offset)

    return {
        "user_id": user_id,
        "conversations": [
            {
                "id": conv.id,
                "title": conv.title,
                "created_at": conv.created_at.isoformat() if conv.created_at else None,
                "updated_at": conv.updated_at.isoformat() if conv.updated_at else None,
            }
            for conv in conversations
        ],
        "limit": limit,
        "offset": offset,
    }


class InitialChatStateResponse(BaseModel):
    """Response for initial chat state - determines proactive welcome message."""

    is_new_user: bool = Field(..., description="True if user has no PKM data")
    has_portfolio: bool = Field(..., description="True if user has imported a portfolio")
    has_financial_data: bool = Field(
        ..., description="True if user has financial domain attributes"
    )
    welcome_type: str = Field(
        ..., description="Type of welcome: 'new', 'returning_no_portfolio', 'returning'"
    )
    total_attributes: int = Field(0, description="Total number of attributes in user's PKM")
    available_domains: list[str] = Field(
        default_factory=list, description="List of domains user has data in"
    )


@router.get("/chat/initial-state/{user_id}", response_model=InitialChatStateResponse)
async def get_initial_chat_state(
    user_id: str,
    token_data: dict = Depends(require_vault_owner_token),
) -> InitialChatStateResponse:
    """
    Get initial chat state for a user - determines proactive welcome message.

    This endpoint is called when the chat UI opens to determine what welcome
    message Kai should show proactively (without waiting for user input).

    **Authentication**: Requires valid VAULT_OWNER token matching user_id.

    **Response Types**:
    - `is_new_user=True`: Show portfolio import prompt immediately
    - `has_portfolio=False`: Prompt to import portfolio
    - `has_portfolio=True`: Show personalized welcome with context

    **Example Response (new user)**:
    ```json
    {
        "is_new_user": true,
        "has_portfolio": false,
        "has_financial_data": false,
        "welcome_type": "new",
        "total_attributes": 0,
        "available_domains": []
    }
    ```
    """
    # Verify user_id matches token (consent-first: token contains user_id)
    if token_data["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    service = get_kai_chat_service()
    state = await service.get_initial_chat_state(user_id)

    return InitialChatStateResponse(
        is_new_user=state.get("is_new_user", True),
        has_portfolio=state.get("has_portfolio", False),
        has_financial_data=state.get("has_financial_data", False),
        welcome_type=state.get("welcome_type", "new"),
        total_attributes=state.get("total_attributes", 0),
        available_domains=state.get("available_domains", []),
    )


# =============================================================================
# LOSER ANALYSIS ENDPOINT
# =============================================================================


class AnalyzeLoserRequest(BaseModel):
    """Request body for analyze-loser endpoint."""

    user_id: str = Field(..., description="User's Firebase UID")
    symbol: str = Field(
        ..., description="Stock ticker symbol to analyze", min_length=1, max_length=10
    )
    conversation_id: Optional[str] = Field(None, description="Existing conversation ID")


class AnalyzeLoserResponse(BaseModel):
    """Response from analyze-loser endpoint."""

    conversation_id: str = Field(..., description="Conversation ID for continuity")
    ticker: str = Field(..., description="Analyzed ticker symbol")
    decision: str = Field(..., description="Investment decision: BUY, HOLD, or REDUCE")
    confidence: float = Field(..., description="Confidence score 0-1")
    summary: str = Field(..., description="One-line summary of the analysis")
    reasoning: str = Field(..., description="Detailed reasoning for the decision")
    component_type: str = Field(default="analysis_summary", description="UI component type")
    component_data: dict = Field(default_factory=dict, description="Data for the UI component")
    saved_to_pkm: bool = Field(default=False, description="Whether decision was saved")


@router.post("/chat/analyze-loser", response_model=AnalyzeLoserResponse)
async def analyze_portfolio_loser(
    request: AnalyzeLoserRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> AnalyzeLoserResponse:
    """
    Analyze a specific portfolio loser and return a compact analysis.

    This endpoint is optimized for quick analysis of stocks identified as losers
    in the user's portfolio. It returns a compact summary suitable for embedding
    in the chat interface.

    **Authentication**: Requires valid VAULT_OWNER token in Authorization header.
    The token proves both identity (user_id) and consent (vault unlocked).

    **Example Request**:
    ```json
    {
        "user_id": "firebase-uid-123",
        "symbol": "AAPL",
        "conversation_id": "conv-uuid-456"
    }
    ```

    **Example Response**:
    ```json
    {
        "conversation_id": "conv-uuid-456",
        "ticker": "AAPL",
        "decision": "HOLD",
        "confidence": 0.72,
        "summary": "Apple shows mixed signals with strong fundamentals but near-term headwinds.",
        "reasoning": "While Apple maintains strong cash flows and brand loyalty...",
        "component_type": "analysis_summary",
        "component_data": {...},
        "saved_to_pkm": true
    }
    ```
    """
    # Verify user_id matches token (consent-first: token contains user_id)
    if token_data["user_id"] != request.user_id:
        logger.warning(
            f"User ID mismatch: token={token_data['user_id']}, request={request.user_id}"
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    # Normalize ticker
    ticker = request.symbol.upper().strip()

    # Get chat service and analyze
    service = get_kai_chat_service()

    try:
        result = await service.analyze_portfolio_loser(
            user_id=request.user_id,
            ticker=ticker,
            conversation_id=request.conversation_id,
        )

        return AnalyzeLoserResponse(
            conversation_id=result.get("conversation_id", request.conversation_id or ""),
            ticker=ticker,
            decision=result.get("decision", "HOLD"),
            confidence=result.get("confidence", 0.5),
            summary=result.get("summary", f"Analysis complete for {ticker}"),
            reasoning=result.get("reasoning", ""),
            component_type="analysis_summary",
            component_data={
                "ticker": ticker,
                "decision": result.get("decision", "HOLD"),
                "confidence": result.get("confidence", 0.5),
                "summary": result.get("summary", ""),
                "hasFullAnalysis": result.get("has_full_analysis", False),
            },
            saved_to_pkm=result.get("saved_to_pkm", False),
        )

    except Exception as e:
        logger.error(f"Error analyzing loser {ticker}: {e}")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")
