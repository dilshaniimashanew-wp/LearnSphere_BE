import { Router } from "express";
import { protect } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { notFound } from "../../shared/errors.js";
import { assertCanViewContent, assertOwner, assertOwnerOrAdmin, loadCourse, oid } from "../../shared/helpers.js";
import { Assignment } from "./assessment.model.js";
import { createAssignmentBody, gradeBody, submissionBody } from "./assignment.schemas.js";
import * as assignments from "./assignment.service.js";

export const assignmentsRouter = Router();

async function loadAssignment(id: unknown) {
  const assignment = await Assignment.findById(oid(id));
  if (!assignment) throw notFound("Assignment not found");
  return assignment;
}

// ---------- Instructor ----------
assignmentsRouter.post("/courses/:courseId/assignments", ...protect("instructor"), validateBody(createAssignmentBody), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  assertOwner(course, req.user!);
  const assignment = await assignments.createAssignment(course, req.body);
  res.status(201).json({ data: assignments.assignmentDto(assignment), message: "Assignment created" });
});

assignmentsRouter.get("/assignments/:assignmentId/submissions", ...protect("instructor", "admin"), async (req, res) => {
  const assignment = await loadAssignment(req.params.assignmentId);
  assertOwnerOrAdmin(await loadCourse(assignment.courseId), req.user!);
  res.json({ data: await assignments.listSubmissionsForAssignment(assignment.id) });
});

assignmentsRouter.get("/instructor/submissions", ...protect("instructor", "admin"), async (req, res) => {
  res.json({ data: await assignments.listForInstructor(req.user!, req.query) });
});

assignmentsRouter.patch("/submissions/:submissionId/grade", ...protect("instructor", "admin"), validateBody(gradeBody), async (req, res) => {
  const submission = await assignments.gradeSubmission(oid(req.params.submissionId), req.user!, req.body);
  res.json({ data: assignments.submissionDto(submission), message: "Graded" });
});

// ---------- Reading ----------
assignmentsRouter.get("/courses/:courseId/assignments", ...protect(), async (req, res) => {
  const course = await loadCourse(req.params.courseId);
  await assertCanViewContent(course, req.user!);
  res.json({ data: await assignments.listForCourse(course, req.user!) });
});

// Registered before "/assignments/:assignmentId" so "me" is not read as an id.
assignmentsRouter.get("/assignments/me", ...protect("student"), async (req, res) => {
  res.json({ data: await assignments.listForStudent(req.user!) });
});

assignmentsRouter.get("/assignments/:assignmentId", ...protect(), async (req, res) => {
  const assignment = await loadAssignment(req.params.assignmentId);
  await assertCanViewContent(await loadCourse(assignment.courseId), req.user!);
  res.json({ data: assignments.assignmentDto(assignment) });
});

// ---------- Student ----------
assignmentsRouter.post("/assignments/:assignmentId/submissions", ...protect("student"), validateBody(submissionBody), async (req, res) => {
  const submission = await assignments.submitWork(oid(req.params.assignmentId), req.user!, req.body);
  res.status(201).json({ data: assignments.submissionDto(submission), message: "Submitted" });
});
