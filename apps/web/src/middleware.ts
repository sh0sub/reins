import { NextResponse, type NextRequest } from "next/server";

/**
 * #2 per-visitor playground: every real visit of /try starts a fresh playground scope (cookie reins_try, read by
 * POST /api/try). The judge tour then always shows the scripted outcomes ($12.98 paid, $59 waits, $450 denied, five
 * $29 = paid then denied), however many judges or earlier runs came before. Router prefetches keep the current scope.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (req.method !== "GET" || req.headers.get("next-router-prefetch") || req.headers.get("purpose") === "prefetch") return res;
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  res.cookies.set("reins_try", id, { path: "/", httpOnly: true, sameSite: "strict", maxAge: 86_400, secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" });
  return res;
}

export const config = { matcher: ["/try"] };
