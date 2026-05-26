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
import {
  activate,
  changePassword,
  getSession,
  login,
  logout,
} from "../controllers/authController.js";
import { requireTenantApiKey } from "../middlewares/tenantApiAuth.js";

export const authPublicRoutes = Router();
authPublicRoutes.post("/activate", activate);
authPublicRoutes.post("/login", login);
authPublicRoutes.post("/logout", logout);

export const authAuthenticatedRoutes = Router();
authAuthenticatedRoutes.use(requireTenantApiKey);
authAuthenticatedRoutes.get("/session", getSession);
authAuthenticatedRoutes.post("/change-password", changePassword);
