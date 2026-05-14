"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import {
  ArrowRight,
  Book,
  Cable,
  HelpCircle,
  Key,
  LifeBuoy,
  MessageCircle,
  Package,
} from "lucide-react";
import Link from "next/link";

const sections = [
  {
    icon: Key,
    title: "Sign-in & API keys",
    body: "You sign in with the tenant API key (sk_live_…) issued by your operator. It is kept in browser session storage only for this tab. If you lose the key, ask for a regenerate from the admin.",
  },
  {
    icon: MessageCircle,
    title: "Messenger flow",
    body: "Customers message your Facebook Page. The platform parses intent (Banglish/English), validates required fields, syncs to your integration (API / DB / webhook), then sends an SSLCommerz payment link. Courier booking only runs after payment is verified.",
  },
  {
    icon: Book,
    title: "Catalog mapping",
    body: "Use Catalog map to tie Messenger-friendly labels to your internal SKUs. Optional JSON metadata can carry price hints or variants for your own ops.",
  },
  {
    icon: LifeBuoy,
    title: "Getting help",
    body: "Webhook URLs and integration mode live under Integration. For SSLCommerz or Meta errors, check credentials and that PUBLIC_BASE_URL / tunnel matches what Meta and SSLCommerz expect.",
  },
];

const quickLinks = [
  { href: "/portal/orders", label: "View orders", icon: MessageCircle },
  { href: "/portal/catalog", label: "Map a SKU", icon: Package },
  { href: "/portal/integration", label: "Webhook URLs", icon: Cable },
];

export default function HelpPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <HelpCircle className="h-3.5 w-3.5" /> Knowledge base
          </>
        }
        title="Help"
        description="Quick reference for merchant teams using this portal."
      />

      <Section title="Quick links">
        <div className="grid gap-3 sm:grid-cols-3">
          {quickLinks.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 transition hover:border-white/[0.13] hover:bg-white/[0.05]"
            >
              <span className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-500/15 text-indigo-200">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-sm font-medium text-slate-200">{label}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-indigo-300" />
            </Link>
          ))}
        </div>
      </Section>

      <div className="grid gap-5 md:grid-cols-2">
        {sections.map(({ icon: Icon, title, body }) => (
          <article
            key={title}
            className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.04] to-transparent p-6 shadow-card"
          >
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04] text-accent-bright ring-1 ring-indigo-400/20">
              <Icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 font-display text-base font-semibold text-white">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
