"use client";

import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { apiFetch } from "@/lib/api";
import { ImagePlus, Loader2, Play, RotateCcw, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

type SimMessage = {
  role: string;
  text: string;
  imageUrl?: string;
  createdAt: string;
};

type SimResponse = {
  ok: boolean;
  psid: string;
  reply: string;
  messages: SimMessage[];
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SandboxPage() {
  const [psid, setPsid] = useState("");
  const [text, setText] = useState("");
  const [attachedImages, setAttachedImages] = useState<{ file: File; preview: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [messages, setMessages] = useState<SimMessage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ordered = useMemo(() => [...messages].reverse(), [messages]);

  async function send() {
    const hasText = text.trim().length > 0;
    const hasImages = attachedImages.length > 0;
    if ((!hasText && !hasImages) || loading) return;
    setLoading(true);
    setError("");
    try {
      let imageBase64: string[] | undefined;
      if (hasImages) {
        imageBase64 = await Promise.all(
          attachedImages.map((img) => fileToBase64(img.file))
        );
      }
      const res = await apiFetch<SimResponse>("/api/v1/chat/simulate", {
        method: "POST",
        body: JSON.stringify({
          text: text.trim() || "",
          psid: psid.trim() || undefined,
          ...(imageBase64 ? { imageBase64 } : {}),
        }),
      });
      if (!psid.trim()) setPsid(res.psid);
      setReply(res.reply || "");
      setMessages(res.messages || []);
      setText("");
      setAttachedImages([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setLoading(false);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const newImages = files.slice(0, 5 - attachedImages.length).map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));
    setAttachedImages((prev) => [...prev, ...newImages].slice(0, 5));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(idx: number) {
    setAttachedImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[idx]!.preview);
      next.splice(idx, 1);
      return next;
    });
  }

  function resetSession() {
    setPsid("");
    setText("");
    setReply("");
    setMessages([]);
    setError("");
    attachedImages.forEach((img) => URL.revokeObjectURL(img.preview));
    setAttachedImages([]);
  }

  return (
    <div className="space-y-6">
      <Section
        title="Chat Sandbox"
        description="Test bot responses instantly without opening Facebook Page inbox."
        actions={
          <Button type="button" variant="ghost" className="gap-2" onClick={resetSession}>
            <RotateCcw className="h-4 w-4" />
            Reset session
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="sm:col-span-1">
            <span className="label-caps mb-1.5 block">Simulator PSID</span>
            <input
              value={psid}
              onChange={(e) => setPsid(e.target.value)}
              placeholder="Auto-generated if empty"
              className={inputCls}
            />
            <p className="mt-1.5 text-[11px] text-slate-500">
              Keep same PSID to continue same conversation memory.
            </p>
          </label>
          <label className="sm:col-span-2">
            <span className="label-caps mb-1.5 block">Customer message</span>
            <div className="flex items-end gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="e.g. Argentina home jersey lagbe"
                className={`${inputCls} min-h-[5rem] resize-y leading-relaxed`}
              />
              <div className="flex shrink-0 flex-col gap-2 self-end">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach photo"
                  className="h-10 w-10 !p-0"
                >
                  <ImagePlus className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  disabled={loading || (!text.trim() && attachedImages.length === 0)}
                  onClick={() => void send()}
                  className="gap-2"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Send
                </Button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
        </div>

        {attachedImages.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {attachedImages.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={img.preview}
                  alt={`attachment ${i + 1}`}
                  className="h-16 w-16 rounded-lg border border-white/10 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white group-hover:flex"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <p className="self-center text-[11px] text-slate-500">
              {attachedImages.length}/5 photos attached
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </Section>

      <Section title="Latest Reply">
        <pre className="max-h-48 overflow-auto rounded-xl border border-white/[0.08] bg-black/30 p-4 text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">
          {reply || "No reply yet."}
        </pre>
      </Section>

      <Section title="Conversation Trace">
        <div className="max-h-[32rem] space-y-2 overflow-auto rounded-xl border border-white/[0.08] bg-black/20 p-3">
          {ordered.length === 0 ? (
            <p className="px-2 py-1 text-sm text-slate-500">No messages yet.</p>
          ) : (
            ordered.map((m, i) => (
              <div
                key={`${m.createdAt}-${i}`}
                className={`rounded-lg px-3 py-2 text-sm ${
                  m.role === "assistant"
                    ? "border border-indigo-400/20 bg-indigo-500/10 text-indigo-100"
                    : "border border-white/[0.08] bg-white/[0.03] text-slate-200"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">{m.role}</span>
                  <span className="text-[11px] text-slate-500">{new Date(m.createdAt).toLocaleTimeString()}</span>
                </div>
                {m.imageUrl && (
                  <img
                    src={m.imageUrl}
                    alt="attachment"
                    className="mb-2 max-h-48 rounded-lg border border-white/10 object-contain"
                    loading="lazy"
                  />
                )}
                {m.text && <div className="whitespace-pre-wrap">{m.text}</div>}
              </div>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2.5 text-sm font-medium text-slate-100 placeholder:text-slate-600 focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30";
