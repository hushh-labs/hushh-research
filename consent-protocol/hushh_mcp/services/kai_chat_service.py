# consent-protocol/hushh_mcp/services/kai_chat_service.py
"""
Kai Chat Service - Conversational AI with auto-learning and context awareness.

This service handles:
1. Natural conversation with Google Gemini LLM
2. User context from PKM
3. Auto-learning of user attributes from conversation
4. Insertable UI component detection
5. Persistent chat history
6. Proactive onboarding (portfolio import prompts)
7. Intent classification for workflow triggers
"""

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional

from google import genai
from google.genai import types as genai_types

from hushh_mcp.constants import GEMINI_MODEL
from hushh_mcp.services.attribute_learner import get_attribute_learner
from hushh_mcp.services.chat_db_service import (
    ChatDBService,
    ComponentType,
    ContentType,
    Conversation,
    MessageRole,
    get_chat_db_service,
)
from hushh_mcp.services.personal_knowledge_model_service import (
    UserPersonalKnowledgeModelMetadata,
    get_pkm_service,
)

logger = logging.getLogger(__name__)


# =============================================================================
# INTENT CLASSIFICATION
# =============================================================================


class IntentType(str, Enum):
    """Types of user intents that trigger specific workflows."""

    PORTFOLIO_IMPORT = "portfolio_import"
    STOCK_ANALYSIS = "stock_analysis"
    RISK_ASSESSMENT = "risk_assessment"
    GENERAL_CHAT = "general_chat"
    PROFILE_QUERY = "profile_query"
    CONSENT_MANAGEMENT = "consent_management"
    GREETING = "greeting"


class IntentClassifier:
    """Classifies user intent to trigger appropriate workflows."""

    INTENT_PATTERNS = {
        IntentType.PORTFOLIO_IMPORT: [
            "import",
            "upload",
            "brokerage",
            "statement",
            "portfolio",
            "holdings",
            "positions",
            "connect my",
            "add my stocks",
            "import my",
            "upload my",
        ],
        IntentType.STOCK_ANALYSIS: [
            "analyze",
            "what about",
            "should i buy",
            "recommendation",
            "stock",
            "ticker",
            "price",
            "evaluate",
            "research",
            "tell me about",
            "how is",
            "what do you think of",
        ],
        IntentType.RISK_ASSESSMENT: [
            "risk",
            "tolerance",
            "aggressive",
            "conservative",
            "profile",
            "risk profile",
            "investment style",
        ],
        IntentType.PROFILE_QUERY: [
            "what do you know",
            "my profile",
            "my data",
            "about me",
            "what have you learned",
            "my preferences",
        ],
        IntentType.CONSENT_MANAGEMENT: [
            "consent",
            "permission",
            "data sharing",
            "who has access",
            "revoke",
            "manage access",
        ],
        IntentType.GREETING: [
            "hi",
            "hello",
            "hey",
            "good morning",
            "good afternoon",
            "good evening",
            "howdy",
            "what's up",
            "sup",
        ],
    }

    def classify(self, message: str) -> tuple[IntentType, float]:
        """
        Classify user intent with confidence score.

        Returns:
            Tuple of (IntentType, confidence_score)
        """
        message_lower = message.lower().strip()

        # Check each intent pattern
        scores = {}
        for intent, patterns in self.INTENT_PATTERNS.items():
            matches = sum(1 for p in patterns if p in message_lower)
            if matches > 0:
                # Score based on number of matches and pattern specificity
                scores[intent] = min(0.5 + (matches * 0.2), 1.0)

        if not scores:
            return (IntentType.GENERAL_CHAT, 0.5)

        # Return highest scoring intent
        best_intent = max(scores, key=scores.get)
        return (best_intent, scores[best_intent])

    def extract_ticker(self, message: str) -> Optional[str]:
        """Extract stock ticker from message."""
        # Look for uppercase 1-5 letter words that could be tickers
        ticker_match = re.search(r"\b([A-Z]{1,5})\b", message)
        if ticker_match:
            return ticker_match.group(1)
        return None


@dataclass
class UIComponent:
    """A UI component to render in the chat."""

    type: str
    data: dict = field(default_factory=dict)


@dataclass
class KaiChatResponse:
    """Response from Kai chat service."""

    conversation_id: str
    response: str
    component_type: Optional[str] = None
    component_data: Optional[dict] = None
    learned_attributes: list[dict] = field(default_factory=list)
    tokens_used: Optional[int] = None


# System prompt for Kai
SYSTEM_PROMPT = """You are Kai, a friendly and knowledgeable personal AI assistant from Hussh. You help users manage their personal data, analyze investments, and provide personalized insights.

Your personality:
- Warm, approachable, and professional
- Concise but thorough - don't be overly verbose
- Proactive in offering relevant suggestions
- Privacy-conscious - remind users their data is encrypted and under their control

Your capabilities:
- Analyze investment portfolios and identify underperformers
- Learn user preferences and remember them for personalized advice
- Help users understand their financial risk profile
- Provide insights based on user's PKM data

PROACTIVE BEHAVIORS:
1. If the user is new (no portfolio data), proactively offer to import their brokerage statement
2. When discussing investments without portfolio context, remind them importing helps personalization
3. After learning about user preferences, acknowledge what you learned
4. If the user seems unsure, guide them through available features

{user_context}

Guidelines:
1. If the user mentions preferences (food, travel, financial, etc.), acknowledge you'll remember them
2. If asked about portfolio analysis, offer to import their brokerage statement
3. Keep responses conversational but informative
4. When discussing investments, be balanced and mention risks
5. Never give specific financial advice - provide analysis and let users decide
6. For new users, warmly welcome them and suggest starting with portfolio import

Current conversation context:
{chat_history}
"""


class KaiChatService:
    """
    Main service for conversational interaction with Kai.

    Integrates:
    - Google Gemini for natural language generation
    - PKM for user context
    - Attribute learner for auto-learning
    - Chat DB for persistent history
    - Intent classifier for workflow triggers
    """

    def __init__(self):
        self._client = None
        self._pkm_service = None
        self._chat_db = None
        self._attribute_learner = None
        self._intent_classifier = IntentClassifier()

    @property
    def client(self):
        """Get the google.genai client (from google-adk)."""
        if self._client is None:
            api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
            if api_key:
                self._client = genai.Client(api_key=api_key)
            else:
                logger.error("GOOGLE_API_KEY not set!")
                raise ValueError("GOOGLE_API_KEY environment variable is required")
        return self._client

    @property
    def pkm_service(self):
        if self._pkm_service is None:
            self._pkm_service = get_pkm_service()
        return self._pkm_service

    @property
    def chat_db(self) -> ChatDBService:
        if self._chat_db is None:
            self._chat_db = get_chat_db_service()
        return self._chat_db

    @property
    def attribute_learner(self):
        if self._attribute_learner is None:
            self._attribute_learner = get_attribute_learner()
        return self._attribute_learner

    async def process_message(
        self,
        user_id: str,
        message: str,
        conversation_id: Optional[str] = None,
    ) -> KaiChatResponse:
        """
        Process a user message and generate a response.

        Args:
            user_id: The user's ID
            message: The user's message
            conversation_id: Optional existing conversation ID

        Returns:
            KaiChatResponse with response text and optional UI component
        """
        try:
            # 1. Get or create conversation
            conversation = await self._get_or_create_conversation(user_id, conversation_id)

            # 2. Get chat history for context
            history = await self.chat_db.get_recent_context(conversation.id, max_messages=10)

            # 3. Get user's PKM context
            user_context = await self.pkm_service.get_user_metadata(user_id)

            # 4. Check if this is a new user who should be prompted for portfolio
            if await self._should_prompt_portfolio(user_id, user_context, history):
                # Store the user's message first
                await self.chat_db.add_message(
                    conversation_id=conversation.id,
                    role=MessageRole.USER,
                    content=message,
                )

                # Return proactive portfolio import prompt
                welcome_response = (
                    "Hi! I'm Kai, your personal investment advisor from Hussh. "
                    "To give you the best personalized insights, I can analyze your portfolio. "
                    "Would you like to import your brokerage statement? "
                    "You can upload a CSV or PDF, or skip for now and we can chat about anything else!"
                )

                await self.chat_db.add_message(
                    conversation_id=conversation.id,
                    role=MessageRole.ASSISTANT,
                    content=welcome_response,
                    content_type=ContentType.COMPONENT,
                    component_type=ComponentType.PORTFOLIO_IMPORT,
                    component_data={
                        "prompt": "Import your portfolio for personalized analysis",
                        "show_skip": True,
                    },
                )

                return KaiChatResponse(
                    conversation_id=str(conversation.id),
                    response=welcome_response,
                    component_type="portfolio_import",
                    component_data={
                        "prompt": "Import your portfolio for personalized analysis",
                        "show_skip": True,
                    },
                    learned_attributes=[],
                )

            # 5. Classify intent for workflow triggers
            intent, confidence = self._intent_classifier.classify(message)

            # 6. Handle high-confidence intents with specific workflows
            if confidence > 0.7:
                component = self._handle_intent(intent, message, user_context)
                if component:
                    # Store user message
                    await self.chat_db.add_message(
                        conversation_id=conversation.id,
                        role=MessageRole.USER,
                        content=message,
                    )

                    # Generate contextual response for the intent
                    response_text = self._get_intent_response(intent, component)

                    await self.chat_db.add_message(
                        conversation_id=conversation.id,
                        role=MessageRole.ASSISTANT,
                        content=response_text,
                        content_type=ContentType.COMPONENT,
                        component_type=ComponentType(component.type.upper())
                        if hasattr(ComponentType, component.type.upper())
                        else None,
                        component_data=component.data,
                    )

                    return KaiChatResponse(
                        conversation_id=str(conversation.id),
                        response=response_text,
                        component_type=component.type,
                        component_data=component.data,
                        learned_attributes=[],
                    )

            # 7. Build system prompt with context
            system_prompt = self._build_system_prompt(user_context, history)

            # 8. Generate response via LLM
            response_text, tokens = await self._generate_response(system_prompt, message)

            # 9. Extract and store any learned attributes (async, don't block)
            learned = await self.attribute_learner.extract_and_store(
                user_id=user_id,
                user_message=message,
                assistant_response=response_text,
            )

            # 10. Store messages in chat history
            await self.chat_db.add_message(
                conversation_id=conversation.id,
                role=MessageRole.USER,
                content=message,
            )

            # 11. Detect if we should show a UI component
            component = self._detect_component(message, response_text)

            # 12. Store assistant response with component if any
            await self.chat_db.add_message(
                conversation_id=conversation.id,
                role=MessageRole.ASSISTANT,
                content=response_text,
                content_type=ContentType.COMPONENT if component else ContentType.TEXT,
                component_type=ComponentType(component.type.upper())
                if component and hasattr(ComponentType, component.type.upper())
                else None,
                component_data=component.data if component else None,
                tokens_used=tokens,
                model_used="gemini-1.5-flash",
            )

            return KaiChatResponse(
                conversation_id=str(conversation.id),
                response=response_text,
                component_type=component.type if component else None,
                component_data=component.data if component else None,
                learned_attributes=learned,
                tokens_used=tokens,
            )

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            # Return a graceful error response
            return KaiChatResponse(
                conversation_id=conversation_id or "error",
                response="I apologize, but I encountered an issue processing your message. Please try again.",
                learned_attributes=[],
            )

    async def _should_prompt_portfolio(
        self,
        user_id: str,
        user_context: Optional[UserPersonalKnowledgeModelMetadata],
        history: list,
    ) -> bool:
        """
        Check if we should proactively prompt the user to import their portfolio.

        Triggers portfolio import prompt if:
        - User is new (no PKM data)
        - User has minimal attributes
        - No portfolio imported yet
        - First 1-2 messages in conversation
        """
        # Don't prompt if there's already chat history
        if len(history) > 2:
            return False

        # Don't prompt if user has significant data
        if user_context and user_context.total_attributes > 5:
            return False

        # Check if portfolio already imported
        user_domain_keys = (
            [d.domain_key for d in user_context.domains]
            if user_context and user_context.domains
            else []
        )
        if user_context and "financial" in user_domain_keys:
            # Portfolio data exists in the financial domain — no need to prompt
            return False

        return True

    async def _check_data_completeness(self, user_id: str) -> dict:
        """
        Check what financial data is missing for complete analysis.

        Returns dictionary with:
        - has_portfolio: bool
        - missing_attributes: list of attribute names
        - completeness_score: float (0-1)
        - total_attributes: int

        This enables proactive prompts like:
        "I see you haven't shared your risk tolerance yet. Would you like to take
        a quick quiz so I can give you more personalized advice?"
        """
        try:
            # Get user's domains
            metadata = await self.pkm_service.get_user_metadata(user_id)

            # Check if financial domain exists
            user_domain_keys = (
                [d.domain_key for d in metadata.domains] if metadata and metadata.domains else []
            )
            if not metadata or "financial" not in user_domain_keys:
                return {
                    "has_portfolio": False,
                    "missing_attributes": [
                        "portfolio",
                        "risk_tolerance",
                        "investment_horizon",
                        "income_bracket",
                    ],
                    "completeness_score": 0.0,
                    "total_attributes": 0,
                }

            # Get financial domain summary from the PKM index
            index = await self.pkm_service.get_index_v2(user_id)
            domain_summary = index.domain_summaries.get("financial", {}) if index else {}

            # Build a set of "known" attribute keys from the domain summary
            # The summary is a dict of non-sensitive metadata written by
            # update_domain_summary(); keys present indicate data has been stored.
            attr_keys = set(domain_summary.keys()) if domain_summary else set()

            # Define required attributes for complete profile
            required_attrs = {
                "portfolio_imported": "Your portfolio holdings",
                "risk_tolerance": "Your risk tolerance (conservative/moderate/aggressive)",
                "investment_horizon": "Your investment timeline (short/medium/long term)",
                "income_bracket": "Your income level",
                "investment_goals": "Your investment goals",
                "tax_situation": "Your tax situation (for tax-efficient strategies)",
                "liquidity_needs": "Your cash flow needs",
                "age_bracket": "Your age bracket (for age-appropriate strategies)",
            }

            # Check which are missing
            missing = []
            for attr_key, _description in required_attrs.items():
                if attr_key not in attr_keys:
                    missing.append(attr_key)

            # Calculate completeness score
            completeness_score = len(attr_keys & required_attrs.keys()) / len(required_attrs)

            return {
                "has_portfolio": "portfolio_imported" in attr_keys,
                "missing_attributes": missing,
                "completeness_score": round(completeness_score, 2),
                "total_attributes": len(attr_keys),
                "required_count": len(required_attrs),
            }

        except Exception as e:
            logger.error(f"Error checking data completeness: {e}")
            return {
                "has_portfolio": False,
                "missing_attributes": [],
                "completeness_score": 0.0,
                "total_attributes": 0,
            }

    async def get_proactive_data_collection_prompt(self, user_id: str) -> Optional[str]:
        """
        Generate a proactive prompt to collect missing data.

        Returns None if data is complete, or a friendly prompt if data is missing.
        """
        completeness = await self._check_data_completeness(user_id)

        # If profile is >70% complete, no need to prompt
        if completeness["completeness_score"] > 0.7:
            return None

        missing = completeness["missing_attributes"]

        if not missing:
            return None

        # Prioritize by importance
        priority_order = [
            "portfolio_imported",
            "risk_tolerance",
            "investment_horizon",
            "investment_goals",
            "age_bracket",
        ]

        # Get the highest priority missing attribute
        next_to_collect = None
        for attr in priority_order:
            if attr in missing:
                next_to_collect = attr
                break

        if not next_to_collect:
            next_to_collect = missing[0]

        # Generate appropriate prompt
        prompts = {
            "portfolio_imported": (
                "To give you personalized investment advice, I'd love to analyze your current holdings. "
                "Would you like to import your portfolio? You can upload a CSV or PDF brokerage statement."
            ),
            "risk_tolerance": (
                "Understanding your risk tolerance helps me recommend investments that match your comfort level. "
                "Would you describe yourself as conservative (prefer stability), moderate (balanced), or aggressive (comfortable with volatility)?"
            ),
            "investment_horizon": (
                "Your investment timeline helps me suggest appropriate strategies. "
                "Are you investing for the short term (< 3 years), medium term (3-10 years), or long term (10+ years)?"
            ),
            "investment_goals": (
                "What are your main investment goals? For example: retirement, wealth building, passive income, saving for a purchase, etc."
            ),
            "age_bracket": (
                "Your age helps me recommend age-appropriate investment strategies. "
                "Which bracket are you in: under 30, 30-40, 40-50, 50-60, or 60+?"
            ),
            "tax_situation": (
                "Your tax situation helps me suggest tax-efficient strategies. "
                "Are you in a high tax bracket, or do you have any special tax considerations?"
            ),
            "income_bracket": (
                "Understanding your income level helps me recommend appropriate investment amounts and strategies. "
                "What's your approximate annual income bracket?"
            ),
        }

        return prompts.get(
            next_to_collect,
            "Is there any additional information you'd like to share about your investment profile?",
        )

    def _handle_intent(
        self,
        intent: IntentType,
        message: str,
        user_context: UserPersonalKnowledgeModelMetadata,
    ) -> Optional[UIComponent]:
        """Handle specific intents with UI components."""
        if intent == IntentType.PORTFOLIO_IMPORT:
            return UIComponent(
                type="portfolio_import",
                data={"prompt": "Upload your brokerage statement", "show_skip": True},
            )

        elif intent == IntentType.STOCK_ANALYSIS:
            ticker = self._intent_classifier.extract_ticker(message)
            if ticker:
                return UIComponent(
                    type="analysis",
                    data={"ticker": ticker},
                )

        elif intent == IntentType.PROFILE_QUERY:
            return UIComponent(
                type="pkm_summary",
                data={"user_context": user_context.__dict__ if user_context else {}},
            )

        elif intent == IntentType.CONSENT_MANAGEMENT:
            return UIComponent(
                type="consent_management",
                data={},
            )

        return None

    def _get_intent_response(self, intent: IntentType, component: UIComponent) -> str:
        """Get a contextual response for a specific intent."""
        responses = {
            IntentType.PORTFOLIO_IMPORT: (
                "I'll help you import your portfolio. You can upload a CSV or PDF brokerage statement below. "
                "This will allow me to analyze your holdings and provide personalized insights."
            ),
            IntentType.STOCK_ANALYSIS: (
                f"Let me analyze {component.data.get('ticker', 'that stock')} for you. "
                "I'll look at key metrics, recent performance, and how it fits your portfolio."
            ),
            IntentType.PROFILE_QUERY: (
                "Here's what I know about you based on our conversations and your data. "
                "All this information is encrypted and under your control."
            ),
            IntentType.CONSENT_MANAGEMENT: (
                "You can manage who has access to your data here. "
                "Review and revoke permissions at any time."
            ),
        }
        return responses.get(intent, "Let me help you with that.")

    async def _get_or_create_conversation(
        self,
        user_id: str,
        conversation_id: Optional[str],
    ) -> Conversation:
        """Get existing conversation or create a new one."""
        if conversation_id:
            conversation = await self.chat_db.get_conversation(conversation_id)
            if conversation:
                return conversation

        # Create new conversation
        conversation = await self.chat_db.create_conversation(
            user_id=user_id,
            title="Chat with Kai",
            agent_context={"agent": "kai", "version": "2.0"},
        )

        if not conversation:
            raise ValueError("Failed to create conversation")

        return conversation

    def _build_system_prompt(
        self,
        user_context: UserPersonalKnowledgeModelMetadata,
        history: list[dict],
    ) -> str:
        """Build the system prompt with user context and history."""
        # Format user context
        context_parts = []

        if user_context.domains:
            context_parts.append("User's profile includes:")
            for domain in user_context.domains:
                context_parts.append(
                    f"  - {domain.display_name}: {domain.attribute_count} attributes"
                )
        else:
            context_parts.append(
                "User is new - no profile data yet. Be welcoming and offer to learn their preferences."
            )

        if user_context.total_attributes > 0:
            context_parts.append(f"\nTotal data points: {user_context.total_attributes}")

        user_context_str = (
            "\n".join(context_parts) if context_parts else "No user context available."
        )

        # Format chat history
        history_parts = []
        for msg in history[-5:]:  # Last 5 messages for context
            role = msg.get("role", "user")
            content = msg.get("content", "")[:200]  # Truncate long messages
            history_parts.append(f"{role.capitalize()}: {content}")

        history_str = (
            "\n".join(history_parts) if history_parts else "This is the start of the conversation."
        )

        return SYSTEM_PROMPT.format(
            user_context=user_context_str,
            chat_history=history_str,
        )

    async def _generate_response(
        self,
        system_prompt: str,
        user_message: str,
    ) -> tuple[str, Optional[int]]:
        """Generate a response using the LLM."""
        try:
            # Combine system prompt and user message
            full_prompt = f"{system_prompt}\n\nUser: {user_message}\n\nKai:"

            config = genai_types.GenerateContentConfig(
                temperature=0.7,
                max_output_tokens=1024,
            )

            response = await self.client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=full_prompt,
                config=config,
            )

            # Get token count if available
            tokens = None
            if hasattr(response, "usage_metadata"):
                tokens = getattr(response.usage_metadata, "total_token_count", None)

            return response.text.strip(), tokens

        except Exception as e:
            logger.error(f"Error generating response: {e}")
            return "I'm having trouble generating a response right now. Please try again.", None

    def _detect_component(
        self,
        user_message: str,
        response_text: str,
    ) -> Optional[UIComponent]:
        """Detect if we should show a UI component based on the conversation."""
        message_lower = user_message.lower()

        # Portfolio import triggers
        portfolio_triggers = [
            "import portfolio",
            "upload portfolio",
            "brokerage statement",
            "import my holdings",
            "analyze my portfolio",
            "import statement",
        ]

        if any(trigger in message_lower for trigger in portfolio_triggers):
            return UIComponent(
                type="portfolio_import",
                data={"prompt": "Upload your brokerage statement to get personalized insights"},
            )

        # Analysis triggers
        if "analyze" in message_lower and any(
            word in message_lower for word in ["stock", "ticker", "company"]
        ):
            # Try to extract ticker from message
            ticker_match = re.search(r"\b([A-Z]{1,5})\b", user_message)
            if ticker_match:
                return UIComponent(
                    type="analysis",
                    data={"ticker": ticker_match.group(1)},
                )

        # PKM summary trigger
        if any(
            phrase in message_lower
            for phrase in ["what do you know about me", "my profile", "my data"]
        ):
            return UIComponent(
                type="pkm_summary",
                data={},
            )

        return None

    async def get_conversation_history(
        self,
        conversation_id: str,
        limit: int = 50,
    ) -> list[dict]:
        """Get conversation history for display."""
        messages = await self.chat_db.get_messages(conversation_id, limit=limit)

        return [
            {
                "id": msg.id,
                "role": msg.role.value,
                "content": msg.content,
                "component_type": msg.component_type.value if msg.component_type else None,
                "component_data": msg.component_data,
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
            }
            for msg in messages
        ]

    async def get_initial_chat_state(self, user_id: str) -> dict:
        """
        Get initial chat state for a user - determines proactive welcome message.

        This is called when the chat UI opens to determine what welcome
        message Kai should show proactively (without waiting for user input).

        Returns:
            dict with:
            - is_new_user: True if user has no PKM data
            - has_portfolio: True if user has imported a portfolio
            - has_financial_data: True if user has financial domain attributes
            - welcome_type: 'new', 'returning_no_portfolio', or 'returning'
            - total_attributes: Total number of attributes in user's PKM
            - available_domains: List of domains user has data in
        """
        try:
            # Get PKM metadata
            metadata = await self.pkm_service.get_user_metadata(user_id)

            # Check portfolio
            has_portfolio = False
            try:
                portfolio = await self.pkm_service.get_portfolio(user_id)
                has_portfolio = portfolio is not None
            except Exception:
                pass

            # Check for financial domain
            has_financial_data = False
            available_domains = []
            if metadata and metadata.domains:
                available_domains = [d.domain_key for d in metadata.domains]
                for domain in metadata.domains:
                    if domain.domain_key == "financial" and domain.attribute_count > 0:
                        has_financial_data = True
                        break

            # Determine total attributes
            total_attributes = metadata.total_attributes if metadata else 0

            # Determine welcome type
            is_new_user = total_attributes == 0
            if is_new_user:
                welcome_type = "new"
            elif not has_portfolio:
                welcome_type = "returning_no_portfolio"
            else:
                welcome_type = "returning"

            return {
                "is_new_user": is_new_user,
                "has_portfolio": has_portfolio,
                "has_financial_data": has_financial_data,
                "welcome_type": welcome_type,
                "total_attributes": total_attributes,
                "available_domains": available_domains,
            }

        except Exception as e:
            logger.error(f"Error getting initial chat state: {e}")
            # Return safe defaults for new user
            return {
                "is_new_user": True,
                "has_portfolio": False,
                "has_financial_data": False,
                "welcome_type": "new",
                "total_attributes": 0,
                "available_domains": [],
            }

    async def analyze_portfolio_loser(
        self,
        user_id: str,
        ticker: str,
        conversation_id: Optional[str] = None,
    ) -> dict:
        """
        Analyze a specific portfolio loser and return a compact analysis.

        This method:
        1. Checks Renaissance universe for tier/conviction
        2. Generates a quick analysis using the LLM with Renaissance context
        3. Stores the decision in the PKM
        4. Returns a compact summary for chat display

        Args:
            user_id: The user's ID
            ticker: Stock ticker to analyze
            conversation_id: Optional conversation ID for context

        Returns:
            dict with analysis results
        """
        try:
            # Get or create conversation
            conversation = await self._get_or_create_conversation(user_id, conversation_id)

            # Get Renaissance context for the ticker
            from hushh_mcp.services.renaissance_service import get_renaissance_service

            renaissance = get_renaissance_service()
            ren_context = await renaissance.get_analysis_context(ticker)

            # Build Renaissance context string
            ren_context_str = ""
            if ren_context["is_investable"]:
                ren_context_str = f"""
RENAISSANCE UNIVERSE CONTEXT:
- Tier: {ren_context["tier"]} ({ren_context["tier_description"]})
- Investment Thesis: {ren_context["investment_thesis"]}
- 2024 FCF: ${ren_context["fcf_billions"]}B
- Conviction Weight: {ren_context["conviction_weight"]:.0%}
- Recommendation Bias: {ren_context["recommendation_bias"]}
- Sector Peers: {", ".join(ren_context["sector_peers"][:3]) if ren_context["sector_peers"] else "N/A"}

This stock IS in the Renaissance investable universe. Weight your analysis accordingly.
"""
            else:
                ren_context_str = """
RENAISSANCE UNIVERSE CONTEXT:
This stock is NOT in the Renaissance investable universe.
This means it may not meet the criteria for strong free cash flow generation.
Be more cautious in your recommendation.
"""

            # Build analysis prompt with Renaissance context
            analysis_prompt = f"""Analyze the stock {ticker} for a user who currently holds it at a loss.
{ren_context_str}
Provide a brief investment analysis with:
1. A clear decision: BUY (add more), HOLD (keep position), or REDUCE (sell some/all)
2. A confidence score from 0.0 to 1.0
3. A one-sentence summary (max 100 characters)
4. A brief reasoning paragraph (2-3 sentences)

Consider:
- Renaissance tier and conviction weight (if applicable)
- Current market conditions
- Company fundamentals
- Whether the loss is likely temporary or structural
- Risk factors

Format your response EXACTLY as:
DECISION: [BUY/HOLD/REDUCE]
CONFIDENCE: [0.0-1.0]
SUMMARY: [one sentence]
REASONING: [2-3 sentences]
"""

            # Generate analysis using new SDK
            config = genai_types.GenerateContentConfig(
                temperature=0.3,  # Lower temperature for more consistent analysis
                max_output_tokens=500,
            )

            response = await self.client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=analysis_prompt,
                config=config,
            )

            # Parse response
            response_text = response.text.strip()

            # Extract fields using regex
            decision_match = re.search(
                r"DECISION:\s*(BUY|HOLD|REDUCE)", response_text, re.IGNORECASE
            )
            confidence_match = re.search(r"CONFIDENCE:\s*([\d.]+)", response_text)
            summary_match = re.search(r"SUMMARY:\s*(.+?)(?=REASONING:|$)", response_text, re.DOTALL)
            reasoning_match = re.search(r"REASONING:\s*(.+)", response_text, re.DOTALL)

            decision = decision_match.group(1).upper() if decision_match else "HOLD"
            confidence = float(confidence_match.group(1)) if confidence_match else 0.5
            confidence = min(max(confidence, 0.0), 1.0)  # Clamp to 0-1
            summary = (
                summary_match.group(1).strip()
                if summary_match
                else f"Analysis complete for {ticker}"
            )
            reasoning = reasoning_match.group(1).strip() if reasoning_match else ""

            # Store decision as a non-sensitive summary in the PKM index
            saved = False
            try:
                analyzed_at = datetime.now().isoformat()
                ticker_upper = str(ticker or "").upper()
                await self.pkm_service.update_domain_summary(
                    user_id=user_id,
                    domain="financial",
                    summary={
                        f"{ticker_upper}_decision": decision,
                        f"{ticker_upper}_confidence": confidence,
                        f"{ticker_upper}_analyzed_at": analyzed_at,
                        "analysis_last_decision_ticker": ticker_upper,
                        "analysis_last_decision": decision,
                        "analysis_last_confidence": confidence,
                        "analysis_last_updated": analyzed_at,
                    },
                )
                saved = True

            except Exception as e:
                logger.warning(f"Failed to save analysis to PKM: {e}")

            # Store in chat history
            await self.chat_db.add_message(
                conversation_id=conversation.id,
                role=MessageRole.ASSISTANT,
                content=f"Analysis for {ticker}: {decision} ({int(confidence * 100)}% confidence). {summary}",
                content_type=ContentType.COMPONENT,
                component_type=ComponentType.ANALYSIS,
                component_data={
                    "ticker": ticker,
                    "decision": decision,
                    "confidence": confidence,
                    "summary": summary,
                    "reasoning": reasoning,
                    "renaissance_tier": ren_context.get("tier"),
                    "is_renaissance_investable": ren_context.get("is_investable", False),
                },
            )

            return {
                "conversation_id": str(conversation.id),
                "decision": decision,
                "confidence": confidence,
                "summary": summary,
                "reasoning": reasoning,
                "has_full_analysis": True,
                "saved_to_pkm": saved,
                "renaissance_context": {
                    "is_investable": ren_context.get("is_investable", False),
                    "tier": ren_context.get("tier"),
                    "tier_description": ren_context.get("tier_description", ""),
                    "conviction_weight": ren_context.get("conviction_weight", 0.0),
                    "investment_thesis": ren_context.get("investment_thesis", ""),
                },
            }

        except Exception as e:
            logger.error(f"Error analyzing loser {ticker}: {e}")
            raise


# Singleton instance
_kai_chat_service: Optional[KaiChatService] = None


def get_kai_chat_service() -> KaiChatService:
    """Get singleton KaiChatService instance."""
    global _kai_chat_service
    if _kai_chat_service is None:
        _kai_chat_service = KaiChatService()
    return _kai_chat_service
