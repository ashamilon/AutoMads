import type { Metadata } from "next";
import { LandingNav } from "../_landing/nav";
import { LandingFooter } from "../_landing/footer";
import { AnimatedBg } from "../_landing/animated-bg";
import { SUPPORT_EMAIL, WHATSAPP_NUMBER_DISPLAY, buildWhatsAppUrl } from "@/lib/contact";

// Marketing-site Terms of Service. Mirrors the Privacy page in structure;
// referenced from Meta App Dashboard → App settings → Basic → Terms of
// Service URL. Like the privacy page, it MUST stay reachable at
// https://dashboard.pipwarp.com/terms — Meta probes both URLs periodically.

export const metadata: Metadata = {
  title: "Terms of Service — AutoMads",
  description:
    "Terms governing your use of the AutoMads business automation platform.",
};

const LAST_UPDATED = "May 29, 2026";

export default function TermsPage() {
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
              Terms of Service
            </h1>
            <p className="mt-4 text-sm text-slate-400">
              Last updated: {LAST_UPDATED}
            </p>
          </header>

          <div className="prose prose-invert prose-slate max-w-none space-y-8 text-[15px] leading-relaxed text-slate-300">
            <section>
              <h2 className="text-xl font-semibold text-white">
                1. Acceptance of these terms
              </h2>
              <p>
                By creating a workspace, connecting a Facebook Page or
                Instagram account, or otherwise using AutoMads
                (&ldquo;the platform&rdquo;) you agree to be bound by these
                Terms of Service. If you do not agree, please do not use the
                platform.
              </p>
              <p>
                These terms apply between AutoMads and the natural person or
                legal entity that owns the workspace (&ldquo;you&rdquo;).
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                2. The service
              </h2>
              <p>
                The platform is a multi-tenant business automation suite that
                helps merchants run conversational commerce on Meta-owned
                properties (Facebook Messenger, Instagram), schedule content,
                manage orders, accept payments through supported gateways,
                and book couriers for delivery. Available features depend on
                the plan you are on and may change over time.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                3. Your responsibilities
              </h2>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>
                  You are responsible for the legality of your business
                  activities and the products you sell. You will not use the
                  platform to send spam, run scams, sell counterfeit goods,
                  promote prohibited categories (firearms, illegal drugs,
                  etc.), or harass anyone.
                </li>
                <li>
                  You will comply with{" "}
                  <a
                    href="https://www.facebook.com/legal/terms"
                    target="_blank"
                    rel="noopener"
                    className="text-indigo-400 hover:underline"
                  >
                    Meta&rsquo;s Platform Terms
                  </a>
                  , the{" "}
                  <a
                    href="https://developers.facebook.com/devpolicy/"
                    target="_blank"
                    rel="noopener"
                    className="text-indigo-400 hover:underline"
                  >
                    Developer Policies
                  </a>
                  , and any community standards that apply to the channels
                  you connect.
                </li>
                <li>
                  You are responsible for the accuracy of catalog content,
                  prices, delivery promises, and refund handling. The bot
                  acts on the data you give it.
                </li>
                <li>
                  You must keep your login credentials confidential. Account
                  activity is your responsibility.
                </li>
                <li>
                  You agree not to attempt to reverse-engineer, decompile, or
                  scrape the platform; not to interfere with other workspaces;
                  and not to circumvent rate limits or access controls.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                4. Connected channels
              </h2>
              <p>
                When you connect a Facebook Page or Instagram Business
                account, you authorise us to act on your behalf on those
                channels for the purposes you select inside the dashboard
                (replying, posting, reading engagement, etc.). You can revoke
                access at any time by clicking <strong>Disconnect</strong> in
                Settings or by removing our app from{" "}
                <a
                  href="https://www.facebook.com/settings?tab=business_tools"
                  target="_blank"
                  rel="noopener"
                  className="text-indigo-400 hover:underline"
                >
                  Facebook → Settings → Business Integrations
                </a>
                . Once you disconnect, the bot will stop responding on that
                channel.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                5. Pricing &amp; payment
              </h2>
              <p>
                Subscription fees, plan tiers, and payment cycles are shown
                inside the dashboard. We bill in BDT through SSLCommerz
                unless agreed otherwise. Subscriptions auto-renew until you
                cancel from <strong>Billing → Cancel</strong>. Pro-rated
                refunds are issued for unused time on annual plans only when
                we terminate the service for reasons not caused by you.
              </p>
              <p>
                Payment-gateway fees, courier shipping fees, and any third
                party charges from sub-processors are passed through to you
                at cost.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                6. Suspension &amp; termination
              </h2>
              <p>
                We may suspend or terminate your workspace if you breach
                these terms, if Meta requires us to, if your subscription
                payment fails after the grace window, or if continued service
                would expose us or other users to legal risk. Where possible
                we will give you notice and a chance to cure the issue.
              </p>
              <p>
                You may close your workspace at any time. Closure stops
                billing for the next cycle. Data retention after closure is
                handled per the{" "}
                <a href="/privacy" className="text-indigo-400 hover:underline">
                  Privacy Policy
                </a>
                .
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                7. Intellectual property
              </h2>
              <p>
                The platform&rsquo;s software, branding, and documentation
                are owned by us. You retain ownership of the content you
                upload (catalog images, posts, brand assets). You grant us a
                worldwide, royalty-free licence to host, transmit, and
                display that content for the sole purpose of operating the
                platform on your behalf.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                8. Disclaimers
              </h2>
              <p>
                The platform is provided &ldquo;as is&rdquo;. We do our best
                to keep it secure, fast, and accurate, but we don&rsquo;t
                guarantee it will be error-free, free from interruptions, or
                compatible with every Meta API change. We rely on
                third-party services (Meta, Cloudinary, payment gateways,
                couriers) and downtime in those services may affect the
                platform.
              </p>
              <p>
                The conversational agent generates text using machine learning
                and may occasionally produce inaccurate replies. You are
                responsible for reviewing critical interactions and
                correcting the bot through the dashboard tools provided.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                9. Limitation of liability
              </h2>
              <p>
                To the maximum extent permitted by law, the platform&rsquo;s
                total aggregate liability for any claim arising out of or
                related to these terms is limited to the amount you paid us
                in the twelve months preceding the event giving rise to the
                claim. Neither party is liable for indirect, special,
                incidental, or consequential damages.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                10. Governing law
              </h2>
              <p>
                These terms are governed by the laws of the People&rsquo;s
                Republic of Bangladesh. Disputes will be resolved in the
                courts of Dhaka, Bangladesh.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                11. Changes
              </h2>
              <p>
                We may update these terms from time to time. Material changes
                will be announced in the dashboard at least 14 days before
                they take effect. Continued use after the effective date
                means you accept the changes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">
                12. Contact
              </h2>
              <p>
                Questions about these terms? Email{" "}
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="text-indigo-400 hover:underline"
                >
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
                .
              </p>
            </section>
          </div>
        </main>
        <LandingFooter />
      </div>
    </div>
  );
}
