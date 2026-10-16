import { NextRequest } from "next/server";
import { proxyEmailAuth } from "../_proxy";
export function POST(request: NextRequest) { return proxyEmailAuth(request, "request"); }
