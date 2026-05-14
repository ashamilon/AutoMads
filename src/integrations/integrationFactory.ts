import type { IntegrationType } from "@prisma/client";
import type { ClientIntegrationAdapter } from "./integration.types.js";
import { ApiClientAdapter } from "./client-api/apiAdapter.js";
import { DbClientAdapter } from "./client-db/dbAdapter.js";
import { WebhookClientAdapter } from "./webhooks/webhookAdapter.js";

const api = new ApiClientAdapter();
const db = new DbClientAdapter();
const hook = new WebhookClientAdapter();

export function getIntegrationAdapter(type: IntegrationType): ClientIntegrationAdapter {
  switch (type) {
    case "API":
      return api;
    case "DATABASE":
      return db;
    case "WEBHOOK":
      return hook;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
