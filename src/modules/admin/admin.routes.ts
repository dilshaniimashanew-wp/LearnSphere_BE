import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { audit, escapeRegex, loadCourse, notify, oid, paginate, slugify } from "../../shared/helpers.js";
import { Category, Course, COURSE_STATUSES } from "../courses/course.model.js";
import { presentCourse, presentCourses } from "../courses/course.presenter.js";
import { rejectCourseBody } from "../courses/course.schemas.js";
import * as courseService from "../courses/course.service.js";
import { AuditLog } from "../platform/platform.model.js";
import { ROLES, User, toPublicUser } from "../users/user.model.js";

export const adminRouter = Router();
adminRouter.use("/admin", authenticate, requireRole("admin"));

// ---------- Users ----------
adminRouter.get("/admin/users", async (req, res) => {
  const { page, pageSize, skip } = paginate(req.query, 20);
  const filter: Record<string, unknown> = {};
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { email: new RegExp(escapeRegex(q), "i") }];
  if (typeof req.query.role === "string" && (ROLES as readonly string[]).includes(req.query.role)) filter.role = req.query.role;
  const [users, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize), User.countDocuments(filter)]);
  res.json({ data: { items: users.map((u) => ({ ...toPublicUser(u), createdAt: u.createdAt })), page, pageSize, total } });
});

const statusBody = z.object({ status: z.enum(["active", "suspended"]) }).strict();
adminRouter.patch("/admin/users/:userId/status", validateBody(statusBody), async (req, res) => {
  const user = await User.findById(oid(req.params.userId));
  if (!user) throw notFound("User not found");
  if (user.id === req.user!.id) throw forbidden("You cannot change your own status");
  user.status = req.body.status;
  await user.save();
  await audit(req.user!, `user.${req.body.status === "suspended" ? "suspend" : "reactivate"}`, "user", user.id, { email: user.email });
  res.json({ data: toPublicUser(user), message: `User ${req.body.status}` });
});

// ---------- Course moderation ----------
adminRouter.get("/admin/courses", async (req, res) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === "string" && (COURSE_STATUSES as readonly string[]).includes(req.query.status)) filter.status = req.query.status;
  const courses = await Course.find(filter).sort({ updatedAt: -1 }).limit(200);
  res.json({ data: await presentCourses(courses) });
});

adminRouter.get("/admin/courses/pending", async (_req, res) => {
  const courses = await Course.find({ status: "pending_review" }).sort({ updatedAt: 1 });
  res.json({ data: await presentCourses(courses) });
});

adminRouter.patch("/admin/courses/:courseId/approve", async (req, res) => {
  const course = await courseService.approveCourse(await loadCourse(req.params.courseId), req.user!);
  res.json({ data: await presentCourse(course), message: "Course approved" });
});

adminRouter.patch("/admin/courses/:courseId/reject", validateBody(rejectCourseBody), async (req, res) => {
  const course = await courseService.rejectCourse(await loadCourse(req.params.courseId), req.user!, req.body.note);
  res.json({ data: await presentCourse(course), message: "Course rejected" });
});

// ---------- Categories ----------
adminRouter.get("/admin/categories", async (_req, res) => {
  const cats = await Category.find().sort({ name: 1 }).lean();
  const items = await Promise.all(
    cats.map(async (c) => ({ id: String(c._id), name: c.name, slug: c.slug, active: c.active, courses: await Course.countDocuments({ categoryId: c._id }) })),
  );
  res.json({ data: items });
});

const categoryBody = z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).optional() }).strict();
adminRouter.post("/admin/categories", validateBody(categoryBody), async (req, res) => {
  const slug = slugify(req.body.name);
  if (await Category.exists({ $or: [{ slug }, { name: new RegExp(`^${escapeRegex(req.body.name)}$`, "i") }] })) throw conflict("A category with this name already exists");
  const cat = await Category.create({ ...req.body, slug });
  await audit(req.user!, "category.create", "category", cat.id, { name: cat.name });
  res.status(201).json({ data: { id: cat.id, name: cat.name, slug: cat.slug, active: cat.active }, message: "Category created" });
});

adminRouter.delete("/admin/categories/:categoryId", async (req, res) => {
  const cat = await Category.findById(oid(req.params.categoryId));
  if (!cat) throw notFound("Category not found");
  if (await Course.exists({ categoryId: cat._id })) throw badRequest("This category has courses. Deactivate it instead of deleting.");
  await cat.deleteOne();
  await audit(req.user!, "category.delete", "category", cat.id, { name: cat.name });
  res.json({ message: "Category deleted" });
});

// ---------- Audit logs ----------
adminRouter.get("/admin/audit-logs", async (req, res) => {
  const { page, pageSize, skip } = paginate(req.query, 25);
  const [logs, total] = await Promise.all([AuditLog.find().sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(), AuditLog.countDocuments()]);
  const actors = await User.find({ _id: { $in: logs.map((l) => l.actorId) } }).select("name").lean();
  const names = new Map(actors.map((a) => [String(a._id), a.name]));
  res.json({
    data: {
      items: logs.map((l) => ({
        id: String(l._id),
        when: l.createdAt,
        actor: names.get(String(l.actorId)) ?? "Unknown",
        action: l.action,
        target: (l.metadata as { title?: string; email?: string; name?: string } | undefined)?.title ?? (l.metadata as { email?: string; name?: string } | undefined)?.email ?? (l.metadata as { name?: string } | undefined)?.name ?? l.targetId,
      })),
      page,
      pageSize,
      total,
    },
  });
});
