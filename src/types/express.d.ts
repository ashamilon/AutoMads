declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      tenant?: import("@prisma/client").Tenant;
    }
  }
}

export {};
