import { NextRequest } from "next/server";
import { proxyEmailAuth } from "../_proxy";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { return proxyEmailAuth(request, "capabilities"); }
