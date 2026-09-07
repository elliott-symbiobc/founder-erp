import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";

/**
 * The gate in front of JupyterLab.
 *
 * Traefik calls this before every request to /jupyter — pages, API calls and
 * the kernel websocket alike — and forwards the request only on a 2xx. So the
 * platform session is the credential for Lab, and Jupyter's own token is off:
 * one login, and no token sitting in an iframe URL where a bookmark or a
 * referrer could carry it somewhere else.
 *
 * ForwardAuth sends the ORIGINAL request's headers, including the session
 * cookie, which is what makes reading the session here work at all.
 *
 * This runs on every websocket frame's handshake, not on every message, so the
 * cost is per connection rather than per keystroke.
 */
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new NextResponse("not signed in to the platform", { status: 401 });
  }
  const u = session.user as { id?: string; email?: string };
  // Passed through to Lab, which does not use them today — but a shared server
  // with no record of who is in it is one nobody can ask about later.
  return new NextResponse(null, {
    status: 200,
    headers: {
      "X-User-Email": u.email ?? "",
      "X-User-Id": u.id ?? "",
      ...(process.env.INTERNAL_API_SECRET ? { "X-Internal-Secret": process.env.INTERNAL_API_SECRET } : {}),
    },
  });
}

export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
export const PATCH = GET;
export const HEAD = GET;
