"use client";

import { Button } from "@/components/ui/button";
import { getStoredApiKey } from "@/lib/api";
import { getBrandLogoUrl, getBrandNameUrl } from "@/lib/branding";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Bot,
  Cable,
  CheckCircle2,
  CreditCard,
  Github,
  MessageSquare,
  Package,
  Radio,
  Shield,
  Sparkles,
  Truck,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function LandingPage() {
  const router = useRouter();
  const brandLogoUrl = getBrandLogoUrl();
  const brandNameUrl = getBrandNameUrl();

  useEffect(() => {
    if (getStoredApiKey()) router.replace("/portal");
  }, [router]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Background layers — same vibe as dashboard */}
      <div className="pointer-events-none absolute inset-0 bg-mesh-dark" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.25]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[800px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(99,102,241,0.18),transparent)]" />

      {/* Top nav */}
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <img src={brandLogoUrl} alt="Brand logo" className="h-9 w-9 rounded-lg object-contain sm:h-10 sm:w-10 brightness-0 invert" />
          <img
            src={brandNameUrl}
            alt="Brand name"
            className="h-5 w-auto max-w-[8.5rem] object-contain sm:h-6 sm:max-w-[10rem] brightness-0 invert"
          />
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-400 md:flex">
          <a href="#features" className="transition hover:text-white">Features</a>
          <a href="#flow" className="transition hover:text-white">How it works</a>
          <a href="#stack" className="transition hover:text-white">Stack</a>
        </nav>
        <Link href="/login">
          <Button variant="secondary" className="px-4 py-2 text-sm">
            Client sign in
          </Button>
        </Link>
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-20 pt-12">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="max-w-3xl"
        >
          <span className="label-caps mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-indigo-200/90">
            <Bot className="h-3.5 w-3.5" />
            AI · Messenger · Payments · Courier
          </span>
          <h1
            className="font-display font-bold tracking-tight text-white"
            style={{
              fontSize: "clamp(2.25rem, 1.6rem + 3vw, 4rem)",
              lineHeight: 1.05,
              letterSpacing: "-0.025em",
            }}
          >
            The advanced portal for
            <br />
            <span className="text-gradient-accent">Facebook order automation</span>
          </h1>
          <p className="mt-7 max-w-2xl text-[1.05rem] font-medium leading-relaxed text-slate-400">
            Track Messenger orders, payments, and deliveries in one place. Tune catalog mappings,
            integration hooks, and defaults — built for teams that already run their own commerce
            stack.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/login">
              <Button className="gap-2 px-6 py-3 text-base">
                Open dashboard <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <a
              href="#flow"
              className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/[0.06]"
            >
              See the flow
            </a>
          </div>

          {/* Mini stats strip — mirrors dashboard KPI vibe */}
          <div className="mt-14 grid gap-3 sm:grid-cols-4">
            {[
              { v: "Real-time", l: "Order extraction" },
              { v: "Per-tenant", l: "Multi-workspace" },
              { v: "Verified", l: "Payment-first courier" },
              { v: "API · DB · Webhook", l: "Integration modes" },
            ].map((s) => (
              <div
                key={s.l}
                className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3"
              >
                <p className="text-sm font-semibold text-white">{s.v}</p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  {s.l}
                </p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Feature cards */}
        <section id="features" className="mt-24">
          <p className="label-caps mb-3">Built-in</p>
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Everything for a Messenger commerce stack
          </h2>
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.45 }}
            className="mt-8 grid gap-5 md:grid-cols-3"
          >
            {[
              {
                icon: Radio,
                tone: "from-indigo-500/20",
                title: "Live order pipeline",
                desc: "Statuses from extraction → payment → courier handoff, all visible per order.",
              },
              {
                icon: CreditCard,
                tone: "from-emerald-500/20",
                title: "SSLCommerz payments",
                desc: "Hosted payment links, IPN verification, and tran_id tracking on every order.",
              },
              {
                icon: Truck,
                tone: "from-amber-500/20",
                title: "Pathao courier",
                desc: "Parcel creation runs only after payment is verified. Token caching built in.",
              },
              {
                icon: Cable,
                tone: "from-violet-500/20",
                title: "API · DB · Webhook",
                desc: "Three integration modes per tenant. Configure cleanly from one UI.",
              },
              {
                icon: Package,
                tone: "from-sky-500/20",
                title: "Catalog mapping",
                desc: "Tie Messenger labels to your real SKUs, with optional metadata for ops.",
              },
              {
                icon: Shield,
                tone: "from-rose-500/20",
                title: "Tenant isolation",
                desc: "Per-page tokens and verify tokens. Secrets redacted in client responses.",
              },
            ].map(({ icon: Icon, title, desc, tone }) => (
              <article
                key={title}
                className={`relative overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-br ${tone} to-transparent p-6 shadow-card transition hover:border-white/[0.13]`}
              >
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.06] text-accent-bright ring-1 ring-indigo-400/20">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
              </article>
            ))}
          </motion.div>
        </section>

        {/* Flow strip */}
        <section id="flow" className="mt-24">
          <p className="label-caps mb-3">How it works</p>
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Messenger → Payment → Courier
          </h2>
          <div className="mt-8 grid gap-4 lg:grid-cols-4">
            {[
              { icon: MessageSquare, title: "Conversation", desc: "Customer messages your Page in Banglish or English." },
              { icon: Bot, title: "AI extraction", desc: "Order is parsed, validated and synced to your stack." },
              { icon: CreditCard, title: "Payment link", desc: "SSLCommerz checkout — verified by IPN before next step." },
              { icon: Truck, title: "Courier", desc: "Pathao parcel created automatically once payment is confirmed." },
            ].map(({ icon: Icon, title, desc }, i) => (
              <div
                key={title}
                className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5"
              >
                <span className="absolute right-4 top-4 font-mono text-[11px] text-slate-600">
                  0{i + 1}
                </span>
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-500/15 text-indigo-200">
                  <Icon className="h-4 w-4" />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Stack strip */}
        <section id="stack" className="mt-24">
          <div className="rounded-2xl border border-white/[0.07] bg-gradient-to-br from-white/[0.04] to-transparent p-7 shadow-card">
            <div className="grid items-center gap-8 md:grid-cols-[1fr_auto]">
              <div>
                <p className="label-caps mb-3">Stack</p>
                <h2 className="text-xl font-bold tracking-tight text-white">
                  Express · Prisma · PostgreSQL · Ollama · Next.js
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
                  Backend on Express (port 4000) handles webhooks and serves this portal's API.
                  Static admin lives on the same server. The client portal is a Next.js app on port
                  3000.
                </p>
                <ul className="mt-5 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
                  {[
                    "Per-tenant Facebook page tokens",
                    "Local LLM with Ollama",
                    "Multi-tenant Postgres schema",
                    "Static admin + API on one server",
                  ].map((p) => (
                    <li key={p} className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <Link href="/login" className="self-end md:self-center">
                <Button className="gap-2 px-6 py-3 text-base">
                  Sign in <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="mt-20 flex flex-wrap items-center justify-between gap-4 border-t border-white/[0.06] pt-6 text-xs text-slate-500">
          <span className="flex items-center gap-2.5">
            <img src={brandLogoUrl} alt="Brand logo" className="h-5 w-5 rounded object-contain brightness-0 invert" />
            <img src={brandNameUrl} alt="Brand name" className="h-4 w-auto max-w-[7rem] object-contain brightness-0 invert" />
          </span>
          <a
            href="#"
            className="inline-flex items-center gap-1.5 transition hover:text-slate-300"
          >
            <Github className="h-3.5 w-3.5" /> Source
          </a>
        </footer>
      </main>
    </div>
  );
}
