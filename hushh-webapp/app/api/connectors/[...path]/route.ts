import { NextRequest } from "next/server";

import { proxyExternalConnectorRequest } from "../_proxy";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, { params }: RouteParams) {
  const { path } = await params;
  return proxyExternalConnectorRequest(request, path);
}

export async function GET(request: NextRequest, routeParams: RouteParams) {
  return proxy(request, routeParams);
}

export async function POST(request: NextRequest, routeParams: RouteParams) {
  return proxy(request, routeParams);
}

export async function DELETE(request: NextRequest, routeParams: RouteParams) {
  return proxy(request, routeParams);
}
