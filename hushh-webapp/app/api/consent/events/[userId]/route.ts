import { proxyConsentStream } from "@/app/api/_utils/consent-stream-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  return proxyConsentStream(request, (await params).userId, "events");
}
