/// <reference types="multer" />
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { parseTenantSettings } from "../types/tenant-settings.js";
import {
  fileSupportedForPersona,
  gatherTextFromUploads,
  synthesizePersonaFromTranscript,
} from "../services/personaLearnService.js";
import { logger } from "../utils/logger.js";

export async function learnPersonaFromUploads(req: Request, res: Response): Promise<void> {
  const t = req.tenant!;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const paste = typeof req.body?.paste === "string" ? req.body.paste : "";

  for (const f of files) {
    if (!fileSupportedForPersona(f)) {
      res.status(400).json({ error: "unsupported_file", name: f.originalname });
      return;
    }
  }

  if (files.length === 0 && !paste.trim()) {
    res.status(400).json({ error: "no_input", hint: "Add pasted text and/or supported files (txt, csv, png, jpg, webp)." });
    return;
  }

  try {
    const combined = await gatherTextFromUploads(files, paste);
    if (combined.trim().length < 40) {
      res.status(400).json({
        error: "not_enough_text",
        hint: "Could not read enough text. For images, try clearer screenshots; add a text export or paste.",
      });
      return;
    }

    const persona = await synthesizePersonaFromTranscript(combined, t.name);
    const current = parseTenantSettings(t.settings);
    const nextSettings = {
      ...current,
      botPersona: {
        ...(typeof current.botPersona === "object" && current.botPersona !== null ? current.botPersona : {}),
        name: persona.name ?? (current.botPersona as { name?: string } | undefined)?.name,
        tone: persona.tone,
        examples: persona.examples,
      },
    };

    const updated = await prisma.tenant.update({
      where: { id: t.id },
      data: { settings: nextSettings as Prisma.InputJsonValue },
    });

    res.json({
      ok: true,
      botPersona: (nextSettings as { botPersona: unknown }).botPersona,
      settings: updated.settings,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "not_enough_text") {
      res.status(400).json({ error: "not_enough_text" });
      return;
    }
    logger.error({ e }, "persona learn failed");
    res.status(500).json({ error: "persona_synthesis_failed", detail: msg });
  }
}
