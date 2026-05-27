import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

/**
 * Shared placeholder visual used by every dashboard module until the real
 * implementation lands. Renders a simple card with the module name and an
 * optional TODO note. Real modules will replace this with their own UI.
 */
export interface ModulePlaceholderProps {
  moduleId: string;
  title: string;
  tenantId: string;
  category?: string;
  description?: ReactNode;
}

export function ModulePlaceholder({
  moduleId,
  title,
  tenantId,
  category,
  description,
}: ModulePlaceholderProps) {
  return (
    <Card data-module-id={moduleId} data-tenant-id={tenantId}>
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white/90">{title}</h3>
          {category ? (
            <p className="text-xs uppercase tracking-wide text-white/40">
              {category}
            </p>
          ) : null}
        </div>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/50">
          placeholder
        </span>
      </header>
      <p className="text-sm text-white/60">
        {description ??
          "TODO: real module implementation. This placeholder is wired through the Dashboard Module Registry."}
      </p>
      <p className="mt-3 text-xs text-white/30">
        moduleId: <code>{moduleId}</code>
      </p>
    </Card>
  );
}

export default ModulePlaceholder;
