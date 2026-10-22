import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { assignmentsRouter } from "./modules/assessments/assignments.routes.js";
import { quizzesRouter } from "./modules/assessments/quizzes.routes.js";
import { coursesRouter } from "./modules/courses/courses.routes.js";
import { engagementRouter } from "./modules/engagement/engagement.routes.js";
import { enrollmentsRouter } from "./modules/enrollments/enrollments.routes.js";
import { platformRouter } from "./modules/platform/platform.routes.js";
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
// Routers with public endpoints come first. The three below call authenticate for every request
// that reaches them, so they must stay last.
api.use(coursesRouter);
api.use(engagementRouter);
api.use(platformRouter);
api.use(analyticsRouter);
api.use(adminRouter);
api.use(enrollmentsRouter);
api.use(quizzesRouter);
api.use(assignmentsRouter);

app.use("/api/v1", api);
app.use(notFoundHandler);
app.use(errorHandler);
