"use client";

/**
 * Category schema management — Admin Super Control Panel (R20.6).
 *
 * Reads `/api/v1/admin/categories` (returns every CategorySchema row,
 * built-in + tenant-cloned). Two tabs split the list so the operator
 * doesn't conflate templates with tenant customizations:
 *
 *   - "Built-in templates" — `isBuiltIn === true`
 *   - "Tenant clones" — every other row, including drafts
 *
 * Edit opens a modal with two textareas pre-filled with the JSON for
 * `attributes` and `orderAttributes`. Save PATCHes `/api/v1/admin/categories/:id`.
 * "New schema" POSTs `/api/v1/admin/categories` with a minimal payload.
 *
 * The textareas are intentionally raw JSON. Free-form editing is
 * appropriate for the operator-facing tool and matches the legacy admin
 * UI conventions; deeper validation lives in `adminPanelService`.
 */

import { Button } from "@/components/ui/button";
import { adminFetch } from "@/lib/admin-api";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface CategorySchemaRow {
  id: string;
  slug: string;
  version: number;
  isBuiltIn: boolean;
  tenantId: string | null;
  attributes: unknown;
  orderAttributes: unknown;
  variantAttributes: unknown;
  filterAttributes: unknown;
  terminology: unknown;
  dashboardModules: unknown;
  workflowRules: unknown;
  promptFragments: unknown;
  createdAt: string;
  updatedAt: string;
}

type Tab = "builtin" | "tenant";

export default function AdminSchemasPage() {
  const [schemas, setSchemas] = useState<CategorySchemaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("builtin");
  const [editing, setEditing] = useState<CategorySchemaRow | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<{ schemas: CategorySchemaRow[] }>("/api/v1/admin/categories");
      setSchemas(data.schemas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return schemas.filter((s) => (tab === "builtin" ? s.isBuiltIn : !s.isBuiltIn));
  }, [schemas, tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Category schemas</h1>
          <p className="mt-1 text-sm text-slate-500">
            Built-in templates ship with the platform; tenant clones carry a{" "}
            <code>tenantId</code> and represent per-tenant customizations.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New schema
          </Button>
        </div>
      </div>

      <div className="inline-flex rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
        <TabButton active={tab === "builtin"} onClick={() => setTab("builtin")}>
          Built-in templates
        </TabButton>
        <TabButton active={tab === "tenant"} onClick={() => setTab("tenant")}>
          Tenant clones
        </TabButton>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && schemas.length === 0 ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-12 text-center">
          <p className="text-sm text-slate-500">
            {tab === "builtin"
              ? "No built-in templates have been seeded yet."
              : "No tenant clones — operators haven't customized any schemas."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.02]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-white/[0.06] text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Slug</th>
                <th className="px-4 py-3 font-semibold">Version</th>
                <th className="px-4 py-3 font-semibold">Tenant id</th>
                <th className="px-4 py-3 font-semibold">Schema id</th>
                <th className="px-4 py-3 font-semibold">Updated</th>
                <th className="px-4 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {filtered.map((s) => (
                <tr key={s.id} className="transition hover:bg-white/[0.03]">
                  <td className="px-4 py-3">
                    <span className="font-semibold text-white">{s.slug}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">v{s.version}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-400">
                    {s.tenantId ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{s.id}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {new Date(s.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SchemaEditor
          schema={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {creating && (
        <SchemaCreator
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-lg px-3 py-1.5 text-xs font-semibold transition " +
        (active
          ? "bg-white/[0.08] text-white"
          : "text-slate-400 hover:bg-white/[0.03] hover:text-slate-200")
      }
    >
      {children}
    </button>
  );
}

// ─── Editor ───────────────────────────────────────────────────────────────

function SchemaEditor({
  schema,
  onClose,
  onSaved,
}: {
  schema: CategorySchemaRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [attributesText, setAttributesText] = useState(() =>
    safeStringify(schema.attributes),
  );
  const [orderAttributesText, setOrderAttributesText] = useState(() =>
    safeStringify(schema.orderAttributes),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    let attributes: unknown;
    let orderAttributes: unknown;
    try {
      attributes = JSON.parse(attributesText);
    } catch {
      setErr("`attributes` is not valid JSON");
      return;
    }
    try {
      orderAttributes = JSON.parse(orderAttributesText);
    } catch {
      setErr("`orderAttributes` is not valid JSON");
      return;
    }
    if (!Array.isArray(attributes)) {
      setErr("`attributes` must be an array");
      return;
    }
    if (!Array.isArray(orderAttributes)) {
      setErr("`orderAttributes` must be an array");
      return;
    }
    setBusy(true);
    try {
      await adminFetch(`/api/v1/admin/categories/${schema.id}`, {
        method: "PATCH",
        body: JSON.stringify({ attributes, orderAttributes }),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <h3 className="text-sm font-semibold text-white">
        Edit schema <span className="font-mono text-indigo-300">{schema.slug}</span> v
        {schema.version}
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        {schema.isBuiltIn
          ? "Built-in template. Edits propagate to every tenant pinned to this id."
          : `Tenant clone for ${schema.tenantId ?? "—"}.`}
      </p>
      <div className="mt-4 grid gap-3">
        <JsonField
          label="attributes (array)"
          value={attributesText}
          onChange={setAttributesText}
        />
        <JsonField
          label="orderAttributes (array)"
          value={orderAttributesText}
          onChange={setOrderAttributesText}
        />
      </div>
      {err && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {err}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </ModalShell>
  );
}

function SchemaCreator({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [isBuiltIn, setIsBuiltIn] = useState(false);
  const [attributesText, setAttributesText] = useState("[]");
  const [orderAttributesText, setOrderAttributesText] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!slug.trim()) {
      setErr("Slug is required");
      return;
    }
    let attributes: unknown;
    let orderAttributes: unknown;
    try {
      attributes = JSON.parse(attributesText);
    } catch {
      setErr("`attributes` is not valid JSON");
      return;
    }
    try {
      orderAttributes = JSON.parse(orderAttributesText);
    } catch {
      setErr("`orderAttributes` is not valid JSON");
      return;
    }
    if (!Array.isArray(attributes)) {
      setErr("`attributes` must be an array");
      return;
    }
    setBusy(true);
    try {
      await adminFetch("/api/v1/admin/categories", {
        method: "POST",
        body: JSON.stringify({
          slug: slug.trim(),
          isBuiltIn,
          tenantId: tenantId.trim() || null,
          attributes,
          orderAttributes,
        }),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <h3 className="text-sm font-semibold text-white">New category schema</h3>
      <div className="mt-4 grid gap-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Slug
          </span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="e.g. cosmetics"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Tenant id (leave blank for built-in)
          </span>
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="cmooz62gy0000v5gclycwq78p"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={isBuiltIn}
            onChange={(e) => setIsBuiltIn(e.target.checked)}
          />
          <span>Built-in template (operator templates, no tenant scope)</span>
        </label>
        <JsonField
          label="attributes (array)"
          value={attributesText}
          onChange={setAttributesText}
        />
        <JsonField
          label="orderAttributes (array)"
          value={orderAttributesText}
          onChange={setOrderAttributesText}
        />
      </div>
      {err && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {err}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create
        </Button>
      </div>
    </ModalShell>
  );
}

// ─── Shared modal primitives ──────────────────────────────────────────────

function ModalShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-surface-950 p-6">
        {children}
      </div>
    </div>
  );
}

function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        spellCheck={false}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-slate-100 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
    </label>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? [], null, 2);
  } catch {
    return "[]";
  }
}
