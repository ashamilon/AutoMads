"use client";

/**
 * Sticky banner shown across all portal pages while the post-connection
 * grace window is active. Reminds the operator that:
 *   - The agent is escalating past-order questions to admin via Telegram.
 *   - X conversations are currently muted (admin should pick them up).
 *   - There's an "End early" button if they're confident no past customers
 *     are still asking about pre-connection orders.
 *
 * Polls the status every 60s so the countdown stays current.
 */

import { apiFetch } from "@/lib/api";
import { Clock, Megaphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type GraceStatus = {
  inGrace: boolean;
  hoursRemaining: number;
  connectedAt: string | null;
  graceWindowHours: number;
  mutedConversations: number;
};

export function GraceBanner() {
  const [status, setStatus] = useState<GraceStatus | null>(null);
  const [ending, setEnding] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<GraceStatus>("/api/v1/grace-status");
      setStatus(data);
    } catch {
      /* silent — banner is non-critical */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!status?.inGrace) return null;

  const endEarly = async () => {
    if (!confirm("End the grace window now? Past-order questions will go straight to the agent — without your old orders in the database, the agent will say it can't find them.")) {
      return;
    }
    setEnding(true);
    try {
      await apiFetch("/api/v1/grace-status/end", { method: "POST" });
      await load();
    } catch (e) {
      alert("Failed: " + (e instanceof Error ? e.message : String(e)));
    }
    setEnding(false);
  };

  return (
    <div className="mb-4 rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-amber-500/5 px-4 py-3 text-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="mt-0.5 grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg bg-amber-500/20">
          <Megaphone className="h-3.5 w-3.5 text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-amber-100">
            Post-connection grace window active
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-amber-200/80">
            <Clock className="mb-0.5 mr-1 inline h-3 w-3" />
            <span className="font-mono">{status.hoursRemaining}h</span> remaining of {status.graceWindowHours}h.
            Returning customers asking about previous orders will be escalated to your admin
            (Telegram alert + Banglish ack) and the agent will stay quiet on those threads for 10 hours.
            {status.mutedConversations > 0 && (
              <>
                {" "}
                Currently <span className="font-semibold text-amber-100">
                  {status.mutedConversations} {status.mutedConversations === 1 ? "conversation is" : "conversations are"}
                </span>{" "}
                awaiting admin reply.
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={endEarly}
          disabled={ending}
          className="shrink-0 self-start rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
        >
          {ending ? "Ending…" : "End early"}
        </button>
      </div>
    </div>
  );
}
