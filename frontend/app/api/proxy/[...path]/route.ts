import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

const API_URL = process.env.API_URL ?? "http://api:8000/api";

async function forward(req: NextRequest, params: { path: string[] }) {
  const path = params.path.join("/");
  const search = req.nextUrl.search;
  const url = `${API_URL}/${path}${search}`;

  const session = await getServerSession(authOptions);

  const contentType = req.headers.get("Content-Type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  const forwardHeaders: Record<string, string> = isMultipart
    ? { "Content-Type": contentType }
    : { "Content-Type": "application/json" };

  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (internalSecret) forwardHeaders["X-Internal-Secret"] = internalSecret;

  if (session?.user) {
    const u = session.user as { id?: string; email?: string; name?: string; role?: string };
    if (u.email) forwardHeaders["X-User-Email"] = u.email;
    if (u.id) forwardHeaders["X-User-Id"] = u.id;
    if (u.role) forwardHeaders["X-User-Role"] = u.role;
  }

  // Forward portal session token for password-protected portals
  const portalSession = req.headers.get("X-Portal-Session");
  if (portalSession) forwardHeaders["X-Portal-Session"] = portalSession;

  // "View as" preview. The cookie only names a target; the API decides whether
  // this caller may impersonate it, that the target really is a partner, and
  // that the request is a read. Nothing is trusted on this side, so a user
  // setting the cookie by hand gains nothing.
  const viewAs = req.cookies.get("openerp_view_as")?.value;
  if (viewAs) forwardHeaders["X-View-As"] = viewAs;

  // Carry the visitor's address through. Without this the API only ever sees
  // this container, so portal rate limiting would treat every visitor as one
  // host and the access log would record a container IP for every download.
  const rangeHeader = req.headers.get("Range");
  if (rangeHeader) forwardHeaders["Range"] = rangeHeader;

  const clientIp = req.headers.get("X-Client-IP");
  const forwardedFor = req.headers.get("X-Forwarded-For");
  const realIp = req.headers.get("X-Real-IP");
  if (clientIp) forwardHeaders["X-Client-IP"] = clientIp;
  if (forwardedFor) forwardHeaders["X-Forwarded-For"] = forwardedFor;
  if (realIp) forwardHeaders["X-Real-IP"] = realIp;

  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (isMultipart) {
      init.body = await req.arrayBuffer();
    } else {
      const body = await req.text();
      if (body) init.body = body;
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // ECONNREFUSED / ENOTFOUND — API container temporarily unreachable (e.g. restart)
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("fetch failed")) {
      return new NextResponse(JSON.stringify({ detail: "API service temporarily unavailable. Please retry." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw err;
  }
  const respContentType = upstream.headers.get("Content-Type") ?? "application/json";
  const disposition = upstream.headers.get("Content-Disposition") ?? "";

  // SSE: pipe the stream through without buffering
  if (respContentType.includes("text/event-stream")) {
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const isBinary = respContentType.includes("octet-stream") ||
    respContentType.startsWith("image/") ||
    respContentType.includes("wordprocessingml") ||
    respContentType.includes("spreadsheetml") ||
    respContentType.includes("excel") ||
    respContentType.includes("pdf");

  if (isBinary) {
    // Pipe the body through rather than buffering it. A 30 MB deck was being
    // held in memory here in full before a single byte reached the browser,
    // on top of the API doing the same — two complete copies of the file for
    // a request that can simply stream.
    const headers: Record<string, string> = { "Content-Type": respContentType };
    if (disposition) headers["Content-Disposition"] = disposition;
    for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  }

  if (upstream.status === 204 || upstream.status === 205) {
    return new NextResponse(null, { status: upstream.status });
  }

  const data = await upstream.text();
  const headers: Record<string, string> = { "Content-Type": respContentType };
  if (disposition) headers["Content-Disposition"] = disposition;
  return new NextResponse(data, { status: upstream.status, headers });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, await params);
}
export async function HEAD(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, await params);
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, await params);
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, await params);
}
export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, await params);
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, await params);
}
