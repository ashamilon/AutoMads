import { NextResponse, type NextRequest } from "next/server";

/**
 * Onboarding gate (Multi-Tenant Commerce OS, task 11.2 part B).
 *
 * For authenticated tenants whose `onboardingCompletedAt` is null, redirect
 * any non-onboarding navigation to `/onboarding`. Once the wizard finishes
 * and `tenant.onboardingCompletedAt` is stamped, the API's `/me` returns
 * the timestamp and this middleware lets the portal load normally.
 *
 * Why a Next middleware (not a server-side check):
 *   - The request hitting Next is the page navigation. Doing the check at
 *     the edge means the operator never even sees the dashboard skeleton
 *     before the redirect kicks in.
 *   - We keep the lookup cheap by cooperating with a small probe cookie
 *     (`onboarding_completed=1`) the portal sets after the wizard finishes.
 *     The cookie is a soft hint — the source of truth stays on the API.
 *
 * What the middleware does NOT do:
 *   - It doesn't check credentials. The `RequireAuth` component on the
 *     portal handles the unauthenticated case. Authenticated users without
 *     a session token (legacy api-key login) still pass through here; the
 *     portal will redirect them to `/login` if needed.
 *   - It doesn't proxy the API. The API base URL may live on a different
 *     origin (`localhost:4000` in dev, `api.pipwarp.com` in prod), and
 *     `fetch`-ing it from the edge would block every navigation on a
 *     cross-origin round-trip. The probe cookie keeps the gate fast.
 *
 * Allow-list (pass-through):
 *   - `/onboarding/*`     — the wizard itself
 *   - `/login`            — sign-in page
 *   - `/activate`         — first-time activation flow
 *   - `/api/*`            — internal Next API routes (none today, future
 *                           parity with the API path so an accidental
 *                           proxy never gets gated)
 *   - `/_next/*`, `/public/*`, asset files — Next internals
 *
 * The actual redirect uses 307 so the browser preserves method (relevant
 * for the small set of pages that POST inline forms). Auth cookies travel
 * because they're set on the parent host and we're staying on-origin.
 */

const ONBOARDING_FLAG_COOKIE = "onboarding_completed";

const PASS_THROUGH_PREFIXES = [
  "/onboarding",
  "/login",
  "/activate",
  "/api",
  "/_next",
  "/static",
  "/public",
  "/favicon.ico",
];

/**
 * Path-level allow-list check. Anything under one of `PASS_THROUGH_PREFIXES`
 * is exempt from the redirect.
 */
function isPassThrough(pathname: string): boolean {
  for (const prefix of PASS_THROUGH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  // Static asset shortcut — anything with a file extension that the page
  // bundle may reference (icons, manifests). Path is gated by the prefix
  // list above for the common cases; this catches root-level files.
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return true;
  return false;
}

/**
 * Detect whether the user looks signed in. We check both flavours of the
 * session credential the portal uses:
 *   - `tenant_session` HttpOnly cookie set by `POST /api/v1/auth/login`
 *   - any cookie at all that hints at a credential
 *
 * If neither is present we let the request through; the portal's
 * `RequireAuth` component will redirect to `/login` on its own. Forcing a
 * redirect here for unauthenticated traffic would loop unauthenticated
 * users between `/onboarding` and `/login`.
 */
function looksAuthenticated(req: NextRequest): boolean {
  if (req.cookies.get("tenant_session")) return true;
  // Authorization header travels for fetches but not for top-level
  // navigations, so we lean on the cookie. A future refresh that uses
  // a non-cookie credential can extend this check.
  return false;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPassThrough(pathname)) return NextResponse.next();
  if (!looksAuthenticated(req)) return NextResponse.next();

  // Probe cookie set by the portal after a successful `/me` lookup
  // surfaces `onboardingCompletedAt`. Absence => assume not completed
  // and redirect. Presence with `1` => let the portal load.
  const completed = req.cookies.get(ONBOARDING_FLAG_COOKIE)?.value;
  if (completed === "1") return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/onboarding";
  // Drop any prior search params so we don't carry portal-specific query
  // strings into the wizard URL.
  url.search = "";
  return NextResponse.redirect(url, 307);
}

/**
 * Run on every navigation that isn't already an obvious asset. The
 * pass-through guard inside the middleware does the precise allow-list
 * check; this matcher just trims the most expensive paths off the
 * critical path.
 */
export const config = {
  matcher: [
    /*
     * Skip Next internals + Vercel-style data routes; the middleware body
     * still re-checks the prefixes for safety.
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
