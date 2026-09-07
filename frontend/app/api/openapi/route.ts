import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

// The API's own OpenAPI document. It sits at the API root rather than under
// /api, so the generic /api/proxy route cannot reach it — hence a route of its
// own. Behind the same session check as everything else: the spec names every
// endpoint and its parameters, which is a map of the system.
const API_ROOT = (process.env.API_URL ?? "http://api:8000/api").replace(/\/api$/, "");

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  try {
    const r = await fetch(`${API_ROOT}/openapi.json`, { cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json(
        { error: `API returned ${r.status}` }, { status: 502 });
    }
    return NextResponse.json(await r.json());
  } catch (e: any) {
    return NextResponse.json(
      { error: `API unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
}
