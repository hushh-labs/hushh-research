import { buildKaiMarketRoute, ROUTES } from "@/lib/navigation/routes";
export const savedAnalysisFeedHref = (id: string) => buildKaiMarketRoute("analysis", { analysis_id: id, from: ROUTES.ONE_FEED });
export const historicalFundingFeedHref = (id: string) => `${ROUTES.ONE_FEED}?funding_event=${encodeURIComponent(id)}`;
export const feedStatementHref = (id: string) => `${ROUTES.ONE_FEED}?statement_id=${encodeURIComponent(id)}`;
export const feedInstitutionHref = (id: string) => `${ROUTES.ONE_FEED}?institution_id=${encodeURIComponent(id)}`;
