import { app } from "./app.js";
import { connectDb } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";

async function main() {
  await connectDb();
  app.listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}/api/v1`));
}

main().catch((err) => {
  logger.error({ message: err.message }, "Failed to start server");
  process.exit(1);
});
