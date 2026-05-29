import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { startPostScheduler } from "./services/postSchedulerService.js";
import { bootstrapSuperAdminFromEnv } from "./services/admin/superAdminAuth.js";
import { installOpenRouterAdapter } from "./llm/openRouterAdapter.js";

// Install the OpenRouter axios adapter BEFORE creating the app so any
// request fired during route registration is already rerouted. No-op when
// OPENROUTER_API_KEY is unset.
installOpenRouterAdapter();

const app = createApp();

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server listening");
  startPostScheduler();
  // Idempotent: only creates a SuperAdmin if env vars are set AND no row
  // exists for that email. Failures are logged but do not abort boot.
  bootstrapSuperAdminFromEnv().catch((err: unknown) => {
    logger.error(
      { event: "super_admin_bootstrap_failed", err: String(err) },
      "super admin bootstrap failed at boot",
    );
  });
});
