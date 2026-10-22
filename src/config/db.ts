import dns from "node:dns";
import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../shared/logger.js";

let connecting: Promise<void> | undefined;

/** Connects once. Safe to call on every request: serverless functions reuse the connection while warm. */
export function connectDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  connecting ??= (async () => {
    if (env.DNS_SERVERS) dns.setServers(env.DNS_SERVERS.split(",").map((s) => s.trim()));
    mongoose.set("strictQuery", true);
    // A small pool: every serverless instance holds its own connections, and Atlas limits the total.
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 5 });
    logger.info({ db: mongoose.connection.name }, "MongoDB connected");
  })().catch((error) => {
    connecting = undefined; // let the next request retry
    throw error;
  });
  return connecting;
}
