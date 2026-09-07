import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/eula",
  "/privacy",
  "/sms-consent",
  "/api/logo",
  "/api/marketing/brand-assets",
  "/portal/",
  "/investors",
  "/api/proxy/portal",
  "/api/proxy/marketing/brand-assets",
  // Partner invitations. The token in the URL is the credential, so these are
  // reached before the invitee has an account — guarding them bounces the
  // whole invite flow to /login and there is no way to set a password.
  "/invite/",
  "/api/proxy/partners/invites/token/",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow Next.js internals and static assets through
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon.ico") ||
    pathname.startsWith("/icon.svg") ||
    pathname.startsWith("/public")
  ) {
    return NextResponse.next();
  }

  // Check for next-auth session cookie (set by JWT strategy)
  const sessionCookie =
    request.cookies.get("next-auth.session-token") ??
    request.cookies.get("__Secure-next-auth.session-token");

  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
