/** Owner-scoped activity API filters; the UI retains private text in memory. */
export type FeedActivityQuery = {
    query?: string;
    scope?: string | null;
    persona?: "investor" | "ria";
    person?: string;
    agent?: string | null;
    from_at?: string | null;
    before_at?: string | null;
    cursor?: string | null;
    limit?: number;
};
