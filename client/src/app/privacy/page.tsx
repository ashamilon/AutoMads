import type { Metadata } from "next";
import { LandingNav } from "../_landing/nav";
import { LandingFooter } from "../_landing/footer";
import { AnimatedBg } from "../_landing/animated-bg";
import { SUPPORT_EMAIL, WHATSAPP_NUMBER_DISPLAY, buildWhatsAppUrl } from "@/lib/contact";

// Marketing-site Privacy Policy. The same URL is referenced from the Meta App
// Dashboard → App settings → Basic → Privacy Policy URL, so this page MUST
// remain reachable on https://dashboard.pipwarp.com/privacy at all times —
// otherwise Meta will eventually flag the app and disable Login.
//
// This is a starting-point policy that covers the practical realities of how
// AutoMads (your platform) actually handles data:
//   • Tenant-supplied catalog + customer messages (tenant-controlled data)
//   • Page access tokens stored at rest (tenant-controlled credentials)
//   • Self-hosted LLM (no third-party LLM forwarding)
//   • Cloudinary / SSLCommerz / courier partners as sub-processors
//
// Replace the YOUR_LEGAL_NAME / address placeholders before publishing
// publicly. Keep section structure intact — it's intentionally aligned to
// what Meta + GDPR + Bangladesh's DPA reviewers look for.

export const metadata: Metadata = {
  title: "Privacy Policy — AutoMads",
  description:
    "How AutoMads collects, uses, stores, and shares information you provide to operate your business automation workspace.",
};

const LAST_UPDATED = "May 29, 2026";

export default function PrivacyPage() {
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
              Privacy Policy
            </h1>
            <p className="mt-4 text-sm text-slate-400">
              Last updated: {LAST_UPDATED}
            </p>
          </header>

          <div className="prose prose-invert prose-slate max-w-none space-y-8 text-[15px] leading-relaxed text-slate-300">
            <section>
              <h2 className="text-xl font-semibold text-white">1. Who we are</h2>
              <p>
                AutoMads (&ldquo;<strong>we</strong>&rdquo;, &ldquo;
                <strong>our</strong>&rdquo;, or &ldquo;<strong>the platform</strong>
                &rdquo;) provides a multi-tenant business-automation
                workspace that helps merchants reply to messages, manage orders,
                publish content, and analyse customer activity across Facebook
                Pages, Instagram Business accounts, and supported couriers.
              </p>
              <p>
                This policy describes what information we collect when you (a
                business owner) use our platform, when your customers interact
                with the bots and posts you publish through us, and how we
                share that information with third parties to deliver the
                service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                2. Information we collect
              </h2>
              <h3 className="mt-4 text-base font-semibold text-slate-100">
                2.1 Account information
              </h3>
              <p>
                When you create a workspace we collect: your business name,
                contact email, password (stored as a one-way hash), preferred
                language, business category, and any contact details you
                voluntarily add to your profile.
              </p>

              <h3 className="mt-4 text-base font-semibold text-slate-100">
                2.2 Connected channel data
              </h3>
              <p>
                When you connect a Facebook Page or Instagram Business account
                through our &ldquo;Connect with Facebook&rdquo; flow, Meta
                provides us with: a Page Access Token, the Page id and name,
                the linked Instagram Business Account id (if any), and the
                permissions you granted. We store these securely on the
                workspace record so we can act on your behalf when you ask us
                to (e.g.&nbsp;reply to a customer, publish a post). We never
                see your Facebook password.
              </p>

              <h3 className="mt-4 text-base font-semibold text-slate-100">
                2.3 Customer interaction data
              </h3>
              <p>
                When a customer messages your Page, comments on your post, or
                completes an order through our automation, we receive and
                store the message contents, attachments, the customer&rsquo;s
                Messenger PSID (a Page-scoped identifier provided by Meta),
                and any structured information they share (name, phone,
                delivery address) so we can fulfil the order. This data is
                stored in your workspace and is not visible to other
                workspaces.
              </p>

              <h3 className="mt-4 text-base font-semibold text-slate-100">
                2.4 Catalog and operational data
              </h3>
              <p>
                The catalog images, product names, prices, add-ons, size
                charts, and other operational settings you upload to your
                workspace are stored on our infrastructure and on Cloudinary
                (for media). They are used solely to power your bot replies
                and your dashboard.
              </p>

              <h3 className="mt-4 text-base font-semibold text-slate-100">
                2.5 Telemetry &amp; logs
              </h3>
              <p>
                We log API requests, conversation snapshots (for replay /
                debugging), and basic application metrics (response time,
                error rate). Sensitive fields (tokens, passwords, secrets) are
                redacted before logs are written.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                3. How we use your information
              </h2>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>
                  Operate the bot: read inbound messages, generate responses,
                  send replies, schedule follow-ups, publish posts, and book
                  couriers on your behalf.
                </li>
                <li>
                  Run analytics inside your dashboard so you can see
                  conversion, payment status breakdowns, and customer cohort
                  data — visible only to your workspace.
                </li>
                <li>
                  Bill subscriptions through SSLCommerz and surface invoices.
                </li>
                <li>
                  Detect abuse, debug failures, and improve reliability.
                </li>
                <li>
                  Comply with legal obligations (e.g.&nbsp;tax records,
                  fraud-prevention, lawful information requests).
                </li>
              </ul>
              <p>
                We do <strong>not</strong> sell your data, your
                customers&rsquo; data, or your conversation contents to anyone.
                We do not use your data to train third-party AI models. The
                agent that drafts replies runs on infrastructure we control or
                self-host.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                4. Sub-processors and third parties
              </h2>
              <p>
                To deliver the service we share the minimum necessary data
                with the following providers:
              </p>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>
                  <strong>Meta Platforms</strong> (Facebook, Instagram) — to
                  send and receive messages, publish posts, and read public
                  Page data via the Graph API.
                </li>
                <li>
                  <strong>Cloudinary</strong> — image hosting for catalog
                  photos.
                </li>
                <li>
                  <strong>SSLCommerz, AamarPay, bKash</strong> — payment
                  processing for orders and subscriptions.
                </li>
                <li>
                  <strong>Pathao, Steadfast</strong> — courier integrations
                  for shipment booking when you opt in.
                </li>
                <li>
                  <strong>Cloudflare</strong> — DNS, DDoS protection, and
                  edge caching for our domains.
                </li>
                <li>
                  <strong>PostgreSQL hosting</strong> — managed database for
                  workspace storage.
                </li>
              </ul>
              <p>
                Each sub-processor is bound by their own contractual and legal
                obligations to keep the data confidential.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                5. Data retention
              </h2>
              <p>
                We retain workspace data (catalog, settings, orders,
                conversations) for as long as your workspace is active.
                Conversation logs older than 12 months may be summarised and
                truncated to control storage. Closed workspaces are anonymised
                or deleted within 90 days, except where we are required to
                keep records for legal reasons (e.g.&nbsp;tax invoices, refund
                disputes).
              </p>
              <p>
                You can request export or deletion of your workspace data at
                any time by writing to{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-indigo-400 hover:underline">
                  {SUPPORT_EMAIL}
                </a>
                . Customer-side data deletion (so a customer who messaged your
                Page can be forgotten) is also supported on request.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                6. Security
              </h2>
              <p>
                Page access tokens, payment-gateway secrets, and other
                credentials are stored encrypted at rest using AES-256 with a
                key held only on the application server. All HTTP traffic is
                served over HTTPS with HSTS. Webhook payloads from Meta are
                verified using the {`x-hub-signature-256`} header before being
                processed. Access to the production database and secret
                manager is restricted to authorised personnel.
              </p>
              <p>
                No system is perfectly secure. If we ever discover a breach
                that affects your workspace data, we will notify you within 72
                hours and explain what happened, what we&rsquo;ve done, and
                what you should do.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                7. Your rights
              </h2>
              <p>
                Depending on where you and your customers are located you may
                have the right to access, rectify, export, or delete the
                personal information we hold about you. To exercise any of
                these rights, email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-indigo-400 hover:underline">
                  {SUPPORT_EMAIL}
                </a>{" "}
                or message us on WhatsApp at{" "}
                <a
                  href={buildWhatsAppUrl()}
                  target="_blank"
                  rel="noopener"
                  className="text-indigo-400 hover:underline"
                >
                  {WHATSAPP_NUMBER_DISPLAY}
                </a>
                . We respond to requests within 30 days.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                8. Children
              </h2>
              <p>
                Our platform is not directed to children under 13 (or the
                local age of digital consent where higher). If you believe a
                child has provided us with personal information, contact us
                and we&rsquo;ll delete it.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                9. Changes to this policy
              </h2>
              <p>
                When we update this policy we revise the &ldquo;Last
                updated&rdquo; date at the top. Material changes will be
                announced inside the dashboard and by email to workspace
                owners at least 14 days before they take effect.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                10. Contact us
              </h2>
              <p>
                For any privacy questions:{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="text-indigo-400 hover:underline">
                  {SUPPORT_EMAIL}
                </a>
                <br />
                WhatsApp:{" "}
                <a
                  href={buildWhatsAppUrl()}
                  target="_blank"
                  rel="noopener"
                  className="text-indigo-400 hover:underline"
                >
                  {WHATSAPP_NUMBER_DISPLAY}
                </a>
              </p>
            </section>
          </div>
        </main>
        <LandingFooter />
      </div>
    </div>
  );
}
