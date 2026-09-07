import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { readFile } from "fs/promises";
import path from "path";

const API_URL = process.env.API_URL ?? "http://api:8000/api";

async function defaultLogoResponse(): Promise<NextResponse> {
  try {
    const svgPath = path.join(process.cwd(), "public", "logo.svg");
    const buf = await readFile(svgPath);
    return new NextResponse(buf, {
      status: 200,
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

// GET /api/logo — serve the current logo, falling back to the default SVG
export async function GET(_req: NextRequest) {
  try {
    const r = await fetch(`${API_URL}/settings/logo`, { cache: "no-store" });
    if (!r.ok) return defaultLogoResponse();
    const buf = await r.arrayBuffer();
    const ct = r.headers.get("Content-Type") ?? "image/png";
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  } catch {
    return defaultLogoResponse();
  }
}

// POST /api/logo — upload a new logo (auth required)
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const u = session.user as { id?: string };
  const formData = await req.formData();

  const upstream = await fetch(`${API_URL}/settings/logo`, {
    method: "POST",
    headers: { "X-User-Id": u.id ?? "", ...(process.env.INTERNAL_API_SECRET ? { "X-Internal-Secret": process.env.INTERNAL_API_SECRET } : {}) },
    body: formData,
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}

// DELETE /api/logo — reset to default
export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const u = session.user as { id?: string };

  const upstream = await fetch(`${API_URL}/settings/logo`, {
    method: "DELETE",
    headers: { "X-User-Id": u.id ?? "", ...(process.env.INTERNAL_API_SECRET ? { "X-Internal-Secret": process.env.INTERNAL_API_SECRET } : {}) },
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
