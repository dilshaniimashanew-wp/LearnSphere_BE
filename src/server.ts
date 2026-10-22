import mongoose from "mongoose";
import { app } from "./app.js";
import { connectDb } from "./config/db.js";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";

async function main() {
  await connectDb();
  const server = app.listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}/api/v1`));

  // Stop accepting requests, let in-flight ones finish, then close the database connection.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled promise rejection"));

main().catch((err) => {
  logger.error({ message: err.message }, "Failed to start server");
  process.exit(1);
});
