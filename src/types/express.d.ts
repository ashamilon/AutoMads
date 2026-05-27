declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      tenant?: import("@prisma/client").Tenant;
      /**
       * Set by `requireSuperAdmin` middleware when the request carries a
       * valid SuperAdminSession token. Distinct from `tenant` — never
       * carries a tenantId (R20.7); downstream code must pass tenantId
       * explicitly when acting on a specific tenant.
       */
      superAdmin?: import("../services/admin/superAdminAuth.js").SuperAdminContext;
    }
  }
}

export {};
