export async function fetchFirstConnectInsights() {
  return { source: "calendar", sourceLabel: "Calendar", items: [
    { id: "one", label: "You have a recurring design review on Mondays.", memoryText: "Synthetic review", evidence: "4 Monday events" },
    { id: "two", label: "You have a weekly planning meeting.", memoryText: "Synthetic planning", evidence: "4 weekly events" },
  ] };
}
export async function keepFirstConnectInsight() {
  await new Promise(resolve => setTimeout(resolve, 250));
  return { status: "needs_sharing_ack", recipientCount: 2, reviewedCards: [] };
}
