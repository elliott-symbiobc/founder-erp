import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://api:8000/api";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ file_id: string }> },
) {
  const { file_id } = await params;
  const upstream = await fetch(`${API_URL}/marketing/brand-assets/${file_id}/public`, {
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return new NextResponse(null, { status: upstream.status });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
      "Cache-Control": upstream.headers.get("Cache-Control") ?? "public, max-age=31536000, immutable",
    },
  });
}

export async function HEAD(
  _req: NextRequest,
  { params }: { params: Promise<{ file_id: string }> },
) {
  const { file_id } = await params;
  const upstream = await fetch(`${API_URL}/marketing/brand-assets/${file_id}/public`, {
    cache: "no-store",
  });

  return new NextResponse(null, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
      "Cache-Control": upstream.headers.get("Cache-Control") ?? "public, max-age=31536000, immutable",
      "Content-Length": upstream.headers.get("Content-Length") ?? "",
    },
  });
}
