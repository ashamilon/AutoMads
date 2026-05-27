"use client";

/**
 * Welcome step (Multi-Tenant Commerce OS, task 11.2 part B, R1.2).
 *
 * Displays the tenant's business name and the configured `AgentIdentity`
 * defaults so the operator can confirm which workspace they're configuring
 * before answering schema questions.
 *
 * `AgentIdentity` is not exposed on `/api/v1/me` today, so we surface the
 * platform defaults (name = Karim, role = Moderator of this Page, tone =
 * banglish_warm) inline. Operators can edit the bot persona later from the
 * settings page; the wizard only confirms the starting point.
 */

import { Button } from "@/components/ui/button";
import { ArrowRight, Bot, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";

const AGENT_DEFAULTS = [
  { label: "Bot name", value: "Karim" },
  { label: "Role", value: "Moderator of this Page" },
  { label: "Tone", value: "Banglish, warm" },
  { label: "Sales style", value: "Consultative" },
];

export function WelcomeStep({
  tenantName,
  onNext,
}: {
  tenantName: string;
  onNext: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleClick() {
    setErr(null);
    setPending(true);
    try {
      await onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-200/90">
          <Sparkles className="h-3.5 w-3.5" /> Welcome
        </div>
        <h1 className="font-display text-2xl font-bold text-white">
          Hello,{" "}
          <span className="bg-gradient-to-r from-indigo-300 to-violet-300 bg-clip-text text-transparent">
            {tenantName}
          </span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Let&apos;s set up your AI Commerce workspace. We&apos;ll ask three quick
          questions so the dashboard, AI agent, and product schema match how
          your business runs.
        </p>
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="mb-3 flex items-center gap-2">
          <Bot className="h-4 w-4 text-accent-bright" />
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Your AI agent will start with
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          {AGENT_DEFAULTS.map((d) => (
            <div key={d.label}>
              <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                {d.label}
              </dt>
              <dd className="mt-0.5 text-sm font-medium text-slate-200">{d.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          You can fine-tune the persona later from Settings. These defaults work
          for most Banglish-speaking pages.
        </p>
      </div>

      {err && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {err}
        </p>
      )}

      <Button onClick={handleClick} disabled={pending} className="w-full py-3 text-base">
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </>
        ) : (
          <>
            Get started <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
