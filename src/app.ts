import express, { type Request } from "express";
import path from "node:path";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { logger } from "./utils/logger.js";
import { config } from "./config/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { adminRoutes } from "./routes/adminRoutes.js";
import { facebookRoutes } from "./routes/facebookRoutes.js";
import { sslcommerzRoutes } from "./routes/sslcommerzRoutes.js";
import { aamarpayRoutes } from "./routes/aamarpayRoutes.js";
import { bkashRoutes } from "./routes/bkashRoutes.js";
import { steadfastRoutes } from "./routes/steadfastRoutes.js";
import { clientRoutes } from "./routes/clientRoutes.js";
import { tenantPortalRoutes } from "./routes/tenantPortalRoutes.js";
import { onboardingRoutes } from "./routes/onboardingRoutes.js";
import { billingRoutes } from "./routes/billingRoutes.js";
import { facebookOAuthCallback } from "./controllers/facebookOAuthController.js";
import { adminPanelRoutes } from "./routes/adminPanelRoutes.js";
import { authAuthenticatedRoutes, authPublicRoutes } from "./routes/authRoutes.js";
import { agentDebugRoutes } from "./routes/agentDebugRoutes.js";
import { telegramRoutes } from "./routes/telegramRoutes.js";
import { serveMessengerCatalogImage } from "./controllers/catalogMessengerImageController.js";

export function createApp(): express.Application {
  const app = express();

  // Trust the first proxy (ngrok / production load balancer). Required so
  // express-rate-limit reads X-Forwarded-For correctly and stops warning.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "script-src": ["'self'"],
          "img-src": ["'self'", "data:", "https:"],
        },
      },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        // No origin = same-origin / curl / server-side: allow.
        if (!origin) return cb(null, true);
        const allowed = config.corsAllowedOrigins;
        // Empty allow-list = development convenience: accept anything.
        if (allowed.length === 0) return cb(null, true);
        if (allowed.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin not allowed: ${origin}`));
      },
      credentials: true,
    }),
  );
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  app.use(
    pinoHttp({
      logger,
      autoLogging: true,
    }),
  );

  const limiter = rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "facebook-order-automation-saas" });
  });

  /** Relay catalog images so Meta can attach them when upstream CDNs reject Facebook fetchers */
  app.get("/public/messenger-catalog-image", serveMessengerCatalogImage);

  app.use(express.static(path.join(process.cwd(), "public")));
  app.get("/", (_req, res) => {
    res.redirect("/admin/index.html");
  });
  app.get("/admin", (_req, res) => {
    res.redirect("/admin/index.html");
  });

  // Developer debug endpoint (task 11.1). Mounted BEFORE `/admin` so the admin-key
  // middleware on `adminRoutes` doesn't intercept tenant-key requests to
  // `/admin/snapshot/...`. Auth is handled inside the sub-router via
  // `requireTenantApiKey`, mirroring `tenantPortalRoutes.ts`.
  app.use("/admin/snapshot", agentDebugRoutes);
  app.use("/admin", adminRoutes);
  app.use("/webhooks/facebook", facebookRoutes);
  app.use("/webhooks/sslcommerz", sslcommerzRoutes);
  app.use("/webhooks/aamarpay", aamarpayRoutes);
  app.use("/webhooks/bkash", bkashRoutes);
  app.use("/webhooks/steadfast", steadfastRoutes);
  app.use("/webhooks/telegram", telegramRoutes);
  app.use("/webhooks/client", clientRoutes);
  // Public Facebook OAuth callback. Meta redirects the user's browser here
  // after they consent in the popup; auth is handled via the signed `state`
  // parameter, NOT a tenant API key (the user has no session at this point).
  app.get("/oauth/facebook/callback", facebookOAuthCallback);
  app.use("/api/v1/auth", authPublicRoutes);
  app.use("/api/v1/auth", authAuthenticatedRoutes);
  app.use("/api/v1/billing", billingRoutes);
  app.use("/api/v1/admin", adminPanelRoutes);
  app.use("/api/v1/onboarding", onboardingRoutes);
  app.use("/api/v1", tenantPortalRoutes);

  app.use(errorHandler);
  return app;
}
