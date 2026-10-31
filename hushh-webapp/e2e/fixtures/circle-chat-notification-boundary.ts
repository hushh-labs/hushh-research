// Layout fixture replaces registration/auth only; rendered components are real.
export function useConsentNotificationState() {
  return { deliveryMode: "push_active", retryPushRegistration: () => {}, isRetryingPushRegistration: false };
}
