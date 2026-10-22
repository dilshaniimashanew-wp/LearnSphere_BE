import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found", details: [] } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Duplicate key from a unique index (e.g. a registration race on email).
  if (err?.code === 11000) {
    res.status(409).json({ error: { code: "CONFLICT", message: "Resource already exists", details: [] } });
    return;
  }
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong", details: [] } });
};
