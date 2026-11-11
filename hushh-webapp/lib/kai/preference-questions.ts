export const KAI_PREFERENCE_QUESTIONS = [
  {
    id: "investment_horizon",
    prompt: "How long will this stay invested?",
    options: [
      { value: "short_term", label: "Less than 3 years" },
      { value: "medium_term", label: "3–7 years" },
      { value: "long_term", label: "More than 7 years" },
    ],
  },
  {
    id: "drawdown_response",
    prompt: "Portfolio down 20%, what's your move?",
    options: [
      { value: "reduce", label: "Reduce investments to limit further losses" },
      { value: "stay", label: "Stay invested and review the situation" },
      { value: "buy_more", label: "Invest more at lower prices" },
    ],
  },
  {
    id: "volatility_preference",
    prompt: "Which feels more comfortable to you?",
    options: [
      { value: "small", label: "Smaller, steadier returns" },
      { value: "moderate", label: "Moderate ups and downs for better returns" },
      { value: "large", label: "Larger swings for higher potential returns" },
    ],
  },
] as const;
