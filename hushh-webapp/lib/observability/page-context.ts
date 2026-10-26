/** URL context for the Google tag; custom event schemas remain metadata-only. */
export interface AnalyticsPageContext {
  page_location: string;
  page_referrer: string;
}

/**
 * Keep this function self-contained: the bootstrap serializes this same policy
 * before loading any analytics SDK. Ordinary attribution is returned unchanged.
 */
export function resolveAnalyticsPageContext(
  location: string,
  referrer: string,
): AnalyticsPageContext {
  try {
    const origin = new URL(location).origin;
    const protectedPath = "/one/documents/open";
    const sanitize = (value: string, firstPartyOnly: boolean): string => {
      if (!value) return value;
      try {
        const url = new URL(value);
        if (firstPartyOnly && url.origin !== origin) return value;
        if (url.pathname.replace(/\/$/, "") === protectedPath) {
          url.search = "";
          url.hash = "";
          return url.href;
        }
        // The signed-out document reader carries its locator through login.
        // Remove only that resume parameter; keep unrelated campaign values.
        let changed = false;
        for (const redirect of url.searchParams.getAll("redirect")) {
          try {
            const target = new URL(redirect, origin);
            if (
              target.origin === origin &&
              target.pathname.replace(/\/$/, "") === protectedPath
            ) {
              url.searchParams.delete("redirect");
              changed = true;
              break;
            }
          } catch {
            // An invalid external input does not become a protected route.
          }
        }
        return changed ? url.href : value;
      } catch {
        return value;
      }
    };
    return {
      page_location: sanitize(location, false),
      page_referrer: sanitize(referrer, true),
    };
  } catch {
    return { page_location: "", page_referrer: "" };
  }
}

/** Configure defaults before GA/GTM load, including automatic SDK events. */
export function buildWebAnalyticsBootstrap(measurementId: string): string {
  if (measurementId && !/^G-[A-Z0-9]+$/i.test(measurementId)) {
    throw new Error("Invalid analytics measurement ID");
  }
  const configure = measurementId
    ? `window.gtag('config',${JSON.stringify(measurementId)},Object.assign({send_page_view:false},context));`
    : "";
  return `(function(){var context=(${resolveAnalyticsPageContext.toString()})(window.location.href,document.referrer);window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments);};window.gtag('set',context);window.gtag('js',new Date());${configure}})();`;
}
