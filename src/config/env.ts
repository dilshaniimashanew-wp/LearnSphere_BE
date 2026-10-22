import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  APP_ORIGIN: z.string().url(),
  // Max auth requests (login/register/forgot-password) per IP per 15 minutes
  // Max requests to the whole API per IP per 15 minutes
  API_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  // Number of reverse proxies in front of the API (so the real client IP is used for rate limits)
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  // Optional comma-separated DNS servers, for networks whose DNS cannot resolve mongodb+srv records
  DNS_SERVERS: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
