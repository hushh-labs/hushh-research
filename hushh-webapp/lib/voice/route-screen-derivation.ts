export type VoiceRouteScreenInfo = {
  screen: string;
  subview?: string | null;
};

export function deriveVoiceRouteScreen(pathname: string): VoiceRouteScreenInfo {
  const normalizedPath = String(pathname || "").split("?")[0];
  if (!normalizedPath) {
    return { screen: "unknown", subview: null };
  }
  if (normalizedPath === "/kai" || normalizedPath.startsWith("/kai/home")) {
    return { screen: "home", subview: null };
  }
  if (normalizedPath.startsWith("/kai/dashboard") || normalizedPath.startsWith("/kai/portfolio")) {
    const segments = normalizedPath.split("/").filter(Boolean);
    return { screen: "dashboard", subview: segments[2] || null };
  }
  if (normalizedPath.startsWith("/kai/analysis")) {
    return { screen: "analysis", subview: null };
  }
  if (normalizedPath.startsWith("/kai/import")) {
    return { screen: "import", subview: null };
  }
  if (normalizedPath.startsWith("/kai/optimize")) {
    return { screen: "optimize", subview: null };
  }
  if (normalizedPath.startsWith("/consents")) {
    return { screen: "consents", subview: null };
  }
  if (normalizedPath.startsWith("/profile")) {
    return { screen: "profile", subview: null };
  }
  if (normalizedPath.startsWith("/kai")) {
    const segments = normalizedPath.split("/").filter(Boolean);
    return { screen: "kai", subview: segments[1] || null };
  }
  return { screen: "app", subview: null };
}
