import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll } from "vitest";

// Runs before each test file imports the app, so config is read from these values and never from .env.
const mongod = await MongoMemoryServer.create();
process.env.NODE_ENV = "test";
process.env.DOTENV_CONFIG_PATH = "tests/.no-env-file";
process.env.MONGODB_URI = mongod.getUri("learnsphere_test");
process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.AUTH_RATE_LIMIT = "10000";
process.env.API_RATE_LIMIT = "100000";
delete process.env.DNS_SERVERS;

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
