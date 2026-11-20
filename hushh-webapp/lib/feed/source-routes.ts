import { ROUTES } from "@/lib/navigation/routes";
export const savedAnalysisFeedHref = (id: string) => `${ROUTES.ONE_FEED}?analysis_id=${encodeURIComponent(id)}`;
export const historicalFundingFeedHref = (id: string) => `${ROUTES.ONE_FEED}?funding_event=${encodeURIComponent(id)}`;
export const feedStatementHref = (id: string) => `${ROUTES.ONE_FEED}?statement_id=${encodeURIComponent(id)}`;
export const feedInstitutionHref = (id: string) => `${ROUTES.ONE_FEED}?institution_id=${encodeURIComponent(id)}`;
