import pino from "pino";

// Never log passwords, cookies or tokens. Redact them if they ever end up in a logged object.
export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]', "password", "passwordHash", "token", "refreshToken"],
});
