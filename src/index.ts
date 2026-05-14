import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";

const app = createApp();

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server listening");
});
