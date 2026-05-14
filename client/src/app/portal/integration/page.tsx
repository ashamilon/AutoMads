"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { useTenant } from "@/context/tenant-context";
import { getWebhookBase } from "@/lib/api";
import { Cable, Check, Copy, Database, Globe, Webhook } from "lucide-react";
import { useState } from "react";

const integrationIcons: Record<string, typeof Webhook> = {
  WEBHOOK: Webhook,
  API: Globe,
  DATABASE: Database,
};

export default function IntegrationPage() {
  const { tenant } = useTenant();
  const base = getWebhookBase();
  const slug = tenant?.slug ?? "{slug}";

  const integrationType = tenant?.integration?.type as string | undefined;
  const Icon = integrationType ? integrationIcons[integrationType] || Cable : Cable;

  const blocks = [
    {
      title: "Facebook Messenger",
      description: "Use this URL when configuring the webhook on Meta Developer Portal.",
      url: `${base}/webhooks/facebook/${slug}`,
    },
    {
      title: "SSLCommerz IPN",
      description: "Set this as your IPN callback in the SSLCommerz dashboard.",
      url: `${base}/webhooks/sslcommerz/ipn`,
    },
    {
      title: "Your site → us (inbound)",
      description: "Point your own webhook integration here to push events into the platform.",
      url: `${base}/webhooks/client/${slug}/inbound`,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <Cable className="h-3.5 w-3.5" /> Integration mode {integrationType ?? "—"}
          </>
        }
        title="Integration"
        description={
          <>
            Endpoints and configuration your stack uses. Webhook base URL comes from{" "}
            <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-indigo-300">
              NEXT_PUBLIC_WEBHOOK_BASE_URL
            </code>{" "}
            — set it to the public URL of your backend API.
          </>
        }
      />

      <Section title="Active mode">
        <div className="flex flex-wrap items-start gap-4">
          <div
            className={`grid h-14 w-14 place-items-center rounded-2xl border ${
              integrationType
                ? "border-indigo-400/20 bg-indigo-500/10 text-indigo-200"
                : "border-amber-400/20 bg-amber-500/10 text-amber-200"
            }`}
          >
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {integrationType ? (
                <Badge tone="info">{integrationType}</Badge>
              ) : (
                <Badge tone="warning">Not configured</Badge>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              {integrationType === "WEBHOOK"
                ? "We POST extracted orders to your outbound URL. Configure URL + secret on the server."
                : integrationType === "API"
                  ? "We call your client API endpoints. Manage credentials on the server."
                  : integrationType === "DATABASE"
                    ? "We write directly into your client database. Connection is server-managed."
                    : "Ask your operator to provision an integration mode for this workspace."}
            </p>
          </div>
        </div>
        <div className="mt-5 overflow-hidden rounded-xl border border-white/[0.06] bg-black/30">
          <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-2.5">
            <span className="label-caps">Resolved configuration (sensitive fields redacted)</span>
          </div>
          <pre className="max-h-80 overflow-auto p-4 font-mono text-xs leading-relaxed text-slate-300">
            {tenant?.integration ? JSON.stringify(tenant.integration, null, 2) : "{}"}
          </pre>
        </div>
      </Section>

      <Section
        title="Webhook URLs"
        description="Copy these into Meta and SSLCommerz dashboards (or your client integration)."
      >
        <div className="space-y-3">
          {blocks.map((b) => (
            <UrlBlock key={b.title} {...b} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function UrlBlock({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
        <Button variant="ghost" onClick={copy} className="gap-1.5 text-xs">
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-300" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </Button>
      </div>
      <div className="rounded-lg border border-white/[0.05] bg-black/40 px-3.5 py-2.5 font-mono text-xs text-indigo-200 break-all">
        {url}
      </div>
    </div>
  );
}
