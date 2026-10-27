import { handleEmailUnsubscribe } from "@/app/api/_utils/plg-email-unsubscribe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };
export async function GET(request: Request, context: Context) {
  return handleEmailUnsubscribe(request, (await context.params).token);
}
export async function POST(request: Request, context: Context) {
  return handleEmailUnsubscribe(request, (await context.params).token);
}
