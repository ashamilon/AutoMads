import type { Metadata } from "next";
import { LandingNav } from "../_landing/nav";
import { LandingFooter } from "../_landing/footer";
import { AnimatedBg } from "../_landing/animated-bg";
import { SUPPORT_EMAIL, WHATSAPP_NUMBER_DISPLAY, buildWhatsAppUrl } from "@/lib/contact";

// Data Deletion Instructions page — required by Meta App Review (App settings
// → Basic → "User data deletion → Data deletion instructions URL"). Meta
// expects a publicly reachable URL that explains:
//   1. What data the platform stores about a user
//   2. How a user can request its deletion
//   3. How quickly we honour the request
// Keep this page reachable at https://dashboard.pipwarp.com/data-deletion
// — Meta probes the URL periodically and will flag the app if it 404s.

export const metadata: Metadata = {
  title: "Data Deletion — AutoMads",
  description:
    "How to request deletion of your personal data, customer data, or workspace data from AutoMads.",
};

const LAST_UPDATED = "May 29, 2026";

export default function DataDeletionPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <AnimatedBg />
      <div className="relative">
        <LandingNav />
        <main className="mx-auto max-w-3xl px-6 pt-32 pb-20">
          <header className="mb-12 border-b border-white/[0.06] pb-8">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
              Legal
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">
              Data Deletion Instructions
            </h1>
            <p className="mt-4 text-sm text-slate-400">
              Last updated: {LAST_UPDATED}
            </p>
          </header>

          <div className="prose prose-invert prose-slate max-w-none space-y-8 text-[15px] leading-relaxed text-slate-300">
            <section>
              <h2 className="text-xl font-semibold text-white">
                What this page is for
              </h2>
              <p>
                This page tells you exactly how to ask us to delete the data
                we hold about you, your business, or your customers. It
                applies whether you are:
              </p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>A merchant who created a workspace on AutoMads</li>
                <li>
                  A customer who messaged a Facebook Page that is connected
                  to AutoMads
                </li>
                <li>
                  Someone who tested the platform via &ldquo;Login with
                  Facebook&rdquo; and changed their mind
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                What we delete on request
              </h2>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>
                  <strong>Account &amp; workspace</strong> — your profile,
                  settings, billing history, catalog data, scheduled posts,
                  and webhook configurations.
                </li>
                <li>
                  <strong>Customer data</strong> — message history,
                  conversation snapshots, contact details, order records, and
                  customer profile entries.
                </li>
                <li>
                  <strong>Connected channel artefacts</strong> — saved
                  Facebook Page tokens, Instagram Business Account ids, and
                  any cached metadata from those channels.
                </li>
                <li>
                  <strong>Logs and telemetry</strong> — request logs and
                  conversation traces tied to your workspace, where
                  technically feasible.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                What we may have to keep
              </h2>
              <p>
                Some records are kept for legal, tax, or fraud-prevention
                reasons even after deletion. Specifically:
              </p>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>
                  Subscription invoices and tax records — kept for 7 years
                  per Bangladesh tax law.
                </li>
                <li>
                  Anonymised, aggregate usage statistics that cannot be
                  linked back to you.
                </li>
                <li>
                  Information we are required to retain by court order or
                  ongoing legal investigation.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                How to request deletion
              </h2>
              <p>
                Choose whichever channel is easiest. We treat all requests
                the same — email, WhatsApp, or in-dashboard contact form all
                land in the same queue.
              </p>

              <div className="mt-4 space-y-4">
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
                  <h3 className="text-sm font-semibold text-white">Option 1 — Email</h3>
                  <p className="mt-2 text-sm">
                    Send an email to{" "}
                    <a
                      href={`mailto:${SUPPORT_EMAIL}?subject=Data%20Deletion%20Request`}
                      className="text-indigo-400 hover:underline"
                    >
                      {SUPPORT_EMAIL}
                    </a>{" "}
                    with the subject line &ldquo;Data Deletion Request&rdquo;.
                    Include:
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    <li>The email or workspace name on your account</li>
                    <li>
                      If you&rsquo;re a customer rather than a merchant, the
                      Facebook Page you contacted and your name as it appears
                      in Messenger
                    </li>
                    <li>What you want deleted (everything, just messages, just contact info, etc.)</li>
                  </ul>
                </div>

                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
                  <h3 className="text-sm font-semibold text-white">Option 2 — WhatsApp</h3>
                  <p className="mt-2 text-sm">
                    Message us at{" "}
                    <a
                      href={buildWhatsAppUrl(
                        "Hi, I'd like to request data deletion from my AutoMads account.",
                      )}
                      target="_blank"
                      rel="noopener"
                      className="text-indigo-400 hover:underline"
                    >
                      {WHATSAPP_NUMBER_DISPLAY}
                    </a>
                    . Mention &ldquo;data deletion&rdquo; in your first
                    message and we&rsquo;ll respond within one business day.
                  </p>
                </div>

                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
                  <h3 className="text-sm font-semibold text-white">
                    Option 3 — Self-serve from the dashboard
                  </h3>
                  <p className="mt-2 text-sm">
                    Merchants can also delete their workspace directly from{" "}
                    <strong>Settings → Account → Delete workspace</strong>.
                    This triggers the same backend deletion flow and emails
                    you a confirmation when it&rsquo;s done.
                  </p>
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                How long deletion takes
              </h2>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>
                  <strong>Within 24 hours</strong> — your workspace is marked
                  for deletion and the bot stops responding on connected
                  channels.
                </li>
                <li>
                  <strong>Within 30 days</strong> — all live records are
                  removed from our primary database.
                </li>
                <li>
                  <strong>Within 90 days</strong> — backups containing your
                  data are rotated out and become unrecoverable.
                </li>
              </ul>
              <p>
                We&rsquo;ll send you a confirmation email when the deletion
                is complete.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                Disconnecting Facebook without deleting your account
              </h2>
              <p>
                If you only want to revoke our access to your Facebook Page
                but keep your AutoMads workspace, you don&rsquo;t need to
                request deletion. Use one of these:
              </p>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>
                  Inside AutoMads: <strong>Settings → Pages → Disconnect</strong>
                </li>
                <li>
                  On Facebook:{" "}
                  <a
                    href="https://www.facebook.com/settings?tab=business_tools"
                    target="_blank"
                    rel="noopener"
                    className="text-indigo-400 hover:underline"
                  >
                    Settings &amp; privacy → Business integrations
                  </a>{" "}
                  &rarr; find AutoMads &rarr; Remove
                </li>
              </ul>
              <p>
                Either of those revokes our Page access token immediately.
                The bot stops replying within minutes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                Contact
              </h2>
              <p>
                Questions about this process or worried we missed something?{" "}
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="text-indigo-400 hover:underline"
                >
                  {SUPPORT_EMAIL}
                </a>{" "}
                or{" "}
                <a
                  href={buildWhatsAppUrl()}
                  target="_blank"
                  rel="noopener"
                  className="text-indigo-400 hover:underline"
                >
                  WhatsApp {WHATSAPP_NUMBER_DISPLAY}
                </a>
                . We&rsquo;ll respond within one business day.
              </p>
            </section>
          </div>
        </main>
        <LandingFooter />
      </div>
    </div>
  );
}
