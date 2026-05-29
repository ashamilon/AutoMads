"use client";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { useTenant } from "@/context/tenant-context";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Globe,
  ImageIcon,
  Loader2,
  Music2,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wand2,
  X,
  XCircle,
  Eye,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type ScheduledPost = {
  id: string;
  platform: string;
  postType: string;
  caption: string;
  imageUrls: string[];
  productSkus: string[] | null;
  scheduledAt: string;
  publishedAt: string | null;
  status: string;
  fbPostId: string | null;
  igMediaId: string | null;
  failureReason: string | null;
  createdAt: string;
};

type ProductRow = {
  clientSku: string;
  facebookLabel: string | null;
  metadata: Record<string, unknown> | null;
};

const STATUS_STYLES: Record<string, { bg: string; dot: string; text: string }> = {
  draft: { bg: "bg-slate-500/10 border-slate-600/50", dot: "bg-slate-400", text: "text-slate-300" },
  pending_approval: { bg: "bg-amber-500/10 border-amber-500/30", dot: "bg-amber-400", text: "text-amber-300" },
  scheduled: { bg: "bg-blue-500/10 border-blue-500/30", dot: "bg-blue-400", text: "text-blue-300" },
  published: { bg: "bg-emerald-500/10 border-emerald-500/30", dot: "bg-emerald-400", text: "text-emerald-300" },
  failed: { bg: "bg-red-500/10 border-red-500/30", dot: "bg-red-400", text: "text-red-300" },
};

const PLATFORMS = [
  { id: "facebook", label: "Facebook", icon: <Globe size={16} /> },
  { id: "instagram", label: "Instagram", icon: <ImageIcon size={16} /> },
  { id: "tiktok", label: "TikTok", icon: <Music2 size={16} /> },
  { id: "all", label: "All Platforms", icon: <Zap size={16} /> },
];

const POST_TYPES = [
  { id: "product_showcase", label: "Product Showcase" },
  { id: "collection", label: "Collection" },
  { id: "story", label: "Story / Reel" },
  { id: "custom", label: "Custom" },
];

/**
 * Caption styles — names + short descriptions shown in the picker.
 * Backend honors the `style` key on /generate-caption; default falls back to
 * the friendly small-shop voice.
 */
const CAPTION_STYLES = [
  { id: "default", label: "Default" },
  { id: "formal", label: "Formal" },
  { id: "informal", label: "Informal" },
  { id: "luxury", label: "Luxury" },
  { id: "minimal", label: "Minimal" },
  { id: "sales", label: "Sales-focused" },
  { id: "trendy", label: "Trendy / Viral" },
  { id: "sports", label: "Sports Hype" },
  { id: "promotional", label: "Promotional" },
  { id: "storytelling", label: "Storytelling" },
];

function getProductImages(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta) return [];
  const imgs: string[] = [];
  if (typeof meta.image_url === "string" && meta.image_url) imgs.push(meta.image_url);
  const arr = (meta.image_urls ?? meta.images ?? []) as unknown[];
  for (const u of arr) {
    if (typeof u === "string" && u.startsWith("http")) imgs.push(u);
  }
  return [...new Set(imgs)];
}

export default function ContentCalendarPage() {
  const { tenant } = useTenant();
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [showPhotoAgent, setShowPhotoAgent] = useState(false);
  const [filter, setFilter] = useState<"all" | "scheduled" | "published" | "draft" | "pending_approval" | "failed">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, prodsRes] = await Promise.all([
        apiFetch<ScheduledPost[]>("/api/v1/scheduled-posts"),
        apiFetch<{ productMappings: ProductRow[] }>("/api/v1/product-mappings"),
      ]);
      setPosts(p);
      setProducts(prodsRes.productMappings ?? []);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (filter === "all") return posts;
    return posts.filter((p) => p.status === filter);
  }, [posts, filter]);

  const counts = useMemo(() => ({
    all: posts.length,
    pending_approval: posts.filter((p) => p.status === "pending_approval").length,
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    published: posts.filter((p) => p.status === "published").length,
    draft: posts.filter((p) => p.status === "draft").length,
    failed: posts.filter((p) => p.status === "failed").length,
  }), [posts]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this post?")) return;
    await apiFetch(`/api/v1/scheduled-posts/${id}`, { method: "DELETE" });
    load();
  };

  const handleApprove = async (id: string) => {
    try {
      await apiFetch<ScheduledPost>(`/api/v1/scheduled-posts/${id}/approve`, { method: "POST" });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handleReject = async (id: string) => {
    const reason = prompt("Reason for rejecting (optional):") ?? "";
    try {
      await apiFetch<ScheduledPost>(`/api/v1/scheduled-posts/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePublishNow = async (id: string) => {
    if (!confirm("Publish this post now?")) return;
    try {
      await apiFetch<ScheduledPost>(`/api/v1/scheduled-posts/${id}/publish-now`, { method: "POST" });
      load();
    } catch (e) {
      if (e instanceof ApiError) {
        try {
          const body = JSON.parse(e.body) as { failureReason?: string; post?: ScheduledPost };
          alert(body.failureReason ?? e.message);
        } catch {
          alert(e.message);
        }
      } else {
        alert(String(e));
      }
      load();
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content Calendar"
        description="Schedule, create, and manage social media posts across all platforms"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setShowAgent(true)}>
              <Wand2 size={16} className="mr-1.5" /> AI Agent
            </Button>
            <Button variant="secondary" onClick={() => setShowPhotoAgent(true)}>
              <ImageIcon size={16} className="mr-1.5" /> Photo Posts
            </Button>
            <Button onClick={() => setShowCreate(true)}>
              <Plus size={16} className="mr-1.5" /> Create Post
            </Button>
          </div>
        }
      />

      {/* Facebook publishing status — answers "is my page hooked up?" at a glance.
         Renders a single line: green = ready, amber = setup needed, red = token broken. */}
      <FacebookStatusCard />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {([
          { key: "pending_approval", label: "Pending", color: "text-amber-400" },
          { key: "scheduled", label: "Scheduled", color: "text-blue-400" },
          { key: "published", label: "Published", color: "text-emerald-400" },
          { key: "draft", label: "Drafts", color: "text-slate-400" },
          { key: "failed", label: "Failed", color: "text-red-400" },
        ] as const).map((s) => (
          <div
            key={s.key}
            onClick={() => setFilter(s.key)}
            className={cn(
              "cursor-pointer rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-white/[0.12]",
              filter === s.key && "border-indigo-500/40 bg-indigo-500/5",
            )}
          >
            <p className="text-2xl font-bold text-white">{counts[s.key]}</p>
            <p className={cn("text-xs font-medium mt-0.5", s.color)}>{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-white/[0.02] border border-white/[0.06] rounded-xl p-1 flex-wrap">
        {(["all", "pending_approval", "scheduled", "published", "draft", "failed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition",
              filter === f
                ? "bg-white/10 text-white"
                : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]",
            )}
          >
            {f.replace("_", " ")} {counts[f] > 0 && <span className="ml-1 opacity-60">({counts[f]})</span>}
          </button>
        ))}
      </div>

      {/* Posts list */}
      <Section>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="animate-spin text-indigo-400" size={32} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-4">
              <Calendar size={28} className="text-indigo-400" />
            </div>
            <p className="text-slate-300 font-medium">No posts {filter !== "all" ? `with status "${filter}"` : "yet"}</p>
            <p className="text-sm text-slate-500 mt-1">Create your first social media post to get started</p>
            <Button onClick={() => setShowCreate(true)} className="mt-4">
              <Plus size={14} className="mr-1.5" /> Create Post
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((p) => {
              const style = STATUS_STYLES[p.status] ?? STATUS_STYLES.draft;
              return (
                <div
                  key={p.id}
                  className={cn(
                    "rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center gap-4 transition hover:bg-white/[0.02]",
                    style.bg,
                  )}
                >
                  {p.imageUrls?.length > 0 && (
                    <div className="flex gap-1 flex-shrink-0">
                      {p.imageUrls.slice(0, 3).map((url, i) => (
                        <img key={i} src={url} alt="" className="w-12 h-12 rounded-lg object-cover border border-white/10" />
                      ))}
                      {p.imageUrls.length > 3 && (
                        <div className="w-12 h-12 rounded-lg bg-slate-700/50 flex items-center justify-center text-xs text-slate-300">
                          +{p.imageUrls.length - 3}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-100 line-clamp-2 font-medium">{p.caption}</p>
                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-slate-400">
                      <span className="flex items-center gap-1 capitalize">
                        {p.platform === "tiktok" ? <Music2 size={11} /> : p.platform === "instagram" ? <ImageIcon size={11} /> : <Globe size={11} />}
                        {p.platform}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {new Date(p.scheduledAt).toLocaleString("en-BD", { dateStyle: "medium", timeStyle: "short" })}
                      </span>
                      {p.publishedAt && (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <CheckCircle2 size={11} />
                          Published
                        </span>
                      )}
                    </div>
                    {p.failureReason && (
                      <p className="text-xs text-red-400 mt-1 truncate">{p.failureReason}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className={cn("flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-full border", style.bg, style.text)}>
                      <span className={cn("w-1.5 h-1.5 rounded-full", style.dot)} />
                      {p.status.replace("_", " ")}
                    </span>
                  {(p.status === "pending_approval" || p.status === "draft") && (
                    <>
                      <button
                        onClick={() => handleApprove(p.id)}
                        className="p-2 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition"
                        title="Approve"
                      >
                        <ThumbsUp size={14} />
                      </button>
                      <button
                        onClick={() => handleReject(p.id)}
                        className="p-2 text-amber-400 hover:bg-amber-500/10 rounded-lg transition"
                        title="Reject"
                      >
                        <ThumbsDown size={14} />
                      </button>
                    </>
                  )}
                  {(p.status !== "published" || !p.fbPostId) && (
                    <button
                      onClick={() => handlePublishNow(p.id)}
                      className="p-2 text-indigo-400 hover:bg-indigo-500/10 rounded-lg transition"
                      title="Publish now"
                    >
                      <Send size={14} />
                    </button>
                  )}
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {showCreate && (
        <CreatePostModal
          products={products}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {showAgent && (
        <AgentPanel
          onClose={() => setShowAgent(false)}
          onAgentRan={() => load()}
        />
      )}

      {showPhotoAgent && (
        <PhotoAgentPanel
          onClose={() => setShowPhotoAgent(false)}
          onAgentRan={() => load()}
        />
      )}
    </div>
  );
}

// ─── Create Post Modal (Advanced) ────────────────────────────────────────────

function CreatePostModal({
  products,
  onClose,
  onCreated,
}: {
  products: ProductRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [platform, setPlatform] = useState("facebook");
  const [postType, setPostType] = useState("product_showcase");
  const [captionStyle, setCaptionStyle] = useState("default");
  const [caption, setCaption] = useState("");
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [imageInput, setImageInput] = useState("");
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const allProductImages = useMemo(() => {
    const imgs: { url: string; sku: string; label: string }[] = [];
    for (const p of products) {
      const pImgs = getProductImages(p.metadata as Record<string, unknown> | null);
      for (const url of pImgs) {
        imgs.push({ url, sku: p.clientSku, label: p.facebookLabel ?? p.clientSku });
      }
    }
    return imgs;
  }, [products]);

  const selectedProductImages = useMemo(() => {
    if (selectedSkus.length === 0) return allProductImages;
    return allProductImages.filter((i) => selectedSkus.includes(i.sku));
  }, [allProductImages, selectedSkus]);

  const toggleImage = (url: string) => {
    setImageUrls((prev) =>
      prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url],
    );
  };

  const toggleSku = (sku: string) => {
    setSelectedSkus((prev) =>
      prev.includes(sku) ? prev.filter((s) => s !== sku) : [...prev, sku],
    );
  };

  const generateAiCaption = async () => {
    const names: string[] = [];
    const prices: number[] = [];
    const tags: string[] = [];
    const skusToUse = selectedSkus.length > 0 ? selectedSkus : products.slice(0, 3).map((p) => p.clientSku);
    for (const sku of skusToUse) {
      const prod = products.find((p) => p.clientSku === sku);
      names.push(prod?.facebookLabel ?? sku);
      const meta = prod?.metadata as Record<string, unknown> | undefined;
      prices.push(Number(meta?.price) || 0);
      const t = meta?.tags as string[] | undefined;
      if (t) tags.push(...t);
    }
    if (names.length === 0) return;
    setGenerating(true);
    try {
      const res = await apiFetch<{ caption: string }>("/api/v1/generate-caption", {
        method: "POST",
        body: JSON.stringify({ productNames: names, prices, tags, postType, style: captionStyle }),
      });
      setCaption(res.caption);
    } catch {
      alert("Caption generation failed — check if Ollama is running");
    }
    setGenerating(false);
  };

  const handleSubmit = async (isDraft: boolean) => {
    if (!caption.trim()) { alert("Caption is required"); return; }
    if (!scheduledAt && !isDraft) { alert("Pick a schedule time"); return; }
    setSaving(true);
    try {
      await apiFetch("/api/v1/scheduled-posts", {
        method: "POST",
        body: JSON.stringify({
          platform,
          postType,
          caption: caption.trim(),
          imageUrls,
          productSkus: selectedSkus.length > 0 ? selectedSkus : null,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : new Date().toISOString(),
          status: isDraft ? "draft" : "scheduled",
        }),
      });
      onCreated();
    } catch (e: any) {
      alert("Failed: " + (e?.message ?? "Unknown error"));
    }
    setSaving(false);
  };

  const addImageUrl = () => {
    const url = imageInput.trim();
    if (url && url.startsWith("http")) {
      setImageUrls((prev) => [...prev, url]);
      setImageInput("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-700/60 rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-lg font-bold text-white">Create Post</h2>
            <p className="text-xs text-slate-400 mt-0.5">Step {step} of 3 — {step === 1 ? "Platform & Content" : step === 2 ? "Select Media" : "Schedule & Publish"}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg transition">
            <X size={18} className="text-slate-400" />
          </button>
        </div>

        {/* Progress */}
        <div className="flex gap-1 px-6 pt-3">
          {[1, 2, 3].map((s) => (
            <div key={s} className={cn("h-1 flex-1 rounded-full transition", s <= step ? "bg-indigo-500" : "bg-white/[0.06]")} />
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {step === 1 && (
            <>
              {/* Platform Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Platform</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PLATFORMS.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => setPlatform(pl.id)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition",
                        platform === pl.id
                          ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
                          : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/[0.15] hover:text-slate-200",
                      )}
                    >
                      {pl.icon}
                      {pl.label}
                      {platform === pl.id && <Check size={14} className="ml-auto text-indigo-400" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Post Type */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Post Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {POST_TYPES.map((pt) => (
                    <button
                      key={pt.id}
                      onClick={() => setPostType(pt.id)}
                      className={cn(
                        "px-3 py-2 rounded-xl border text-sm font-medium transition text-left",
                        postType === pt.id
                          ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
                          : "border-white/[0.08] bg-white/[0.02] text-slate-400 hover:border-white/[0.15] hover:text-slate-200",
                      )}
                    >
                      {pt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Caption Style */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Caption Style <span className="text-slate-500 font-normal normal-case">(used by AI Generate)</span>
                </label>
                <select
                  value={captionStyle}
                  onChange={(e) => setCaptionStyle(e.target.value)}
                  className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500/50 transition"
                >
                  {CAPTION_STYLES.map((cs) => (
                    <option key={cs.id} value={cs.id}>{cs.label}</option>
                  ))}
                </select>
              </div>

              {/* Products */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Link Products <span className="text-slate-500 font-normal normal-case">({selectedSkus.length} selected)</span>
                </label>
                <div className="max-h-40 overflow-y-auto border border-white/[0.06] rounded-xl bg-black/20 p-2 space-y-0.5">
                  {(products || []).map((p) => {
                    const isActive = selectedSkus.includes(p.clientSku);
                    const thumb = getProductImages(p.metadata as Record<string, unknown> | null)[0];
                    return (
                      <button
                        key={p.clientSku}
                        onClick={() => toggleSku(p.clientSku)}
                        className={cn(
                          "w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-left transition",
                          isActive ? "bg-indigo-500/10" : "hover:bg-white/[0.03]",
                        )}
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-8 h-8 rounded bg-slate-700/50 flex items-center justify-center flex-shrink-0">
                            <ImageIcon size={12} className="text-slate-500" />
                          </div>
                        )}
                        <span className={cn("text-sm truncate flex-1", isActive ? "text-indigo-200" : "text-slate-300")}>
                          {p.facebookLabel || p.clientSku}
                        </span>
                        {isActive && <Check size={14} className="text-indigo-400 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Caption */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Caption</label>
                  <button
                    onClick={generateAiCaption}
                    disabled={generating}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500/20 to-indigo-500/20 border border-purple-500/30 text-xs font-medium text-purple-300 hover:from-purple-500/30 hover:to-indigo-500/30 disabled:opacity-50 transition"
                  >
                    {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    AI Generate
                  </button>
                </div>
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  rows={3}
                  className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-slate-200 resize-none placeholder-slate-500 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition"
                  placeholder="Write an engaging caption for your post..."
                />
                <p className="text-[11px] text-slate-500 mt-1">{caption.length} characters</p>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {/* Image Gallery from Products */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Select Images <span className="text-slate-500 font-normal normal-case">({imageUrls.length} selected)</span>
                </label>
                {selectedProductImages.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-[300px] overflow-y-auto border border-white/[0.06] rounded-xl bg-black/20 p-3">
                    {selectedProductImages.map((img, i) => {
                      const isSelected = imageUrls.includes(img.url);
                      return (
                        <button
                          key={`${img.sku}-${i}`}
                          onClick={() => toggleImage(img.url)}
                          className={cn(
                            "relative aspect-square rounded-lg overflow-hidden border-2 transition group",
                            isSelected ? "border-indigo-500 ring-2 ring-indigo-500/30" : "border-transparent hover:border-white/20",
                          )}
                        >
                          <img src={img.url} alt={img.label} className="w-full h-full object-cover" />
                          {isSelected && (
                            <div className="absolute inset-0 bg-indigo-500/20 flex items-center justify-center">
                              <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center">
                                <Check size={14} className="text-white" />
                              </div>
                            </div>
                          )}
                          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 group-hover:opacity-100 transition">
                            <p className="text-[10px] text-white truncate">{img.label}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="border border-white/[0.06] rounded-xl bg-black/20 p-8 text-center">
                    <ImageIcon size={28} className="mx-auto text-slate-500 mb-2" />
                    <p className="text-sm text-slate-400">No product images available</p>
                    <p className="text-xs text-slate-500 mt-1">Add image URLs manually below</p>
                  </div>
                )}
              </div>

              {/* Selected preview */}
              {imageUrls.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Selected for post</label>
                  <div className="flex flex-wrap gap-2">
                    {imageUrls.map((url, i) => (
                      <div key={i} className="relative group">
                        <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover border border-indigo-500/40" />
                        <button
                          onClick={() => setImageUrls((prev) => prev.filter((_, j) => j !== i))}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow-lg"
                        >
                          <X size={10} className="text-white" />
                        </button>
                        <span className="absolute bottom-0.5 right-0.5 w-4 h-4 bg-black/70 rounded text-[9px] text-white flex items-center justify-center">{i + 1}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Manual URL add */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Add custom image URL</label>
                <div className="flex gap-2">
                  <input
                    value={imageInput}
                    onChange={(e) => setImageInput(e.target.value)}
                    placeholder="https://..."
                    className="flex-1 bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-indigo-500/50 transition"
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addImageUrl())}
                  />
                  <Button variant="secondary" onClick={addImageUrl} className="px-4">
                    Add
                  </Button>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              {/* Preview */}
              <div className="border border-white/[0.06] rounded-xl bg-black/20 p-5">
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">Post Preview</h4>
                <div className="flex gap-4">
                  {imageUrls.length > 0 && (
                    <img src={imageUrls[0]} alt="" className="w-20 h-20 rounded-lg object-cover flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-indigo-300 capitalize flex items-center gap-1">
                        {platform === "tiktok" ? <Music2 size={11} /> : platform === "instagram" ? <ImageIcon size={11} /> : <Globe size={11} />}
                        {platform}
                      </span>
                      <span className="text-xs text-slate-500">·</span>
                      <span className="text-xs text-slate-400 capitalize">{postType.replace("_", " ")}</span>
                    </div>
                    <p className="text-sm text-slate-200 line-clamp-3">{caption || "No caption set"}</p>
                    <p className="text-xs text-slate-500 mt-2">{imageUrls.length} image{imageUrls.length !== 1 ? "s" : ""} attached</p>
                  </div>
                </div>
              </div>

              {/* Schedule */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Schedule Date & Time</label>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-full sm:w-auto bg-black/30 border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-slate-200 outline-none focus:border-indigo-500/50 transition"
                />
                <p className="text-[11px] text-slate-500 mt-1.5">Leave empty and use "Save as Draft" to schedule later</p>
              </div>

              {/* Summary */}
              <div className="border border-white/[0.06] rounded-xl bg-white/[0.01] p-4 space-y-2">
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Summary</h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-slate-500">Platform:</span> <span className="text-slate-200 capitalize ml-1">{platform}</span></div>
                  <div><span className="text-slate-500">Type:</span> <span className="text-slate-200 capitalize ml-1">{postType.replace("_", " ")}</span></div>
                  <div><span className="text-slate-500">Images:</span> <span className="text-slate-200 ml-1">{imageUrls.length}</span></div>
                  <div><span className="text-slate-500">Products:</span> <span className="text-slate-200 ml-1">{selectedSkus.length}</span></div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] bg-black/20">
          <div>
            {step > 1 && (
              <button
                onClick={() => setStep((s) => (s > 1 ? (s - 1) as 1 | 2 : s) as 1 | 2 | 3)}
                className="text-sm text-slate-400 hover:text-white transition"
              >
                &larr; Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {step < 3 ? (
              <Button onClick={() => setStep((s) => (s < 3 ? (s + 1) as 2 | 3 : s) as 1 | 2 | 3)}>
                Next &rarr;
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => handleSubmit(true)} disabled={saving}>
                  Save Draft
                </Button>
                <Button onClick={() => handleSubmit(false)} disabled={saving}>
                  {saving ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Send size={14} className="mr-1.5" />}
                  Schedule Post
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── AI Agent Panel — autonomy + brand voice + Run Now ──────────────────────

type ContentAgentSettings = {
  mode: "off" | "draft" | "auto";
  postsPerDay: number;
  rotationWindowDays: number;
  postingHourStart: number;
  postingHourEnd: number;
  defaultPlatform: string;
  preferredSkus: string[];
  excludedSkus: string[];
  captionStyle: string;
  styleCursor: number;
};

type BrandVoice = {
  tone?: string;
  vocabulary?: string[];
  bannedWords?: string[];
  emojiPreference?: "none" | "minimal" | "balanced" | "expressive";
  hashtagStyle?: "none" | "few" | "many";
  language?: "banglish" | "bangla" | "english";
};

function AgentPanel({ onClose, onAgentRan }: { onClose: () => void; onAgentRan: () => void }) {
  const [agent, setAgent] = useState<ContentAgentSettings | null>(null);
  const [voice, setVoice] = useState<BrandVoice>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ drafted: number; reasoning: string[]; skipped: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ contentAgent: ContentAgentSettings; brandVoice: BrandVoice }>("/api/v1/content-agent");
        if (!cancelled) {
          setAgent(res.contentAgent);
          setVoice(res.brandVoice ?? {});
        }
      } catch (e) {
        console.warn("Load agent settings failed", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (!agent) return;
    setSaving(true);
    try {
      await apiFetch("/api/v1/content-agent", {
        method: "PATCH",
        body: JSON.stringify({ contentAgent: agent, brandVoice: voice }),
      });
    } catch (e) {
      alert("Save failed: " + (e instanceof Error ? e.message : String(e)));
    }
    setSaving(false);
  };

  const runNow = async () => {
    setRunning(true);
    setLastRun(null);
    try {
      const res = await apiFetch<{ ok: boolean; skipped: string | null; drafted: Array<{ postId: string }>; reasoning: string[] }>(
        "/api/v1/content-agent/run-now",
        { method: "POST" },
      );
      setLastRun({ drafted: res.drafted.length, reasoning: res.reasoning, skipped: res.skipped });
      onAgentRan();
    } catch (e) {
      alert("Run failed: " + (e instanceof Error ? e.message : String(e)));
    }
    setRunning(false);
  };

  const inputCls = "w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-indigo-500/50 transition";

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-700/60 rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500/30 to-indigo-500/30 border border-purple-500/30 flex items-center justify-center">
              <Wand2 size={18} className="text-purple-300" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">AI Content Agent</h2>
              <p className="text-xs text-slate-400 mt-0.5">Autonomous post drafter with brand voice memory</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-lg transition">
            <X size={18} className="text-slate-400" />
          </button>
        </div>

        {loading || !agent ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="animate-spin text-indigo-400" size={28} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            {/* Autonomy */}
            <div>
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Autonomy mode</h3>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { id: "off", label: "Off", hint: "Agent disabled" },
                  { id: "draft", label: "Draft for review", hint: "Queue as pending_approval" },
                  { id: "auto", label: "Fully agentic", hint: "Auto-publish at scheduled time" },
                ] as const).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setAgent({ ...agent, mode: m.id })}
                    className={cn(
                      "px-3 py-3 rounded-xl border text-left transition",
                      agent.mode === m.id
                        ? "border-indigo-500/50 bg-indigo-500/10"
                        : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15]",
                    )}
                  >
                    <p className={cn("text-sm font-medium", agent.mode === m.id ? "text-indigo-200" : "text-slate-300")}>{m.label}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">{m.hint}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Schedule */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Posts / day</label>
                <input
                  type="number"
                  min={0} max={10}
                  value={agent.postsPerDay}
                  onChange={(e) => setAgent({ ...agent, postsPerDay: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Rotation (days)</label>
                <input
                  type="number"
                  min={0} max={60}
                  value={agent.rotationWindowDays}
                  onChange={(e) => setAgent({ ...agent, rotationWindowDays: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Hour start</label>
                <input
                  type="number"
                  min={0} max={23}
                  value={agent.postingHourStart}
                  onChange={(e) => setAgent({ ...agent, postingHourStart: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Hour end</label>
                <input
                  type="number"
                  min={0} max={23}
                  value={agent.postingHourEnd}
                  onChange={(e) => setAgent({ ...agent, postingHourEnd: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                  className={inputCls}
                />
              </div>
            </div>

            {/* Caption style + platform */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Caption style</label>
                <select
                  value={agent.captionStyle}
                  onChange={(e) => setAgent({ ...agent, captionStyle: e.target.value })}
                  className={inputCls}
                >
                  <option value="rotate">Rotate styles automatically</option>
                  {CAPTION_STYLES.map((cs) => (
                    <option key={cs.id} value={cs.id}>{cs.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Default platform</label>
                <select
                  value={agent.defaultPlatform}
                  onChange={(e) => setAgent({ ...agent, defaultPlatform: e.target.value })}
                  className={inputCls}
                >
                  <option value="facebook">Facebook</option>
                  <option value="instagram">Instagram</option>
                  <option value="all">Facebook + Instagram</option>
                </select>
              </div>
            </div>

            {/* Brand voice */}
            <div className="border-t border-white/[0.06] pt-5 space-y-4">
              <div className="flex items-center gap-2">
                <Settings2 size={14} className="text-slate-400" />
                <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Brand voice</h3>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Tone description</label>
                <textarea
                  rows={2}
                  value={voice.tone ?? ""}
                  onChange={(e) => setVoice({ ...voice, tone: e.target.value })}
                  placeholder="e.g. Friendly Bangladeshi football fan store. Hype the team. Use Banglish casually."
                  className={cn(inputCls, "resize-none")}
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Language</label>
                  <select
                    value={voice.language ?? "banglish"}
                    onChange={(e) => setVoice({ ...voice, language: e.target.value as BrandVoice["language"] })}
                    className={inputCls}
                  >
                    <option value="banglish">Banglish</option>
                    <option value="bangla">Bangla</option>
                    <option value="english">English</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Emoji</label>
                  <select
                    value={voice.emojiPreference ?? "balanced"}
                    onChange={(e) => setVoice({ ...voice, emojiPreference: e.target.value as BrandVoice["emojiPreference"] })}
                    className={inputCls}
                  >
                    <option value="none">None</option>
                    <option value="minimal">Minimal (1)</option>
                    <option value="balanced">Balanced (1-2)</option>
                    <option value="expressive">Expressive (2-4)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Hashtags</label>
                  <select
                    value={voice.hashtagStyle ?? "none"}
                    onChange={(e) => setVoice({ ...voice, hashtagStyle: e.target.value as BrandVoice["hashtagStyle"] })}
                    className={inputCls}
                  >
                    <option value="none">None</option>
                    <option value="few">Few (2-3)</option>
                    <option value="many">Many (5-8)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">
                  Banned words <span className="text-slate-500 font-normal normal-case">(comma-separated)</span>
                </label>
                <input
                  value={(voice.bannedWords ?? []).join(", ")}
                  onChange={(e) =>
                    setVoice({
                      ...voice,
                      bannedWords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  placeholder="cheap, knockoff, fake"
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase mb-1">
                  Vocabulary preferences <span className="text-slate-500 font-normal normal-case">(comma-separated)</span>
                </label>
                <input
                  value={(voice.vocabulary ?? []).join(", ")}
                  onChange={(e) =>
                    setVoice({
                      ...voice,
                      vocabulary: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  placeholder="bro, ভাই, দারুণ"
                  className={inputCls}
                />
              </div>
            </div>

            {/* Last run summary */}
            {lastRun && (
              <div className="border border-emerald-500/20 bg-emerald-500/5 rounded-xl p-4">
                <p className="text-sm text-emerald-300 font-medium">
                  {lastRun.skipped
                    ? `Skipped: ${lastRun.skipped.replace(/_/g, " ")}`
                    : `Drafted ${lastRun.drafted} post${lastRun.drafted === 1 ? "" : "s"}`}
                </p>
                <details className="mt-2">
                  <summary className="text-[11px] text-slate-400 cursor-pointer">Reasoning trace</summary>
                  <pre className="text-[10px] text-slate-400 mt-2 whitespace-pre-wrap leading-relaxed">{lastRun.reasoning.join("\n")}</pre>
                </details>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] bg-black/20">
          <Button variant="secondary" onClick={runNow} disabled={running || loading || !agent || agent.mode === "off"}>
            {running ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Sparkles size={14} className="mr-1.5" />}
            Run agent now
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button onClick={save} disabled={saving || loading}>
              {saving ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
              Save settings
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── FacebookStatusCard ────────────────────────────────────────────────────
// Single-line status pill at the top of the content calendar page so the
// tenant always knows whether auto-posting will actually reach Facebook.
//
// States:
//   • Loading            — neutral spinner.
//   • OK + page name     — green pill, "Posting to <Page Name>".
//   • Page id missing    — amber, "Page not configured — ask admin".
//   • Token missing      — amber, "Token missing — set in Settings → Pages".
//   • Token rejected     — red,   "Token rejected by Facebook".
//   • Page mismatch      — red,   "Token belongs to a different page".
//
// Defensive: never throws if /facebook-status returns garbage; surfaces a
// friendly fallback. Always offers a "Recheck" action so the tenant can
// retry after fixing the token without reloading the page.

type FacebookStatus = {
  ok: boolean;
  mode: "verified" | "messenger_ok" | "configured" | "broken" | null;
  pageId: string | null;
  hasToken: boolean;
  tokenValid: boolean;
  pageName: string | null;
  pageMatch: boolean;
  note: string | null;
  error: string | null;
};

function FacebookStatusCard() {
  const [data, setData] = useState<FacebookStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const check = useCallback(async () => {
    try {
      const r = await apiFetch<FacebookStatus>("/api/v1/social/facebook-status");
      setData(r);
    } catch (e) {
      setData({
        ok: false,
        mode: "broken",
        pageId: null,
        hasToken: false,
        tokenValid: false,
        pageName: null,
        pageMatch: false,
        note: null,
        error: e instanceof Error ? e.message : "Could not reach the server.",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Choose the right colour scheme + headline based on the status payload.
  let tone: "ok" | "warn" | "fail" = "warn";
  let headline = "Checking Facebook connection…";
  let detail = "";
  if (loading || !data) {
    tone = "warn";
    headline = "Checking Facebook connection…";
    detail = "";
  } else if (data.ok && data.mode === "verified") {
    tone = "ok";
    headline = data.pageName
      ? `Posting to ${data.pageName}`
      : `Connected to page ${data.pageId}`;
    detail = data.note ?? `Page ID ${data.pageId} — token verified with Facebook just now.`;
  } else if (data.ok && data.mode === "messenger_ok") {
    tone = "ok";
    headline = "Connected via Messenger API";
    detail =
      data.note ??
      "Token verified through Messenger. To enable Facebook auto-posting, your app also needs `pages_manage_posts`.";
  } else if (data.ok && data.mode === "configured") {
    tone = "warn";
    headline = "Configured (live verification blocked)";
    detail =
      data.note ??
      "Page ID and token are set, but Facebook won't let an unreviewed app verify the connection. Posting needs `pages_manage_posts` on your app.";
  } else if (!data.pageId) {
    tone = "warn";
    headline = "Facebook page not configured";
    detail = data.error ?? "Ask the admin to set the Page ID for this workspace.";
  } else if (!data.hasToken) {
    tone = "warn";
    headline = "Facebook page token missing";
    detail = data.error ?? "Set the Page Access Token in Settings → Pages.";
  } else if (!data.tokenValid) {
    tone = "fail";
    headline = "Facebook rejected the page token";
    detail = data.error ?? "The token is expired or invalid. Generate a fresh one and update it.";
  } else if (!data.pageMatch) {
    tone = "fail";
    headline = "Token belongs to a different page";
    detail = data.error ?? "Update the token to one for the configured page id.";
  } else {
    tone = "fail";
    headline = "Facebook is not ready";
    detail = data.error ?? "Recheck after updating the page token.";
  }

  const palette = {
    ok: {
      border: "border-emerald-500/30",
      bg: "bg-emerald-500/10",
      ring: "ring-emerald-500/20",
      icon: "text-emerald-300",
      title: "text-emerald-200",
      detail: "text-emerald-100/70",
      Icon: CheckCircle2,
    },
    warn: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/10",
      ring: "ring-amber-500/20",
      icon: "text-amber-300",
      title: "text-amber-200",
      detail: "text-amber-100/70",
      Icon: Loader2,
    },
    fail: {
      border: "border-red-500/30",
      bg: "bg-red-500/10",
      ring: "ring-red-500/20",
      icon: "text-red-300",
      title: "text-red-200",
      detail: "text-red-100/70",
      Icon: XCircle,
    },
  }[tone];

  const Icon = palette.Icon;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border px-4 py-3 ring-1 sm:flex-row sm:items-center sm:gap-3",
        palette.border,
        palette.bg,
        palette.ring,
      )}
    >
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/30")}>
        <Icon
          className={cn("h-5 w-5", palette.icon, tone === "warn" && loading && "animate-spin")}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", palette.title)}>{headline}</p>
        {detail && <p className={cn("mt-0.5 text-xs leading-relaxed", palette.detail)}>{detail}</p>}
      </div>
      <button
        type="button"
        onClick={() => {
          setRefreshing(true);
          check();
        }}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/[0.08] active:scale-[0.98] sm:self-auto",
          refreshing && "opacity-70",
        )}
      >
        <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
        {refreshing ? "Checking…" : "Recheck"}
      </button>
    </div>
  );
}

// ─── PhotoAgentPanel — Cloudinary-folder hype-caption autopilot ──────────
//
// Sister panel to AgentPanel. Different agentic mode: instead of walking the
// catalog, it walks a Cloudinary folder full of lifestyle / brand photos
// and writes short hype captions ("Bomb 🔥", "Poysa ushul") drawing from
// hint phrases the tenant types in. Posts auto-publish on the configured
// schedule — no approval gate.

type PhotoCaptionAgentSettings = {
  enabled: boolean;
  cloudinaryFolder: string;
  captionHints: string[];
  postsPerDay: number;
  postingHourStart: number;
  postingHourEnd: number;
  defaultPlatform: string;
  language: "banglish" | "bangla" | "english" | "mixed";
};

const DEFAULT_PHOTO_AGENT: PhotoCaptionAgentSettings = {
  enabled: false,
  cloudinaryFolder: "",
  captionHints: [],
  postsPerDay: 1,
  postingHourStart: 11,
  postingHourEnd: 19,
  defaultPlatform: "facebook",
  language: "mixed",
};

function PhotoAgentPanel({
  onClose,
  onAgentRan,
}: {
  onClose: () => void;
  onAgentRan: () => void;
}) {
  const [agent, setAgent] = useState<PhotoCaptionAgentSettings>(DEFAULT_PHOTO_AGENT);
  // Free-text textarea — converted to an array on save. Easier UX than a
  // tag-pill input for the kind of phrase a tenant types ("poysa ushul").
  const [hintsText, setHintsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ photoCaptionAgent: PhotoCaptionAgentSettings }>(
          "/api/v1/photo-caption-agent",
        );
        if (!cancelled) {
          setAgent(res.photoCaptionAgent);
          setHintsText((res.photoCaptionAgent.captionHints ?? []).join("\n"));
        }
      } catch {
        // Defaults are fine — surface the empty form.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Convert "one phrase per line OR comma-separated" → string[]. Trim, drop
  // empties, dedupe (case-sensitive — "BOMB" and "bomb" can coexist if the
  // tenant really wants).
  const hintsFromText = (raw: string): string[] => {
    const split = raw.split(/[\n,]+/g);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of split) {
      const t = s.trim();
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out.slice(0, 30);
  };

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const next: PhotoCaptionAgentSettings = {
        ...agent,
        captionHints: hintsFromText(hintsText),
      };
      await apiFetch("/api/v1/photo-caption-agent", {
        method: "PATCH",
        body: JSON.stringify({ photoCaptionAgent: next }),
      });
      setAgent(next);
      setFeedback({ kind: "ok", text: "Saved." });
    } catch (e: any) {
      setFeedback({ kind: "error", text: e?.message ?? "Save failed" });
    }
    setSaving(false);
  };

  const runNow = async () => {
    setRunning(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{
        ok: boolean;
        skipped: string | null;
        drafted: Array<{ postId: string; publicId: string; caption: string }>;
        reasoning: string[];
      }>("/api/v1/photo-caption-agent/run-now", { method: "POST" });
      if (res.skipped) {
        setFeedback({ kind: "error", text: `Skipped: ${res.skipped}` });
      } else if (res.drafted.length === 0) {
        setFeedback({ kind: "error", text: "No drafts created (check the logs / Cloudinary folder)." });
      } else {
        setFeedback({
          kind: "ok",
          text: `Created ${res.drafted.length} post${res.drafted.length === 1 ? "" : "s"} — see calendar.`,
        });
        onAgentRan();
      }
    } catch (e: any) {
      setFeedback({ kind: "error", text: e?.message ?? "Run failed" });
    }
    setRunning(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-slate-950 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-slate-950/95 px-6 py-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-fuchsia-600 shadow-lg shadow-pink-500/30">
              <ImageIcon className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Photo Posts Agent</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Auto-publish hype-caption posts from a Cloudinary folder
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-slate-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {/* Master switch */}
              <div className="flex items-start justify-between gap-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">Photo posts autopilot</p>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                    When enabled, the agent will auto-publish posts from your
                    Cloudinary folder using a random photo + a hype-style
                    caption. Photos rotate without repeating until the folder
                    is exhausted.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                  <input
                    type="checkbox"
                    checked={agent.enabled}
                    onChange={(e) => setAgent({ ...agent, enabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-10 h-5 rounded-full bg-slate-700 peer-checked:bg-emerald-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-5" />
                </label>
              </div>

              {/* Cloudinary folder path */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Cloudinary folder path
                </label>
                <input
                  value={agent.cloudinaryFolder}
                  onChange={(e) => setAgent({ ...agent, cloudinaryFolder: e.target.value })}
                  placeholder="e.g. lifestyle/wc26/"
                  className="w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-pink-500/40 focus:outline-none"
                />
                <p className="mt-1.5 text-[11px] text-slate-500">
                  Use the folder prefix as it appears in your Cloudinary
                  Media Library. Leave blank to fall back to the platform
                  default.
                </p>
              </div>

              {/* Caption hints */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Caption hint phrases
                </label>
                <textarea
                  value={hintsText}
                  onChange={(e) => setHintsText(e.target.value)}
                  rows={5}
                  placeholder={"bomb\npoysa ushul\nfresh stock\nlimited drop\nekdom mass\ntrending now"}
                  className="w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-pink-500/40 focus:outline-none font-mono"
                />
                <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
                  One phrase per line (or separate with commas). The agent
                  picks 1-5 of these per post and weaves them into a short
                  caption. Mix Banglish, Bangla, English — whatever sounds
                  natural for your shop.
                </p>
                {hintsFromText(hintsText).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {hintsFromText(hintsText).map((h, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center rounded-full bg-pink-500/10 border border-pink-500/30 px-2 py-0.5 text-[10px] font-medium text-pink-300"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Cadence + window */}
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Posts per day
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={agent.postsPerDay}
                    onChange={(e) =>
                      setAgent({ ...agent, postsPerDay: Number(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-slate-100 focus:border-pink-500/40 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    From hour
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={agent.postingHourStart}
                    onChange={(e) =>
                      setAgent({ ...agent, postingHourStart: Number(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-slate-100 focus:border-pink-500/40 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    To hour
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={agent.postingHourEnd}
                    onChange={(e) =>
                      setAgent({ ...agent, postingHourEnd: Number(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-slate-100 focus:border-pink-500/40 focus:outline-none"
                  />
                </div>
              </div>

              {/* Language */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">
                  Caption language
                </label>
                <select
                  value={agent.language}
                  onChange={(e) =>
                    setAgent({
                      ...agent,
                      language: e.target.value as PhotoCaptionAgentSettings["language"],
                    })
                  }
                  className="w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-slate-100 focus:border-pink-500/40 focus:outline-none"
                >
                  <option value="mixed">Mixed (Banglish + English) — recommended</option>
                  <option value="banglish">Banglish only</option>
                  <option value="bangla">Bangla (in Bangla script)</option>
                  <option value="english">English only</option>
                </select>
              </div>

              {feedback && (
                <div
                  className={cn(
                    "rounded-lg border px-3 py-2 text-xs",
                    feedback.kind === "ok"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : "border-red-500/30 bg-red-500/10 text-red-200",
                  )}
                >
                  {feedback.text}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-white/[0.06]">
                <Button variant="ghost" onClick={onClose} className="text-xs">
                  Close
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={runNow}
                    disabled={running || saving || !agent.enabled || !agent.cloudinaryFolder}
                    className="gap-1.5"
                  >
                    {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                    Run now (test)
                  </Button>
                  <Button onClick={save} disabled={saving || running} className="gap-1.5">
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Save
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
