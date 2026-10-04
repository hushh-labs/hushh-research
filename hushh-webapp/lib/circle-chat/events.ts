export const CIRCLE_CHAT_CHANGED = "hushh:circle-chat-changed";
export function dispatchCircleChatChanged(userId: string, circleId: string): void {
  window.dispatchEvent(new CustomEvent(CIRCLE_CHAT_CHANGED, { detail: { userId, circleId } }));
}
