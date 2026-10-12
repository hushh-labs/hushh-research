export async function fetchFirstConnectInsights() {
  return { source: "calendar", sourceLabel: "Calendar", items: [
    { id: "one", label: "You have a recurring design review on Mondays.", memoryText: "Synthetic review", evidence: "4 Monday events" },
    { id: "two", label: "Weekly planning", memoryText: "Synthetic planning", evidence: "" },
  ] };
}
export async function keepFirstConnectInsight() {
  await new Promise(resolve => setTimeout(resolve, 250));
  return { status: "needs_sharing_ack", recipientCount: 2, reviewedCards: [] };
}
