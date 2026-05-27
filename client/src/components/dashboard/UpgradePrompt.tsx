import Link from "next/link";
import { Card } from "@/components/ui/card";

export interface UpgradePromptProps {
  moduleId: string;
  /** Optional human label for the locked module (falls back to moduleId). */
  title?: string;
  /**
   * Where the operator should go to upgrade. Defaults to `/portal/billing`
   * with `/portal/plan` as a secondary entry-point per spec R16.3.
   */
  href?: string;
  secondaryHref?: string;
}

/**
 * Upgrade prompt rendered in place of a dashboard module when its feature
 * flag resolves to `false`. The actual feature-flag fetch is handled at the
 * page level (per task 13.2 scope) and the resolver passes the result down to
 * the `DashboardModuleRenderer`. This component is intentionally a
 * placeholder visual — copy and CTA can be replaced later without changing
 * the renderer wiring.
 */
export function UpgradePrompt({
  moduleId,
  title,
  href = "/portal/billing",
  secondaryHref = "/portal/plan",
}: UpgradePromptProps) {
  const label = title ?? moduleId;
  return (
    <Card data-module-id={moduleId} data-locked="true">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white/90">{label}</h3>
          <p className="text-xs uppercase tracking-wide text-amber-300/80">
            upgrade required
          </p>
        </div>
        <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
          locked
        </span>
      </header>
      <p className="text-sm text-white/60">
        This module is not part of your current plan. Upgrade to unlock it.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={href}
          className="inline-flex items-center rounded-md border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-300/20"
        >
          Manage billing
        </Link>
        <Link
          href={secondaryHref}
          className="inline-flex items-center rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/5"
        >
          See plans
        </Link>
      </div>
      <p className="mt-3 text-xs text-white/30">
        moduleId: <code>{moduleId}</code>
      </p>
    </Card>
  );
}

export default UpgradePrompt;
