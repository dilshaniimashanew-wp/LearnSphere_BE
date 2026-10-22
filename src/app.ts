import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: [env.APP_ORIGIN], credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

const api = express.Router();
api.get("/health", (_req, res) => {
  res.json({ data: { status: "ok", db: mongoose.connection.readyState === 1 ? "connected" : "disconnected" } });
});
api.use("/auth", authRouter);
api.use("/users", usersRouter);

app.use("/api/v1", api);
app.use(notFoundHandler);
app.use(errorHandler);
