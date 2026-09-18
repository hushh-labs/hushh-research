import { NextRequest } from "next/server";

import { proxyExternalConnectorRequest } from "./_proxy";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return proxyExternalConnectorRequest(request, []);
}
