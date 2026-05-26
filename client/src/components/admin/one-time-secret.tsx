"use client";

/**
 * Display a one-time secret (API key, activation URL, reset URL) in a
 * highly-visible callout with a copy button. The value should NEVER
 * appear elsewhere in the UI — once the operator dismisses this banner,
 * they have to regenerate to see another.
 *
 * Use cases: createTenant response → apiKey + activationUrl;
 * regenerateApiKey → new apiKey; resetPassword → activationUrl.
 */

import { Check, Copy, X } from "lucide-react";
import { useState } from "react";

export function OneTimeSecret({
  label,
  value,
  description,
  onDismiss,
}: {
  label: string;
  value: string;
  description?: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — leave the value visible for manual copy */
    }
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-200">
            {label} — shown once
          </p>
          {description && (
            <p className="mt-1 text-xs text-amber-200/80">{description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-lg p-1.5 text-amber-300 transition hover:bg-amber-500/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <code className="flex-1 select-all rounded-lg border border-amber-500/30 bg-black/40 px-3 py-2 font-mono text-xs text-amber-100 break-all">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
