"use client";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section, Tabs } from "@/components/ui/section";
import { useTenant } from "@/context/tenant-context";
import { apiFetch, apiFormPost, getWebhookBase } from "@/lib/api";
import {
  Bot,
  CheckCircle2,
  Cloud,
  Copy,
  Loader2,
  Plug,
  Plus,
  Ruler,
  RotateCcw,
  Save,
  Settings2,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type TabId = "general" | "pages" | "payments" | "courier" | "size-charts" | "persona" | "catalog" | "social" | "advanced";

type SizeChartRow = {
  size: string;
  chest?: string | number;
  length?: string | number;
  sleeve?: string | number;
  shoulder?: string | number;
  waist?: string | number;
  hip?: string | number;
  extra?: string;
};

type SizeChart = {
  id: string;
  label: string;
  aliases?: string[];
  notes?: string;
  isDefault?: boolean;
  rows: SizeChartRow[];
};

type AddOn = {
  id: string;
  label: string;
  priceBdt?: number;
  description?: string;
  enabled?: boolean;
  free?: boolean;
  /** Match aliases the AI agent uses when customers ask in different words. */
  aliases?: string[];
  /** Optional grouping like "customization", "premium", "shipping". */
  category?: string;
};

type ManualPaymentAdminLog = {
  at: string;
  level?: "info" | "warn" | "error";
  event: string;
  message?: string;
  orderId?: string;
  psid?: string;
  rail?: string;
  reference?: string;
};

const DEFAULT_PLAYER_VERSION_CHART: SizeChart = {
  id: "player-version",
  label: "Player Version",
  aliases: ["player", "player version", "authentic", "on-field"],
  isDefault: false,
  rows: [
    { size: "S", length: 26, chest: 36 },
    { size: "M", length: 27, chest: 38 },
    { size: "L", length: 28, chest: 40 },
    { size: "XL", length: 29, chest: 42 },
    { size: "XXL", length: 30, chest: 44 },
  ],
};

const DEFAULT_FAN_VERSION_CHART: SizeChart = {
  id: "fan-version",
  label: "Fan Version",
  aliases: ["fan", "fan version", "replica"],
  isDefault: true,
  rows: [
    { size: "S", length: 27, chest: 38 },
    { size: "M", length: 28, chest: 40 },
    { size: "L", length: 29, chest: 42 },
    { size: "XL", length: 30, chest: 44 },
    { size: "XXL", length: 31, chest: 46 },
  ],
};

type TestState = { status: "idle" | "testing" | "ok" | "fail"; message?: string; detail?: string };

const PRESET = {
  defaultOrderAmountBdt: 500,
  sslcommerz: {
    storeId: "your-store-id",
    storePassword: "your-store-password",
  },
  pathao: {
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
    storeId: 1,
  },
};

type SettingsShape = {
  defaultOrderAmountBdt?: number;
  deliveryChargeBdt?: number;
  /** Legacy fixed advance amount; the new advancePolicy supersedes this when set. */
  advancePaymentBdt?: number;
  /**
   * Structured advance policy.
   *  - mode="fixed": one amount per order regardless of cart size.
   *  - mode="per_product": perProductBdt × plain quantity + perCustomisedProductBdt × customised quantity.
   */
  advancePolicy?:
    | { mode: "fixed"; fixedAmountBdt: number }
    | { mode: "per_product"; perProductBdt?: number; perCustomisedProductBdt?: number };
  businessProfile?: {
    name?: string;
    logoUrl?: string;
    phone?: string;
    email?: string;
    address?: string;
    invoiceFooter?: string;
    brandColor?: string;
    website?: string;
    invoicePrefix?: string;
  };
  sslcommerz?: { storeId?: string; storePassword?: string; isLive?: boolean };
  pathao?: {
    clientId?: string;
    clientSecret?: string;
    username?: string;
    password?: string;
    storeId?: number;
    isLive?: boolean;
    bookingMode?: "automatic" | "manual" | "smart";
  };
  manualPayment?: {
    enabled?: boolean;
    bkash?: { number?: string; accountType?: string };
    nagad?: { number?: string; accountType?: string };
    instructions?: string;
  };
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    chatId?: string;
  };
  cloudinary?: {
    cloudName?: string;
    apiKey?: string;
    apiSecret?: string;
    catalogAssetPrefix?: string;
  };
  facebookPages?: Record<string, { pageAccessToken?: string; label?: string; enabled?: boolean }>;
  manualPaymentAdminLogs?: ManualPaymentAdminLog[];
  sizeCharts?: SizeChart[];
  addOns?: AddOn[];
  [k: string]: unknown;
};

export default function SettingsPage() {
  const { tenant, refresh } = useTenant();
  const [tab, setTab] = useState<TabId>("general");
  const [settings, setSettings] = useState<SettingsShape>({});
  const [json, setJson] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [previewingInvoice, setPreviewingInvoice] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [pasteForPersona, setPasteForPersona] = useState("");
  const [learning, setLearning] = useState(false);
  const [personaMsg, setPersonaMsg] = useState("");
  const personaFilesRef = useRef<HTMLInputElement>(null);
  const [sslTest, setSslTest] = useState<TestState>({ status: "idle" });
  const [pathaoTest, setPathaoTest] = useState<TestState>({ status: "idle" });
  const [telegramTest, setTelegramTest] = useState<TestState>({ status: "idle" });

  useEffect(() => {
    if (tenant?.settings && typeof tenant.settings === "object") {
      const s = tenant.settings as SettingsShape;
      setSettings(s);
      setJson(JSON.stringify(s, null, 2));
    } else {
      setSettings({});
      setJson("{}");
    }
  }, [tenant]);

  const tabs = useMemo(
    () => [
      { id: "general" as const, label: "General" },
      { id: "pages" as const, label: "Pages" },
      { id: "payments" as const, label: "Payments" },
      { id: "courier" as const, label: "Courier" },
      { id: "size-charts" as const, label: "Size charts" },
      { id: "persona" as const, label: "Bot persona" },
      { id: "catalog" as const, label: "Catalog" },
      { id: "social" as const, label: "Social Accounts" },
      { id: "advanced" as const, label: "Advanced JSON" },
    ],
    [],
  );

  function updateSizeCharts(updater: (prev: SizeChart[]) => SizeChart[]) {
    setSettings((prev) => {
      const next: SettingsShape = {
        ...prev,
        sizeCharts: updater(prev.sizeCharts ?? []),
      };
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
  }

  function addSizeChart(template?: SizeChart) {
    const id = `chart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fresh: SizeChart = template
      ? { ...template, id, isDefault: false }
      : {
          id,
          label: "New chart",
          aliases: [],
          rows: [{ size: "M", chest: "", length: "" }],
        };
    updateSizeCharts((prev) => [...prev, fresh]);
  }

  function updateAddOns(updater: (prev: AddOn[]) => AddOn[]) {
    setSettings((prev) => {
      const next: SettingsShape = {
        ...prev,
        addOns: updater(prev.addOns ?? []),
      };
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
  }

  function addAddOn() {
    const id = `addon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    updateAddOns((prev) => [
      ...prev,
      {
        id,
        label: "",
        priceBdt: undefined,
        description: "",
        enabled: true,
      },
    ]);
  }

  async function learnPersona(files: FileList | null) {
    setPersonaMsg("");
    const fd = new FormData();
    if (pasteForPersona.trim()) fd.append("paste", pasteForPersona.trim());
    if (files?.length) {
      for (let i = 0; i < files.length; i++) {
        fd.append("files", files[i]);
      }
    }
    if (!pasteForPersona.trim() && (!files || files.length === 0)) {
      setPersonaMsg("Paste chat text and/or choose files (txt, csv, screenshots png/jpg/webp).");
      return;
    }
    setLearning(true);
    try {
      await apiFormPost<{ ok: boolean }>("/api/v1/persona/learn", fd);
      setPersonaMsg("Learned your style — bot persona updated.");
      setPasteForPersona("");
      await refresh();
      if (personaFilesRef.current) personaFilesRef.current.value = "";
    } catch (e) {
      setPersonaMsg(e instanceof Error ? e.message : "Learn failed");
    } finally {
      setLearning(false);
    }
  }

  const botPersonaPreview = (
    tenant?.settings && typeof tenant.settings === "object"
      ? (tenant.settings as { botPersona?: { tone?: string; examples?: unknown[] } }).botPersona
      : undefined
  );

  function update<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
  }
  function updateNested(group: "sslcommerz" | "pathao" | "cloudinary", key: string, value: unknown) {
    setSettings((prev) => {
      const next = {
        ...prev,
        [group]: { ...((prev[group] as Record<string, unknown>) || {}), [key]: value },
      } as SettingsShape;
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
    if (group === "sslcommerz") setSslTest({ status: "idle" });
    if (group === "pathao") setPathaoTest({ status: "idle" });
  }

  async function testConnection(kind: "sslcommerz" | "pathao") {
    const setTest = kind === "sslcommerz" ? setSslTest : setPathaoTest;
    setTest({ status: "testing" });
    try {
      const body =
        kind === "sslcommerz"
          ? {
              storeId: settings.sslcommerz?.storeId ?? "",
              storePassword: settings.sslcommerz?.storePassword ?? "",
              isLive: Boolean(settings.sslcommerz?.isLive),
            }
          : {
              clientId: settings.pathao?.clientId ?? "",
              clientSecret: settings.pathao?.clientSecret ?? "",
              username: settings.pathao?.username ?? "",
              password: settings.pathao?.password ?? "",
              isLive: Boolean(settings.pathao?.isLive),
            };
      const r = await apiFetch<{ ok: boolean; message?: string; detail?: string }>(
        `/api/v1/integrations/${kind}/test`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setTest({
        status: r.ok ? "ok" : "fail",
        message: r.message,
        detail: r.detail,
      });
    } catch (e) {
      setTest({
        status: "fail",
        message: e instanceof Error ? e.message : "Request failed",
      });
    }
  }

  async function testTelegramWebhook() {
    setTelegramTest({ status: "testing" });
    try {
      const body = {
        enabled: Boolean(settings.telegram?.enabled),
        botToken: settings.telegram?.botToken ?? "",
        chatId: settings.telegram?.chatId ?? "",
        webhookBaseUrl: getWebhookBase(),
      };
      const r = await apiFetch<{ ok: boolean; message?: string; detail?: string }>(
        `/api/v1/integrations/telegram/test`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setTelegramTest({
        status: r.ok ? "ok" : "fail",
        message: r.message,
        detail: r.detail,
      });
    } catch (e) {
      setTelegramTest({
        status: "fail",
        message: e instanceof Error ? e.message : "Request failed",
      });
    }
  }

  async function save(payload: SettingsShape) {
    setFeedback("");
    setSaving(true);
    try {
      await apiFetch("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify({ settings: payload }),
      });
      setFeedback("Saved.");
      await refresh();
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function uploadBusinessLogo(file: File | null) {
    if (!file) return;
    setUploadingLogo(true);
    setFeedback("");
    try {
      const fd = new FormData();
      fd.append("logo", file);
      const r = await apiFormPost<{ ok: boolean; logoUrl?: string; settings?: SettingsShape }>(
        "/api/v1/settings/business-logo",
        fd,
      );
      if (r.settings) {
        setSettings(r.settings);
        setJson(JSON.stringify(r.settings, null, 2));
      }
      setFeedback("Logo uploaded.");
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Logo upload failed");
    } finally {
      setUploadingLogo(false);
    }
  }

  async function previewInvoicePdf() {
    setPreviewingInvoice(true);
    setFeedback("");
    try {
      const r = await apiFetch<{ ok: boolean; url?: string }>("/api/v1/settings/invoice-preview", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (r.url) {
        window.open(r.url, "_blank", "noopener,noreferrer");
        setFeedback("Opened invoice preview in new tab.");
      } else {
        setFeedback("Invoice preview URL not returned.");
      }
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Invoice preview failed");
    } finally {
      setPreviewingInvoice(false);
    }
  }

  function saveCurrent() {
    if (tab === "advanced") {
      let parsed: SettingsShape;
      try {
        parsed = JSON.parse(json) as SettingsShape;
      } catch {
        setFeedback("Invalid JSON.");
        return;
      }
      setSettings(parsed);
      void save(parsed);
    } else {
      void save(settings);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <>
            <Settings2 className="h-3.5 w-3.5" /> Workspace
          </>
        }
        title="Settings"
        description="Defaults and integration overrides stored per tenant. Prefer environment-level secrets on the server when possible."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setSettings(PRESET);
                setJson(JSON.stringify(PRESET, null, 2));
                setFeedback("Loaded example template (not saved).");
              }}
              className="gap-2"
            >
              <RotateCcw className="h-4 w-4" /> Load template
            </Button>
            <Button onClick={saveCurrent} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
          </>
        }
      />

      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />

      {tab === "pages" && (
        <Section
          title="Connected Facebook Pages"
          description="Manage which pages the bot responds to. Toggle a page off to stop the bot from replying on that page."
        >
          {/* Primary page */}
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">Primary Page</p>
                <p className="mt-0.5 truncate text-xs text-slate-500 font-mono">
                  {tenant?.facebookPageId || "No page ID set (default page)"}
                </p>
              </div>
              <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
                Always on
              </span>
            </div>

            {/* Additional pages from settings.facebookPages */}
            {Object.entries(settings.facebookPages ?? {}).map(([pageId, page]) => (
              <div
                key={pageId}
                className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-white">{page.label || "Unnamed Page"}</p>
                    <span className={`h-2 w-2 rounded-full ${page.enabled !== false ? "bg-emerald-400" : "bg-slate-600"}`} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500 font-mono">{pageId}</p>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={page.label || ""}
                    onChange={(e) => {
                      setSettings((prev) => ({
                        ...prev,
                        facebookPages: {
                          ...prev.facebookPages,
                          [pageId]: { ...page, label: e.target.value },
                        },
                      }));
                      setJson(JSON.stringify({ ...settings, facebookPages: { ...settings.facebookPages, [pageId]: { ...page, label: e.target.value } } }, null, 2));
                    }}
                    placeholder="Page name"
                    className="w-32 rounded-lg border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const newEnabled = page.enabled === false;
                      setSettings((prev) => ({
                        ...prev,
                        facebookPages: {
                          ...prev.facebookPages,
                          [pageId]: { ...page, enabled: newEnabled },
                        },
                      }));
                      setJson(JSON.stringify({ ...settings, facebookPages: { ...settings.facebookPages, [pageId]: { ...page, enabled: newEnabled } } }, null, 2));
                    }}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      page.enabled !== false ? "bg-emerald-500" : "bg-slate-700"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                        page.enabled !== false ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>
            ))}

            {Object.keys(settings.facebookPages ?? {}).length === 0 && (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-500">
                No additional pages configured. Add pages via the Advanced JSON tab or contact support.
              </p>
            )}
          </div>
        </Section>
      )}

      {tab === "general" && (
        <div className="space-y-6">
          <Section title="General defaults">
            <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default order amount (BDT)" hint="Used when amount cannot be extracted from the conversation.">
              <input
                type="number"
                value={settings.defaultOrderAmountBdt ?? ""}
                onChange={(e) =>
                  update(
                    "defaultOrderAmountBdt",
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
                placeholder="500"
                className={inputCls}
              />
            </Field>
            <Field
              label="Delivery charge (BDT)"
              hint="Shown in order/payment messages so customers know courier charge."
            >
              <input
                type="number"
                value={settings.deliveryChargeBdt ?? ""}
                onChange={(e) =>
                  update("deliveryChargeBdt", e.target.value === "" ? undefined : Number(e.target.value))
                }
                placeholder="120"
                className={inputCls}
              />
            </Field>
            <AdvancePolicyEditor
              value={settings.advancePolicy}
              legacyFixed={settings.advancePaymentBdt}
              onChange={(next, legacy) => {
                setSettings((prev) => {
                  const merged: SettingsShape = { ...prev };
                  if (next === undefined) delete merged.advancePolicy;
                  else merged.advancePolicy = next;
                  if (legacy === undefined) delete merged.advancePaymentBdt;
                  else merged.advancePaymentBdt = legacy;
                  setJson(JSON.stringify(merged, null, 2));
                  return merged;
                });
              }}
            />
            <Field label="Business name (for invoice PDF)">
              <input
                value={settings.businessProfile?.name ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: { ...(prev.businessProfile ?? {}), name: e.target.value },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                placeholder="Sports Nation BD"
                className={inputCls}
              />
            </Field>
            <Field label="Business phone (invoice)">
              <input
                value={settings.businessProfile?.phone ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: { ...(prev.businessProfile ?? {}), phone: e.target.value },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                placeholder="01XXXXXXXXX"
                className={inputCls}
              />
            </Field>
            <Field label="Business email (invoice)">
              <input
                value={settings.businessProfile?.email ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: { ...(prev.businessProfile ?? {}), email: e.target.value },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                placeholder="support@example.com"
                className={inputCls}
              />
            </Field>
            <Field label="Business address (invoice)">
              <input
                value={settings.businessProfile?.address ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: { ...(prev.businessProfile ?? {}), address: e.target.value },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                placeholder="Cumilla, Bangladesh"
                className={inputCls}
              />
            </Field>
          </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Field label="Brand color (invoice accent)">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={settings.businessProfile?.brandColor ?? "#0f766e"}
                  onChange={(e) =>
                    setSettings((prev) => {
                      const next: SettingsShape = {
                        ...prev,
                        businessProfile: {
                          ...(prev.businessProfile ?? {}),
                          brandColor: e.target.value,
                        },
                      };
                      setJson(JSON.stringify(next, null, 2));
                      return next;
                    })
                  }
                  className="h-10 w-14 cursor-pointer rounded-lg border border-white/10 bg-transparent"
                />
                <input
                  value={settings.businessProfile?.brandColor ?? ""}
                  onChange={(e) =>
                    setSettings((prev) => {
                      const next: SettingsShape = {
                        ...prev,
                        businessProfile: {
                          ...(prev.businessProfile ?? {}),
                          brandColor: e.target.value,
                        },
                      };
                      setJson(JSON.stringify(next, null, 2));
                      return next;
                    })
                  }
                  placeholder="#0f766e"
                  className={inputCls}
                />
              </div>
            </Field>
            <Field label="Website / handle (optional)">
              <input
                value={settings.businessProfile?.website ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: { ...(prev.businessProfile ?? {}), website: e.target.value },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                placeholder="www.brand.com"
                className={inputCls}
              />
            </Field>
            <Field label="Invoice number prefix">
              <input
                value={settings.businessProfile?.invoicePrefix ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: {
                        ...(prev.businessProfile ?? {}),
                        invoicePrefix: e.target.value,
                      },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                placeholder="INV"
                maxLength={6}
                className={inputCls}
              />
            </Field>
          </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Invoice footer">
              <textarea
                value={settings.businessProfile?.invoiceFooter ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      businessProfile: { ...(prev.businessProfile ?? {}), invoiceFooter: e.target.value },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                rows={3}
                placeholder="Thank you for your order."
                className={inputCls}
              />
            </Field>
            <Field label="Business logo (PNG/JPG/WebP)">
              <div className="space-y-2">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => void uploadBusinessLogo(e.target.files?.[0] ?? null)}
                  className="max-w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-white/[0.06] file:px-3 file:py-2 file:text-slate-200"
                />
                {uploadingLogo && <p className="text-xs text-slate-500">Uploading logo...</p>}
                {settings.businessProfile?.logoUrl && (
                  <a
                    href={settings.businessProfile.logoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-accent underline"
                  >
                    View current logo
                  </a>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={previewingInvoice}
                  onClick={() => void previewInvoicePdf()}
                  className="gap-2"
                >
                  {previewingInvoice ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  Preview invoice PDF
                </Button>
              </div>
            </Field>
            </div>
          </Section>
          <Section
            title="Product add-ons"
            description="Configure optional extras (name/number/font/logo patch/anything) with pricing. Bot will show these in catalog/order replies."
            actions={
              <Button type="button" variant="ghost" className="gap-2" onClick={addAddOn}>
                <Plus className="h-4 w-4" /> Add add-on
              </Button>
            }
          >
            {(settings.addOns ?? []).length === 0 ? (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-500">
                No add-ons yet. Example: Name+Number (+80), UCL Patch (+120), Premium Font (+50).
              </p>
            ) : (
              <div className="space-y-3">
                {(settings.addOns ?? []).map((a, idx) => (
                  <div
                    key={a.id || `${idx}`}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3"
                  >
                    <div className="grid gap-3 sm:grid-cols-5">
                      <Field label="Label">
                        <input
                          value={a.label}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)),
                            )
                          }
                          placeholder="Name + Number"
                          className={inputCls}
                        />
                      </Field>
                      <Field label="Price (BDT)">
                        <input
                          type="number"
                          value={a.free ? 0 : (a.priceBdt ?? "")}
                          disabled={!!a.free}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      priceBdt: e.target.value === "" ? undefined : Number(e.target.value),
                                    }
                                  : x,
                              ),
                            )
                          }
                          placeholder="80"
                          className={`${inputCls}${a.free ? " opacity-50" : ""}`}
                        />
                      </Field>
                      <Field label="Free">
                        <select
                          value={a.free ? "yes" : "no"}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? { ...x, free: e.target.value === "yes", priceBdt: e.target.value === "yes" ? 0 : x.priceBdt }
                                  : x,
                              ),
                            )
                          }
                          className={inputCls}
                        >
                          <option value="no">No</option>
                          <option value="yes">Yes</option>
                        </select>
                      </Field>
                      <Field label="Enabled">
                        <select
                          value={a.enabled === false ? "no" : "yes"}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) => (i === idx ? { ...x, enabled: e.target.value === "yes" } : x)),
                            )
                          }
                          className={inputCls}
                        >
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </Field>
                      <Field label="Delete">
                        <Button
                          type="button"
                          variant="ghost"
                          className="w-full justify-center gap-2 text-rose-300"
                          onClick={() => updateAddOns((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          <Trash2 className="h-4 w-4" /> Remove
                        </Button>
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label="Description (optional)">
                        <input
                          value={a.description ?? ""}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) =>
                                i === idx ? { ...x, description: e.target.value } : x,
                              ),
                            )
                          }
                          placeholder="Any player name + number in premium heat-press font"
                          className={inputCls}
                        />
                      </Field>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <Field
                        label="Aliases (comma-separated — what the AI agent matches against)"
                      >
                        <input
                          value={(a.aliases ?? []).join(", ")}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      aliases: e.target.value
                                        .split(",")
                                        .map((s) => s.trim())
                                        .filter(Boolean),
                                    }
                                  : x,
                              ),
                            )
                          }
                          placeholder="official font, premium font, heat press"
                          className={inputCls}
                        />
                      </Field>
                      <Field label="Category (optional)">
                        <input
                          value={a.category ?? ""}
                          onChange={(e) =>
                            updateAddOns((prev) =>
                              prev.map((x, i) =>
                                i === idx ? { ...x, category: e.target.value } : x,
                              ),
                            )
                          }
                          placeholder="customization | premium | shipping"
                          className={inputCls}
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {tab === "payments" && (
        <div className="space-y-6">
          <Section title="SSLCommerz" description="Store credentials for payment link generation.">
            <EnvToggle
              value={settings.sslcommerz?.isLive ? "live" : "sandbox"}
              onChange={(mode) => {
                updateNested("sslcommerz", "isLive", mode === "live");
              }}
              hint={
                settings.sslcommerz?.isLive
                  ? "Hitting securepay.sslcommerz.com"
                  : "Hitting sandbox.sslcommerz.com"
              }
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Store ID">
                <input
                  value={settings.sslcommerz?.storeId ?? ""}
                  onChange={(e) => updateNested("sslcommerz", "storeId", e.target.value)}
                  placeholder="your-store-id"
                  className={inputCls}
                />
              </Field>
              <Field label="Store password">
                <input
                  type="password"
                  value={settings.sslcommerz?.storePassword ?? ""}
                  onChange={(e) => updateNested("sslcommerz", "storePassword", e.target.value)}
                  placeholder="••••••"
                  className={inputCls}
                />
              </Field>
            </div>
            <ConnectionTester
              label="SSLCommerz"
              state={sslTest}
              disabled={!settings.sslcommerz?.storeId || !settings.sslcommerz?.storePassword}
              onTest={() => void testConnection("sslcommerz")}
            />
          </Section>

          <Section
            title="Manual mobile payments (bKash / Nagad)"
            description="Personal send-money fallback. The bot offers these alongside SSLCommerz; admin verifies the transaction id from the order page."
          >
            <label className="mb-4 inline-flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={Boolean(settings.manualPayment?.enabled)}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      manualPayment: {
                        ...(prev.manualPayment ?? {}),
                        enabled: e.target.checked,
                      },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                className="h-4 w-4 rounded border-white/[0.08] bg-black/30"
              />
              Enable manual bKash / Nagad payments
            </label>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <h4 className="text-sm font-semibold text-slate-100">bKash</h4>
                <Field label="bKash number">
                  <input
                    value={settings.manualPayment?.bkash?.number ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => {
                        const next: SettingsShape = {
                          ...prev,
                          manualPayment: {
                            ...(prev.manualPayment ?? {}),
                            bkash: {
                              ...(prev.manualPayment?.bkash ?? {}),
                              number: e.target.value,
                            },
                          },
                        };
                        setJson(JSON.stringify(next, null, 2));
                        return next;
                      })
                    }
                    placeholder="01XXXXXXXXX"
                    className={inputCls}
                  />
                </Field>
                <Field label="Account type">
                  <input
                    value={settings.manualPayment?.bkash?.accountType ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => {
                        const next: SettingsShape = {
                          ...prev,
                          manualPayment: {
                            ...(prev.manualPayment ?? {}),
                            bkash: {
                              ...(prev.manualPayment?.bkash ?? {}),
                              accountType: e.target.value,
                            },
                          },
                        };
                        setJson(JSON.stringify(next, null, 2));
                        return next;
                      })
                    }
                    placeholder="personal | agent | merchant"
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <h4 className="text-sm font-semibold text-slate-100">Nagad</h4>
                <Field label="Nagad number">
                  <input
                    value={settings.manualPayment?.nagad?.number ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => {
                        const next: SettingsShape = {
                          ...prev,
                          manualPayment: {
                            ...(prev.manualPayment ?? {}),
                            nagad: {
                              ...(prev.manualPayment?.nagad ?? {}),
                              number: e.target.value,
                            },
                          },
                        };
                        setJson(JSON.stringify(next, null, 2));
                        return next;
                      })
                    }
                    placeholder="01XXXXXXXXX"
                    className={inputCls}
                  />
                </Field>
                <Field label="Account type">
                  <input
                    value={settings.manualPayment?.nagad?.accountType ?? ""}
                    onChange={(e) =>
                      setSettings((prev) => {
                        const next: SettingsShape = {
                          ...prev,
                          manualPayment: {
                            ...(prev.manualPayment ?? {}),
                            nagad: {
                              ...(prev.manualPayment?.nagad ?? {}),
                              accountType: e.target.value,
                            },
                          },
                        };
                        setJson(JSON.stringify(next, null, 2));
                        return next;
                      })
                    }
                    placeholder="personal | agent | merchant"
                    className={inputCls}
                  />
                </Field>
              </div>
            </div>

            <Field
              label="Instructions"
              hint="Optional — appended to the customer-facing payment message."
            >
              <textarea
                value={settings.manualPayment?.instructions ?? ""}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      manualPayment: {
                        ...(prev.manualPayment ?? {}),
                        instructions: e.target.value,
                      },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    return next;
                  })
                }
                rows={3}
                placeholder="e.g. Send-money korar por TrxID amader pathaben."
                className={`${inputCls} font-mono text-xs leading-relaxed`}
              />
            </Field>
          </Section>

          <Section
            title="Telegram manual payment alerts"
            description="When customer sends bKash/Nagad TrxID, send order details to Telegram admin chat with Confirm/Reject buttons."
          >
            <label className="mb-4 inline-flex items-center gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={Boolean(settings.telegram?.enabled)}
                onChange={(e) =>
                  setSettings((prev) => {
                    const next: SettingsShape = {
                      ...prev,
                      telegram: {
                        ...(prev.telegram ?? {}),
                        enabled: e.target.checked,
                      },
                    };
                    setJson(JSON.stringify(next, null, 2));
                    setTelegramTest({ status: "idle" });
                    return next;
                  })
                }
                className="h-4 w-4 rounded border-white/[0.08] bg-black/30"
              />
              Enable Telegram admin verification flow
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bot token">
                <input
                  type="password"
                  value={settings.telegram?.botToken ?? ""}
                  onChange={(e) =>
                    setSettings((prev) => {
                      const next: SettingsShape = {
                        ...prev,
                        telegram: { ...(prev.telegram ?? {}), botToken: e.target.value },
                      };
                      setJson(JSON.stringify(next, null, 2));
                      setTelegramTest({ status: "idle" });
                      return next;
                    })
                  }
                  placeholder="123456:AA..."
                  className={inputCls}
                />
              </Field>
              <Field label="Chat ID" hint="Private chat id or group id (e.g. -100xxxxxxxxxx)">
                <input
                  value={settings.telegram?.chatId ?? ""}
                  onChange={(e) =>
                    setSettings((prev) => {
                      const next: SettingsShape = {
                        ...prev,
                        telegram: { ...(prev.telegram ?? {}), chatId: e.target.value },
                      };
                      setJson(JSON.stringify(next, null, 2));
                      setTelegramTest({ status: "idle" });
                      return next;
                    })
                  }
                  placeholder="-1001234567890"
                  className={inputCls}
                />
              </Field>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Set Telegram webhook in BotFather/server to:
              <span className="ml-1 font-mono text-slate-400">
                {`/webhooks/telegram/${tenant?.slug ?? "<tenant-slug>"}`}
              </span>
            </p>
            <div className="mt-4">
              <ConnectionTester
                label="Telegram"
                state={telegramTest}
                disabled={
                  !settings.telegram?.enabled ||
                  !settings.telegram?.botToken?.trim() ||
                  !settings.telegram?.chatId?.trim()
                }
                onTest={() => void testTelegramWebhook()}
              />
            </div>
          </Section>
          <Section
            title="Manual payment admin log"
            description="Recent TrxID detection + Telegram/confirm/reject events. Stored in tenant settings for quick troubleshooting."
            actions={
              <Button
                type="button"
                variant="ghost"
                className="gap-2"
                onClick={() =>
                  setSettings((prev) => {
                    const next: SettingsShape = { ...prev, manualPaymentAdminLogs: [] };
                    setJson(JSON.stringify(next, null, 2));
                    setFeedback("Cleared admin logs in draft. Save changes to persist.");
                    return next;
                  })
                }
              >
                <Trash2 className="h-4 w-4" /> Clear logs
              </Button>
            }
          >
            {(settings.manualPaymentAdminLogs ?? []).length === 0 ? (
              <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-500">
                No manual payment logs yet.
              </p>
            ) : (
              <div className="space-y-2">
                {(settings.manualPaymentAdminLogs ?? []).slice(0, 40).map((log, idx) => (
                  <div
                    key={`${log.at}-${log.event}-${idx}`}
                    className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-xs text-slate-300"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-slate-400">{new Date(log.at).toLocaleString()}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 font-medium ${
                          log.level === "error"
                            ? "bg-rose-400/15 text-rose-300"
                            : log.level === "warn"
                              ? "bg-amber-400/15 text-amber-300"
                              : "bg-emerald-400/15 text-emerald-300"
                        }`}
                      >
                        {(log.level ?? "info").toUpperCase()}
                      </span>
                      <span className="font-semibold text-slate-200">{log.event}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
                      {log.orderId && <span>Order: {log.orderId}</span>}
                      {log.psid && <span>PSID: {log.psid}</span>}
                      {log.rail && <span>Rail: {log.rail}</span>}
                      {log.reference && <span>TrxID: {log.reference}</span>}
                    </div>
                    {log.message && <p className="mt-1 text-slate-400">{log.message}</p>}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-[11px] text-slate-500">Showing latest 40 entries.</p>
          </Section>
        </div>
      )}

      {tab === "size-charts" && (
        <Section
          title="Size charts library"
          description="Define multiple charts (Player Version, Fan Version, Kids, Women, etc). When a customer asks for a size chart, the bot picks the best match from this list using your label + aliases. The chart marked Default is used when no alias matches."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="gap-2" onClick={() => addSizeChart()}>
                <Plus className="h-4 w-4" /> New chart
              </Button>
              <Button
                variant="ghost"
                className="gap-2"
                onClick={() => addSizeChart(DEFAULT_PLAYER_VERSION_CHART)}
              >
                <Copy className="h-4 w-4" /> Add Player Version preset
              </Button>
              <Button
                variant="ghost"
                className="gap-2"
                onClick={() => addSizeChart(DEFAULT_FAN_VERSION_CHART)}
              >
                <Copy className="h-4 w-4" /> Add Fan Version preset
              </Button>
            </div>
          }
        >
          {(settings.sizeCharts ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.08] py-10 text-center">
              <Ruler className="h-6 w-6 text-slate-500" />
              <p className="text-sm text-slate-400">
                No charts yet. Add the Player / Fan presets above or build a custom one.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {(settings.sizeCharts ?? []).map((chart, idx) => (
                <SizeChartEditor
                  key={chart.id ?? idx}
                  chart={chart}
                  onChange={(next) =>
                    updateSizeCharts((prev) => prev.map((c, i) => (i === idx ? next : c)))
                  }
                  onDelete={() =>
                    updateSizeCharts((prev) => prev.filter((_, i) => i !== idx))
                  }
                  onMakeDefault={() =>
                    updateSizeCharts((prev) =>
                      prev.map((c, i) => ({ ...c, isDefault: i === idx })),
                    )
                  }
                  onDuplicate={() => addSizeChart(chart)}
                />
              ))}
            </div>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
            How matching works: bot lowercases the customer message + product label, splits into
            words, and scores each chart by token overlap with its label + aliases. Multi-word
            aliases (e.g. <span className="font-mono">"player version"</span>) get a phrase-match
            bonus. Higher score wins; ties fall back to the Default chart.
          </p>
        </Section>
      )}

      {tab === "persona" && (
        <Section
          title="Bot persona from your chats"
          description="Paste Messenger threads, upload .txt/.csv exports, or screenshots (PNG/JPG/WebP). Text is read directly; images use OCR (Latin/Banglish works best). Ollama builds tone + example pairs for your tenant only — same mechanism as manual persona JSON."
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-400">
              <div className="mb-1 flex items-center gap-2 font-medium text-slate-200">
                <Bot className="h-4 w-4 text-accent" /> Current persona
              </div>
              {botPersonaPreview?.tone ? (
                <p className="text-xs leading-relaxed text-slate-400">
                  <span className="text-slate-500">Tone</span> —{" "}
                  {String(botPersonaPreview.tone).slice(0, 280)}
                  {String(botPersonaPreview.tone).length > 280 ? "…" : ""}
                </p>
              ) : (
                <p className="text-xs text-slate-500">No custom tone yet — defaults apply until you learn.</p>
              )}
              <p className="mt-2 text-xs text-slate-500">
                Examples loaded:{" "}
                <span className="font-mono text-slate-400">
                  {Array.isArray(botPersonaPreview?.examples) ? botPersonaPreview.examples.length : 0}
                </span>
              </p>
            </div>

            <label className="block">
              <span className="label-caps mb-1.5 block">Paste chat logs</span>
              <textarea
                value={pasteForPersona}
                onChange={(e) => setPasteForPersona(e.target.value)}
                rows={8}
                placeholder="Paste exported Messenger text or any customer ↔ shop dialogue…"
                className={`${inputCls} font-mono text-xs leading-relaxed`}
              />
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={personaFilesRef}
                type="file"
                multiple
                accept=".txt,.csv,.json,image/png,image/jpeg,image/webp"
                className="max-w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-white/[0.06] file:px-3 file:py-2 file:text-slate-200"
              />
              <Button
                type="button"
                disabled={learning}
                onClick={() => void learnPersona(personaFilesRef.current?.files ?? null)}
                className="gap-2"
              >
                {learning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                Learn from uploads
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Large cloud models may take a few minutes. Screenshots with Bengali script only may OCR poorly — prefer pasted text or Latin Banglish screenshots.
            </p>
            {personaMsg && (
              <div className="rounded-xl border border-white/[0.06] bg-black/30 px-4 py-3 text-sm text-slate-300">
                {personaMsg}
              </div>
            )}
          </div>
        </Section>
      )}

      {tab === "courier" && (
        <Section title="Pathao" description="Used for delivery booking after payment is verified.">
          <EnvToggle
            value={settings.pathao?.isLive ? "live" : "sandbox"}
            onChange={(mode) => {
              updateNested("pathao", "isLive", mode === "live");
            }}
            hint={
              settings.pathao?.isLive
                ? "Hitting api-hermes.pathao.com"
                : "Hitting courier-api-sandbox.pathao.com"
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client ID">
              <input
                value={settings.pathao?.clientId ?? ""}
                onChange={(e) => updateNested("pathao", "clientId", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Client secret">
              <input
                type="password"
                value={settings.pathao?.clientSecret ?? ""}
                onChange={(e) => updateNested("pathao", "clientSecret", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Username">
              <input
                value={settings.pathao?.username ?? ""}
                onChange={(e) => updateNested("pathao", "username", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={settings.pathao?.password ?? ""}
                onChange={(e) => updateNested("pathao", "password", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Store ID">
              <input
                type="number"
                value={settings.pathao?.storeId ?? ""}
                onChange={(e) =>
                  updateNested(
                    "pathao",
                    "storeId",
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
                className={inputCls}
              />
            </Field>
            <Field label="Booking Mode">
              <select
                value={settings.pathao?.bookingMode ?? "automatic"}
                onChange={(e) => updateNested("pathao", "bookingMode", e.target.value)}
                className={inputCls}
              >
                <option value="automatic">Automatic — book after payment</option>
                <option value="manual">Manual — book from order page</option>
                <option value="smart">Smart — auto for plain, manual for customized</option>
              </select>
            </Field>
          </div>
          <ConnectionTester
            label="Pathao"
            state={pathaoTest}
            disabled={
              !settings.pathao?.clientId ||
              !settings.pathao?.clientSecret ||
              !settings.pathao?.username ||
              !settings.pathao?.password
            }
            onTest={() => void testConnection("pathao")}
          />
        </Section>
      )}

      {tab === "catalog" && (
        <Section
          title="Cloudinary catalog images"
          description="Used by Portal → Catalog → Cloudinary photos (Preview / Apply). If these fields are set, they override server CLOUDINARY_* environment variables for this workspace only."
        >
          <div className="mb-4 flex items-center gap-2 text-xs text-slate-500">
            <Cloud className="h-4 w-4 text-violet-300" />
            <span>
              Keys are stored in your workspace JSON settings.               Run matching from the{" "}
              <Link href="/portal/catalog" className="font-medium text-accent underline underline-offset-4">
                Catalog
              </Link>{" "}
              page.
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Cloud name"
              hint="Dashboard → Product Environment Credentials, or the subdomain of your Media Library URL."
            >
              <input
                value={settings.cloudinary?.cloudName ?? ""}
                onChange={(e) => updateNested("cloudinary", "cloudName", e.target.value)}
                placeholder="your-cloud-name"
                className={inputCls}
                autoComplete="off"
              />
            </Field>
            <Field label="API key">
              <input
                value={settings.cloudinary?.apiKey ?? ""}
                onChange={(e) => updateNested("cloudinary", "apiKey", e.target.value)}
                className={inputCls}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="API secret">
              <input
                type="password"
                value={settings.cloudinary?.apiSecret ?? ""}
                onChange={(e) => updateNested("cloudinary", "apiSecret", e.target.value)}
                className={inputCls}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field
              label="Default folder prefix (optional)"
              hint="Only assets under this public_id prefix are listed (e.g. catalog/jerseys/). You can still pass a one-off override when running Preview on the Catalog page."
            >
              <input
                value={settings.cloudinary?.catalogAssetPrefix ?? ""}
                onChange={(e) => updateNested("cloudinary", "catalogAssetPrefix", e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
        </Section>
      )}

      {tab === "social" && (
        <div className="space-y-6">
          <SocialAccountsSection settings={settings} setSettings={setSettings} inputCls={inputCls} />
        </div>
      )}

      {tab === "advanced" && (
        <Section
          title="Raw settings JSON"
          description="Edit anything not covered above. Validated as JSON before save."
        >
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={20}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
        </Section>
      )}

      {feedback && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm text-slate-400">
          {feedback}
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm font-medium text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label-caps mb-1.5 block">{label}</span>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-slate-500">{hint}</p>}
    </label>
  );
}

function EnvToggle({
  value,
  onChange,
  hint,
}: {
  value: "sandbox" | "live";
  onChange: (v: "sandbox" | "live") => void;
  hint?: string;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <span className="label-caps">Environment</span>
      <div className="inline-flex rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-xs">
        {(["sandbox", "live"] as const).map((opt) => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`px-3 py-1.5 rounded-md font-medium transition ${
                active
                  ? opt === "live"
                    ? "bg-emerald-400/15 text-emerald-200"
                    : "bg-white/[0.08] text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {opt === "live" ? "Live" : "Sandbox"}
            </button>
          );
        })}
      </div>
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </div>
  );
}

function ConnectionTester({
  label,
  state,
  disabled,
  onTest,
}: {
  label: string;
  state: TestState;
  disabled: boolean;
  onTest: () => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/[0.05] pt-4">
      <Button
        type="button"
        variant="ghost"
        onClick={onTest}
        disabled={disabled || state.status === "testing"}
        className="gap-2"
      >
        {state.status === "testing" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plug className="h-4 w-4" />
        )}
        Test connection
      </Button>
      <StatusPill state={state} />
      {disabled && state.status === "idle" && (
        <span className="text-[11px] text-slate-500">Fill in all {label} fields to enable testing.</span>
      )}
    </div>
  );
}

const MEASURE_KEYS: Array<keyof Pick<SizeChartRow, "chest" | "length" | "shoulder" | "sleeve" | "waist" | "hip">> = [
  "chest",
  "length",
  "shoulder",
  "sleeve",
  "waist",
  "hip",
];

function SizeChartEditor({
  chart,
  onChange,
  onDelete,
  onMakeDefault,
  onDuplicate,
}: {
  chart: SizeChart;
  onChange: (c: SizeChart) => void;
  onDelete: () => void;
  onMakeDefault: () => void;
  onDuplicate: () => void;
}) {
  function update<K extends keyof SizeChart>(key: K, value: SizeChart[K]) {
    onChange({ ...chart, [key]: value });
  }
  function updateAliases(raw: string) {
    onChange({
      ...chart,
      aliases: raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  function updateRow(i: number, patch: Partial<SizeChartRow>) {
    onChange({ ...chart, rows: chart.rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  }
  function addRow() {
    onChange({ ...chart, rows: [...chart.rows, { size: "" }] });
  }
  function removeRow(i: number) {
    if (chart.rows.length <= 1) return;
    onChange({ ...chart, rows: chart.rows.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Ruler className="h-4 w-4 text-slate-400" />
        <input
          value={chart.label}
          onChange={(e) => update("label", e.target.value)}
          className="flex-1 min-w-[180px] rounded-lg border border-white/[0.08] bg-black/30 px-3 py-1.5 text-sm font-semibold text-slate-100 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
          placeholder="Label (e.g. Player Version)"
        />
        {chart.isDefault ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-200">
            <Star className="h-3 w-3 fill-amber-300" /> Default
          </span>
        ) : (
          <Button variant="ghost" className="gap-1 text-xs" onClick={onMakeDefault}>
            <Star className="h-3.5 w-3.5" /> Make default
          </Button>
        )}
        <Button variant="ghost" className="gap-1 text-xs" onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" /> Duplicate
        </Button>
        <Button variant="ghost" className="gap-1 text-xs text-rose-300" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Field
          label="Aliases (comma-separated)"
          hint="Words / phrases that should map to this chart. e.g. player, on-field, authentic"
        >
          <input
            value={(chart.aliases ?? []).join(", ")}
            onChange={(e) => updateAliases(e.target.value)}
            className={inputCls}
            placeholder="player, player version, authentic"
          />
        </Field>
        <Field label="Notes (optional, sent with the chart)">
          <input
            value={chart.notes ?? ""}
            onChange={(e) => update("notes", e.target.value)}
            className={inputCls}
            placeholder="e.g. measurements in inches"
          />
        </Field>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-white/[0.06]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">Size</th>
              {MEASURE_KEYS.map((k) => (
                <th key={k} className="px-3 py-2">
                  {k}
                </th>
              ))}
              <th className="px-3 py-2">Extra</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {chart.rows.map((row, i) => (
              <tr key={i} className="text-slate-200">
                <td className="px-2 py-1.5">
                  <input
                    value={row.size}
                    onChange={(e) => updateRow(i, { size: e.target.value })}
                    className="w-20 rounded-md border border-white/[0.06] bg-black/30 px-2 py-1 text-xs font-semibold uppercase"
                    placeholder="M"
                  />
                </td>
                {MEASURE_KEYS.map((k) => (
                  <td key={k} className="px-2 py-1.5">
                    <input
                      value={String(row[k] ?? "")}
                      onChange={(e) => updateRow(i, { [k]: e.target.value } as Partial<SizeChartRow>)}
                      className="w-20 rounded-md border border-white/[0.06] bg-black/30 px-2 py-1 text-xs"
                      placeholder="—"
                    />
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  <input
                    value={row.extra ?? ""}
                    onChange={(e) => updateRow(i, { extra: e.target.value })}
                    className="w-32 rounded-md border border-white/[0.06] bg-black/30 px-2 py-1 text-xs"
                    placeholder="optional"
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={chart.rows.length <= 1}
                    className="text-rose-300 transition hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Remove row"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <Button variant="ghost" className="gap-1 text-xs" onClick={addRow}>
          <Plus className="h-3.5 w-3.5" /> Add row
        </Button>
      </div>
    </div>
  );
}

function StatusPill({ state }: { state: TestState }) {
  if (state.status === "idle") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-400">
        Not tested
      </span>
    );
  }
  if (state.status === "testing") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-300">
        <Loader2 className="h-3 w-3 animate-spin" /> Testing…
      </span>
    );
  }
  if (state.status === "ok") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300"
        title={state.message}
      >
        <CheckCircle2 className="h-3 w-3" /> {state.message ?? "Connected"}
      </span>
    );
  }
  return (
    <span
      className="inline-flex max-w-xl items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-[11px] font-medium text-rose-300"
      title={[state.message, state.detail].filter(Boolean).join(" — ")}
    >
      <XCircle className="h-3 w-3 shrink-0" />
      <span className="truncate">{state.message ?? "Failed"}</span>
    </span>
  );
}

// ─── Social Accounts Section ─────────────────────────────────────────────────

function SocialAccountsSection({
  settings,
  setSettings,
  inputCls,
}: {
  settings: Record<string, any>;
  setSettings: React.Dispatch<React.SetStateAction<any>>;
  inputCls: string;
}) {
  const [igValidating, setIgValidating] = useState(false);
  const [igStatus, setIgStatus] = useState<"idle" | "ok" | "fail">("idle");
  const [igError, setIgError] = useState("");
  const [tiktokValidating, setTiktokValidating] = useState(false);
  const [tiktokStatus, setTiktokStatus] = useState<"idle" | "ok" | "fail">("idle");
  const [tiktokError, setTiktokError] = useState("");

  const igUserId = settings?.instagram?.igUserId ?? "";
  const igEnabled = settings?.instagram?.enabled ?? false;
  const tiktokClientKey = settings?.tiktok?.clientKey ?? "";
  const tiktokClientSecret = settings?.tiktok?.clientSecret ?? "";
  const tiktokAccessToken = settings?.tiktok?.accessToken ?? "";
  const tiktokEnabled = settings?.tiktok?.enabled ?? false;

  const validateInstagram = async () => {
    if (!igUserId.trim()) { setIgError("Enter your IG User ID first"); setIgStatus("fail"); return; }
    setIgValidating(true);
    setIgError("");
    try {
      const res = await apiFetch<{ ok?: boolean; error?: string }>("/api/v1/social/validate-instagram", {
        method: "POST",
        body: JSON.stringify({ igUserId: igUserId.trim() }),
      });
      if (res.ok) {
        setIgStatus("ok");
      } else {
        setIgStatus("fail");
        setIgError(res.error ?? "Validation failed");
      }
    } catch (e: any) {
      setIgStatus("fail");
      setIgError(e?.message ?? "Connection failed");
    }
    setIgValidating(false);
  };

  const validateTiktok = async () => {
    if (!tiktokAccessToken.trim()) { setTiktokError("Enter your TikTok access token first"); setTiktokStatus("fail"); return; }
    setTiktokValidating(true);
    setTiktokError("");
    try {
      const res = await apiFetch<{ ok?: boolean; error?: string }>("/api/v1/social/validate-tiktok", {
        method: "POST",
        body: JSON.stringify({ accessToken: tiktokAccessToken.trim() }),
      });
      if (res.ok) {
        setTiktokStatus("ok");
      } else {
        setTiktokStatus("fail");
        setTiktokError(res.error ?? "Validation failed");
      }
    } catch (e: any) {
      setTiktokStatus("fail");
      setTiktokError(e?.message ?? "Connection failed");
    }
    setTiktokValidating(false);
  };

  return (
    <>
      {/* Instagram */}
      <Section
        title="Instagram"
        description="Connect your Instagram Business account for auto-posting. Uses the same Page Access Token from your Facebook Page."
      >
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="currentColor">
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
              </svg>
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-slate-200">Instagram Business</h4>
              <p className="text-xs text-slate-500 mt-0.5">Requires Instagram Business/Creator account linked to your Facebook Page</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={igEnabled}
                onChange={(e) =>
                  setSettings((s: any) => ({
                    ...s,
                    instagram: { ...(s?.instagram ?? {}), enabled: e.target.checked },
                  }))
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-600 rounded-full peer peer-checked:bg-indigo-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="pl-14 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Instagram User ID</label>
              <input
                value={igUserId}
                onChange={(e) =>
                  setSettings((s: any) => ({
                    ...s,
                    instagram: { ...(s?.instagram ?? {}), igUserId: e.target.value },
                  }))
                }
                placeholder="e.g. 17841400123456789"
                className={inputCls}
              />
              <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
                Go to <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener" className="text-indigo-400 hover:underline">Graph API Explorer</a> → select your Page token → run: <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] text-indigo-300">GET /me?fields=instagram_business_account</code>
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={validateInstagram}
                disabled={igValidating}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 transition disabled:opacity-50"
              >
                {igValidating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plug className="w-3 h-3" />}
                Validate Connection
              </button>
              {igStatus === "ok" && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                </span>
              )}
              {igStatus === "fail" && (
                <span className="text-xs text-red-400">{igError}</span>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* TikTok */}
      <Section
        title="TikTok"
        description="Connect your TikTok account for auto-posting product videos and images via the Content Posting API."
      >
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-900 to-slate-700 border border-white/10 flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="currentColor">
                <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.88 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .55.04.81.1v-3.49a6.37 6.37 0 00-.81-.05A6.34 6.34 0 003.15 15.7a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.4a8.16 8.16 0 004.76 1.52v-3.4a4.85 4.85 0 01-1-.83z"/>
              </svg>
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-slate-200">TikTok for Business</h4>
              <p className="text-xs text-slate-500 mt-0.5">Requires a TikTok Developer App with Content Posting API access</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={tiktokEnabled}
                onChange={(e) =>
                  setSettings((s: any) => ({
                    ...s,
                    tiktok: { ...(s?.tiktok ?? {}), enabled: e.target.checked },
                  }))
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-600 rounded-full peer peer-checked:bg-indigo-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div className="pl-14 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Client Key</label>
              <input
                value={tiktokClientKey}
                onChange={(e) =>
                  setSettings((s: any) => ({
                    ...s,
                    tiktok: { ...(s?.tiktok ?? {}), clientKey: e.target.value },
                  }))
                }
                placeholder="awXXXXXXXXXXXXXX"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Client Secret</label>
              <input
                type="password"
                value={tiktokClientSecret}
                onChange={(e) =>
                  setSettings((s: any) => ({
                    ...s,
                    tiktok: { ...(s?.tiktok ?? {}), clientSecret: e.target.value },
                  }))
                }
                placeholder="••••••••••••"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Access Token</label>
              <input
                type="password"
                value={tiktokAccessToken}
                onChange={(e) =>
                  setSettings((s: any) => ({
                    ...s,
                    tiktok: { ...(s?.tiktok ?? {}), accessToken: e.target.value },
                  }))
                }
                placeholder="act.XXXXXXXXXXXX"
                className={inputCls}
              />
              <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
                Create an app at <a href="https://developers.tiktok.com" target="_blank" rel="noopener" className="text-indigo-400 hover:underline">developers.tiktok.com</a> → enable Content Posting API → get OAuth access token
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={validateTiktok}
                disabled={tiktokValidating}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/20 transition disabled:opacity-50"
              >
                {tiktokValidating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plug className="w-3 h-3" />}
                Validate Connection
              </button>
              {tiktokStatus === "ok" && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                </span>
              )}
              {tiktokStatus === "fail" && (
                <span className="text-xs text-red-400">{tiktokError}</span>
              )}
            </div>
          </div>

          <div className="pl-14 pt-2 border-t border-white/[0.04]">
            <details className="group">
              <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-300 transition">
                How to set up TikTok Developer App
              </summary>
              <ol className="mt-2 space-y-1.5 text-[11px] text-slate-500 list-decimal list-inside leading-relaxed">
                <li>Go to <a href="https://developers.tiktok.com" target="_blank" rel="noopener" className="text-indigo-400 hover:underline">developers.tiktok.com</a> and sign in</li>
                <li>Create a new app → select "Content Posting API"</li>
                <li>Add your redirect URL (e.g. <code className="bg-black/30 px-1 py-0.5 rounded text-indigo-300">https://your-domain.com/callback</code>)</li>
                <li>Submit for review (usually approved in 1-2 days)</li>
                <li>Once approved, get your Client Key & Secret from the app dashboard</li>
                <li>Generate an Access Token via OAuth 2.0 flow</li>
                <li>Paste all three values above and click "Validate Connection"</li>
              </ol>
            </details>
          </div>
        </div>
      </Section>
    </>
  );
}


type AdvancePolicy = NonNullable<SettingsShape["advancePolicy"]>;
type AdvanceMode = AdvancePolicy["mode"] | "off";

function AdvancePolicyEditor({
  value,
  legacyFixed,
  onChange,
}: {
  value: SettingsShape["advancePolicy"];
  legacyFixed: number | undefined;
  onChange: (next: SettingsShape["advancePolicy"], legacyFixed: number | undefined) => void;
}) {
  // Resolve initial mode: explicit policy → that mode; else legacy fixed → "fixed"; else "off".
  const currentMode: AdvanceMode = value
    ? value.mode
    : legacyFixed != null
      ? "fixed"
      : "off";

  const fixedAmount =
    value?.mode === "fixed"
      ? value.fixedAmountBdt
      : legacyFixed != null
        ? legacyFixed
        : undefined;

  const perPlain = value?.mode === "per_product" ? value.perProductBdt : undefined;
  const perCust = value?.mode === "per_product" ? value.perCustomisedProductBdt : undefined;

  function switchMode(next: AdvanceMode) {
    if (next === "off") {
      onChange(undefined, undefined);
      return;
    }
    if (next === "fixed") {
      const amt = fixedAmount ?? 0;
      onChange({ mode: "fixed", fixedAmountBdt: amt }, undefined);
      return;
    }
    // per_product: keep any prior per-product values, default empty.
    onChange(
      {
        mode: "per_product",
        ...(perPlain != null ? { perProductBdt: perPlain } : {}),
        ...(perCust != null ? { perCustomisedProductBdt: perCust } : {}),
      },
      undefined,
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="label-caps">Advance to collect</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">how much customer pays now</span>
      </div>
      <p className="mb-3 text-[11px] text-slate-500">
        Pick how the advance is calculated. <span className="text-slate-300">Per-product</span> mode lets
        you charge a different advance for plain vs customised lines (both can be set — a mixed cart
        pays both).
      </p>
      <div className="mb-4 inline-flex rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-xs">
        {([
          { id: "off", label: "No advance" },
          { id: "fixed", label: "Fixed (per order)" },
          { id: "per_product", label: "Per product" },
        ] as Array<{ id: AdvanceMode; label: string }>).map((opt) => {
          const active = currentMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => switchMode(opt.id)}
              className={`px-3 py-1.5 rounded-md font-medium transition ${
                active ? "bg-white/[0.08] text-slate-100" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {currentMode === "fixed" && (
        <Field
          label="Fixed advance amount (BDT)"
          hint="Same advance regardless of how many products the customer orders."
        >
          <input
            type="number"
            min={0}
            value={fixedAmount ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              onChange({ mode: "fixed", fixedAmountBdt: Number.isFinite(v) ? v : 0 }, undefined);
            }}
            placeholder="200"
            className={inputCls}
          />
        </Field>
      )}

      {currentMode === "per_product" && (
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Per plain product (BDT)"
            hint="Charged per quantity for each cart line that has NO add-ons."
          >
            <input
              type="number"
              min={0}
              value={perPlain ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                const v = raw === "" ? undefined : Number(raw);
                onChange(
                  {
                    mode: "per_product",
                    ...(v != null && Number.isFinite(v) ? { perProductBdt: v } : {}),
                    ...(perCust != null ? { perCustomisedProductBdt: perCust } : {}),
                  },
                  undefined,
                );
              }}
              placeholder="200"
              className={inputCls}
            />
          </Field>
          <Field
            label="Per customised product (BDT)"
            hint="Charged per quantity for each line that has at least one add-on (e.g. name+number)."
          >
            <input
              type="number"
              min={0}
              value={perCust ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                const v = raw === "" ? undefined : Number(raw);
                onChange(
                  {
                    mode: "per_product",
                    ...(perPlain != null ? { perProductBdt: perPlain } : {}),
                    ...(v != null && Number.isFinite(v) ? { perCustomisedProductBdt: v } : {}),
                  },
                  undefined,
                );
              }}
              placeholder="500"
              className={inputCls}
            />
          </Field>
          <p className="md:col-span-2 text-[11px] text-slate-500">
            Example: customer takes 2 jerseys — 1 customised, 1 plain. Per plain = 200, per customised = 500.
            Advance to pay = 200 + 500 = <span className="text-slate-300">700 BDT</span>.
          </p>
        </div>
      )}

      {currentMode === "off" && (
        <p className="text-[11px] text-slate-500">
          No advance — the bot will treat the full subtotal as payable now (legacy behaviour).
        </p>
      )}
    </div>
  );
}
