/** The same provider artwork used by the existing Calendar onboarding. */
export function GoogleCalendarMark({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="12 12 40 40" fill="none" className={className}>
    <rect x="13" y="13" width="38" height="38" rx="8" fill="white" />
    <path d="M43 13H51V51H43V13Z" fill="#EA4335" /><path d="M13 43H51V51H13V43Z" fill="#34A853" />
    <path d="M13 13H21V51H13V13Z" fill="#4285F4" /><path d="M13 13H51V21H13V13Z" fill="#1A73E8" />
    <path d="M43 43H51V51H43V43Z" fill="#FBBC04" />
    <text x="32" y="41" textAnchor="middle" fill="#1A73E8" fontSize="20" fontWeight="700" fontFamily="inherit">31</text>
  </svg>;
}
