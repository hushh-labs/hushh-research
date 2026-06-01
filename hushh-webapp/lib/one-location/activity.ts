import type {
  OneLocationAccessRequest,
  OneLocationActivityBucket,
  OneLocationActivityEvent,
  OneLocationActivityKind,
  OneLocationActivityRange,
  OneLocationActivityResponse,
  OneLocationGrant,
  OneLocationPublicInviteSubmission,
  OneLocationState,
} from "@/lib/one-location/types";

function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function safeLabel(value?: string | null, fallback = "KAI member"): string {
  return String(value || "").trim() || fallback;
}

function grantCounterpartyLabel(grant: OneLocationGrant): string {
  return safeLabel(grant.recipientDisplayName);
}

function receivedGrantOwnerLabel(grant: OneLocationGrant): string {
  return safeLabel(
    grant.ownerDisplayName || grant.recipientDisplayName,
    "A trusted person",
  );
}

function requestLabel(request: OneLocationAccessRequest): string {
  return safeLabel(request.requesterDisplayName, "Someone from KAI");
}

function publicSubmissionLabel(
  submission: OneLocationPublicInviteSubmission,
): string {
  return safeLabel(submission.visitorDisplayName, "Public request");
}

function parseActivityDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function activityRangeStart(range: OneLocationActivityRange): Date | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days + 1);
  return start;
}

function isDateInActivityRange(
  value: string | null | undefined,
  range: OneLocationActivityRange,
): boolean {
  const date = parseActivityDate(value);
  if (!date) return false;
  const start = activityRangeStart(range);
  return !start || date >= start;
}

function activityTimestamp(value: string | null | undefined): string | null {
  const date = parseActivityDate(value);
  return date ? date.toISOString() : null;
}

function activityBucketKey(
  date: Date,
  range: OneLocationActivityRange,
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  if (range === "90d" || range === "all") {
    return `${year}-${month}`;
  }
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function activityBucketLabel(
  date: Date,
  range: OneLocationActivityRange,
): string {
  if (range === "90d" || range === "all") {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      year: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function activityBucketStartValue(
  date: Date,
  range: OneLocationActivityRange,
): number {
  if (range === "90d" || range === "all") {
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  }
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

function emptyActivity(range: OneLocationActivityRange): OneLocationActivityResponse {
  return {
    range,
    summary: {
      sharedWithCount: 0,
      activeShareCount: 0,
      requestsReceivedCount: 0,
      requestsSentCount: 0,
      viewsCount: 0,
      publicLinkCount: 0,
      publicResponseCount: 0,
      totalEvents: 0,
    },
    events: [],
    buckets: [],
  };
}

export function buildOneLocationActivityFallback(
  state: OneLocationState | null,
  currentUserId: string | null | undefined,
  range: OneLocationActivityRange,
): OneLocationActivityResponse {
  if (!state) return emptyActivity(range);

  const recipientLabels = new Map(
    state.recipients.map((recipient) => [
      recipient.userId,
      safeLabel(recipient.displayName),
    ]),
  );
  const labelForUser = (userId?: string | null, fallback = "KAI member") =>
    safeLabel(userId ? recipientLabels.get(userId) : null, fallback);
  const events: OneLocationActivityEvent[] = [];
  const addEvent = ({
    id,
    kind,
    occurredAt,
    title,
    detail,
  }: {
    id: string;
    kind: OneLocationActivityKind;
    occurredAt?: string | null;
    title: string;
    detail: string;
  }) => {
    const timestamp = activityTimestamp(occurredAt);
    if (!timestamp || !isDateInActivityRange(timestamp, range)) return;
    events.push({ id, kind, occurredAt: timestamp, title, detail });
  };

  for (const grant of state.ownerGrants) {
    const startedAt = grant.createdAt || grant.updatedAt || grant.expiresAt;
    addEvent({
      id: `owner-grant-created:${grant.id}`,
      kind: "share",
      occurredAt: startedAt,
      title: `Shared with ${grantCounterpartyLabel(grant)}`,
      detail: `${grant.status} - ${formatDateTime(startedAt)} - ${grant.durationHours}h`,
    });
    if (grant.status !== "active") {
      const stoppedAt = grant.revokedAt || grant.updatedAt || grant.expiresAt;
      addEvent({
        id: `owner-grant-stopped:${grant.id}`,
        kind: "share",
        occurredAt: stoppedAt,
        title: `Sharing stopped with ${grantCounterpartyLabel(grant)}`,
        detail: `${grant.status} - ${formatDateTime(stoppedAt)}`,
      });
    }
  }

  for (const grant of state.receivedGrants) {
    const startedAt = grant.createdAt || grant.updatedAt || grant.expiresAt;
    addEvent({
      id: `received-grant:${grant.id}`,
      kind: "share",
      occurredAt: startedAt,
      title: `Location shared by ${receivedGrantOwnerLabel(grant)}`,
      detail: `${grant.status} - ${formatDateTime(startedAt)}`,
    });
  }

  for (const request of state.requests) {
    if (request.ownerUserId === currentUserId) {
      addEvent({
        id: `request-received:${request.id}`,
        kind: "request",
        occurredAt: request.requestedAt,
        title: `Request from ${requestLabel(request)}`,
        detail: `${request.status} - ${formatDateTime(request.requestedAt)}`,
      });
    } else if (request.requesterUserId === currentUserId) {
      addEvent({
        id: `request-sent:${request.id}`,
        kind: "request",
        occurredAt: request.requestedAt,
        title: `Request sent to ${labelForUser(request.ownerUserId)}`,
        detail: `${request.status} - ${formatDateTime(request.requestedAt)}`,
      });
    }
    if (request.resolvedAt) {
      addEvent({
        id: `request-resolved:${request.id}`,
        kind: "request",
        occurredAt: request.resolvedAt,
        title:
          request.ownerUserId === currentUserId
            ? `Request decided for ${requestLabel(request)}`
            : `Request update from ${labelForUser(request.ownerUserId)}`,
        detail: `${request.status} - ${formatDateTime(request.resolvedAt)}`,
      });
    }
  }

  for (const invite of state.publicInvites) {
    addEvent({
      id: `public-link-created:${invite.id}`,
      kind: "public",
      occurredAt: invite.createdAt || invite.updatedAt || invite.expiresAt,
      title: "Request link created",
      detail: `${invite.status} - expires ${formatDateTime(invite.expiresAt)}`,
    });
    if (invite.status !== "active") {
      const closedAt = invite.revokedAt || invite.updatedAt || invite.expiresAt;
      addEvent({
        id: `public-link-closed:${invite.id}`,
        kind: "public",
        occurredAt: closedAt,
        title: "Request link closed",
        detail: `${invite.status} - ${formatDateTime(closedAt)}`,
      });
    }
  }

  for (const submission of state.publicInviteSubmissions) {
    addEvent({
      id: `public-response:${submission.id}`,
      kind: "public",
      occurredAt: submission.submittedAt || submission.resolvedAt,
      title: `Response from ${publicSubmissionLabel(submission)}`,
      detail: `${submission.requestStatus || submission.status} - ${formatDateTime(
        submission.submittedAt,
      )}`,
    });
    if (submission.resolvedAt) {
      addEvent({
        id: `public-response-resolved:${submission.id}`,
        kind: "public",
        occurredAt: submission.resolvedAt,
        title: `Response decided for ${publicSubmissionLabel(submission)}`,
        detail: `${submission.requestStatus || submission.status} - ${formatDateTime(
          submission.resolvedAt,
        )}`,
      });
    }
  }

  const buckets = new Map<
    string,
    OneLocationActivityBucket & { sortValue: number }
  >();
  for (const event of events) {
    const date = parseActivityDate(event.occurredAt);
    if (!date) continue;
    const key = activityBucketKey(date, range);
    const bucket =
      buckets.get(key) ||
      ({
        key,
        label: activityBucketLabel(date, range),
        sortValue: activityBucketStartValue(date, range),
        shares: 0,
        requests: 0,
        views: 0,
        publicActivity: 0,
        total: 0,
      } satisfies OneLocationActivityBucket & { sortValue: number });
    if (event.kind === "share") bucket.shares += 1;
    if (event.kind === "request") bucket.requests += 1;
    if (event.kind === "public") bucket.publicActivity += 1;
    bucket.total += 1;
    buckets.set(key, bucket);
  }

  const sharedWithCount = new Set(
    state.ownerGrants
      .filter((grant) =>
        isDateInActivityRange(
          grant.createdAt || grant.updatedAt || grant.expiresAt,
          range,
        ),
      )
      .map((grant) => grant.recipientUserId),
  ).size;
  const sortedEvents = [...events].sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const sortedBuckets = [...buckets.values()]
    .sort((a, b) => a.sortValue - b.sortValue)
    .slice(-8)
    .map(({ sortValue: _sortValue, ...bucket }) => bucket);

  return {
    range,
    events: sortedEvents,
    buckets: sortedBuckets,
    summary: {
      sharedWithCount,
      activeShareCount: state.ownerGrants.filter(
        (grant) => grant.status === "active",
      ).length,
      requestsReceivedCount: state.requests.filter(
        (request) =>
          request.ownerUserId === currentUserId &&
          isDateInActivityRange(request.requestedAt, range),
      ).length,
      requestsSentCount: state.requests.filter(
        (request) =>
          request.requesterUserId === currentUserId &&
          request.ownerUserId !== currentUserId &&
          isDateInActivityRange(request.requestedAt, range),
      ).length,
      viewsCount: 0,
      publicLinkCount: state.publicInvites.filter((invite) =>
        isDateInActivityRange(
          invite.createdAt || invite.updatedAt || invite.expiresAt,
          range,
        ),
      ).length,
      publicResponseCount: state.publicInviteSubmissions.filter((submission) =>
        isDateInActivityRange(
          submission.submittedAt || submission.resolvedAt,
          range,
        ),
      ).length,
      totalEvents: sortedEvents.length,
    },
  };
}
