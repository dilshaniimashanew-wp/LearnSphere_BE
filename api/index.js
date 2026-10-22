// Vercel serverless entry point. Every /api/* request is routed here (see vercel.json).
// It serves the compiled Express app from dist/, which `npm run build` produces during the Vercel build.
import { app } from "../dist/app.js";
import { connectDb } from "../dist/config/db.js";

export default async function handler(req, res) {
  await connectDb();
  return app(req, res);
}
