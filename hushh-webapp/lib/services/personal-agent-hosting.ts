import type { PersonalAgentStatus } from "@/lib/services/personal-agent-status";

type OwnerFetch = (path: string, options: RequestInit) => Promise<Response>;

async function readOwnerHosting(
  token: string | undefined,
  fetchOwner: OwnerFetch,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchOwner(path, {
    method: "GET",
    cache: "no-store",
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok)
    throw new Error(`AGENT_STATUS_UNAVAILABLE:${response.status}`);
  return response.json();
}

export async function readPersonalAgentStatus(
  token: string | undefined,
  fetchOwner: OwnerFetch,
  options?: { signal?: AbortSignal },
): Promise<PersonalAgentStatus> {
  return (await readOwnerHosting(
    token,
    fetchOwner,
    "/api/one/personal-agent/status",
    options?.signal,
  )) as PersonalAgentStatus;
}

export async function readCloudRemovalAvailability(
  token: string | undefined,
  fetchOwner: OwnerFetch,
  options?: { signal?: AbortSignal },
) {
  const data = (await readOwnerHosting(
    token,
    fetchOwner,
    "/api/one/personal-agent/removal",
    options?.signal,
  )) as Record<string, unknown> | null;
  if (
    typeof data?.available !== "boolean" ||
    (data.provider !== null &&
      data.provider !== "gcp" &&
      data.provider !== "azure") ||
    (data.available && !data.provider)
  )
    throw new Error("CLOUD_REMOVAL_UNAVAILABLE");
  return data as { available: boolean; provider: "gcp" | "azure" | null };
}

export type HostingInspection = {
  status:
    | "connected"
    | "starting"
    | "absent"
    | "unverified"
    | "ownership_unverified"
    | "cleanup_pending";
  previousHomes: number;
  needsPreviousReview: boolean;
};
export async function readHostingInspection(
  token: string | undefined,
  fetchOwner: OwnerFetch,
): Promise<HostingInspection> {
  const data = (await readOwnerHosting(
    token,
    fetchOwner,
    "/api/one/personal-agent/hosting/inspection",
  )) as Record<string, unknown> | null;
  const states = [
    "connected",
    "starting",
    "absent",
    "unverified",
    "ownership_unverified",
    "cleanup_pending",
  ];
  if (
    !data ||
    !states.includes(String(data.status)) ||
    !Number.isInteger(data.previousHomes) ||
    Number(data.previousHomes) < 0 ||
    Number(data.previousHomes) > 32 ||
    typeof data.needsPreviousReview !== "boolean"
  )
    throw new Error("HOSTING_INSPECTION_UNAVAILABLE");
  return data as HostingInspection;
}
