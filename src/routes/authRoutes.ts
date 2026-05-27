/**
 * Public + authenticated tenant auth endpoints.
 *
 * Public (no middleware):
 *   - POST /auth/activate
 *   - POST /auth/login
 *   - POST /auth/logout (no-op on missing session)
 *
 * Authenticated (require valid session OR api key):
 *   - GET  /auth/session
 *   - POST /auth/change-password
 */

import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  activate,
  changePassword,
  getSession,
  login,
  logout,
} from "../controllers/authController.js";
import { requireTenantApiKey } from "../middlewares/tenantApiAuth.js";

// Tight rate-limit on the auth surface so a leaked password / activation
// token can't be brute-forced from a single IP. The global limiter (300 req
// / minute) still applies; this stacks an additional 20 req / 15 min for the
// public auth endpoints specifically.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", detail: "Too many auth attempts. Try again in a few minutes." },
});

export const authPublicRoutes = Router();
authPublicRoutes.post("/activate", authLimiter, activate);
authPublicRoutes.post("/login", authLimiter, login);
authPublicRoutes.post("/logout", logout);

export const authAuthenticatedRoutes = Router();
authAuthenticatedRoutes.use(requireTenantApiKey);
authAuthenticatedRoutes.get("/session", getSession);
authAuthenticatedRoutes.post("/change-password", changePassword);
