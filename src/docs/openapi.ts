import { z, type ZodType } from "zod";
import { statusBody, categoryBody } from "../modules/admin/admin.routes.js";
import { createAssignmentBody, gradeBody, submissionBody } from "../modules/assessments/assignment.schemas.js";
import { createQuizBody, submitAttemptBody, updateQuizBody } from "../modules/assessments/quiz.schemas.js";
import { forgotPasswordSchema, loginSchema, registerSchema } from "../modules/auth/auth.schemas.js";
import {
  createCourseBody,
  createLessonBody,
  createModuleBody,
  rejectCourseBody,
  reorderLessonsBody,
  reorderModulesBody,
  updateCourseBody,
  updateLessonBody,
  updateModuleBody,
} from "../modules/courses/course.schemas.js";
import { announcementBody, reviewBody } from "../modules/engagement/engagement.routes.js";
import { progressBody } from "../modules/enrollments/enrollments.routes.js";
import { changePasswordSchema, updateProfileSchema } from "../modules/users/users.routes.js";

type Method = "get" | "post" | "put" | "patch" | "delete";
type Access = "public" | "user" | "student" | "instructor" | "admin" | "instructor or admin";

interface Operation {
  tag: string;
  summary: string;
  access: Access;
  description?: string;
  body?: ZodType;
  query?: { name: string; description: string; schema?: Record<string, unknown> }[];
  created?: boolean;
  noContent?: boolean;
  errors?: number[];
}

const paths: Record<string, Partial<Record<Method, unknown>>> = {};

const toSchema = (schema: ZodType) =>
  z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    target: "openapi-3.0",
    override: (ctx) => {
      const def = (ctx.zodSchema as unknown as { _zod: { def: { type: string } } })._zod.def;
      if (def.type === "date") Object.assign(ctx.jsonSchema, { type: "string", format: "date-time" });
    },
  });

const errorRefs = (codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/E${c}` }]));

function add(method: Method, path: string, op: Operation) {
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
  const query = (op.query ?? []).map((q) => ({ name: q.name, in: "query", description: q.description, schema: q.schema ?? { type: "string" } }));
  const errors = new Set<number>([429, ...(op.errors ?? [])]);
  if (op.body) errors.add(400);
  if (op.access !== "public") errors.add(401);
  if (op.access !== "public" && op.access !== "user") errors.add(403);

  (paths[path] ??= {})[method] = {
    tags: [op.tag],
    summary: op.summary,
    description: [op.description, `**Access:** ${op.access === "public" ? "public" : op.access === "user" ? "any signed-in user" : op.access}.`]
      .filter(Boolean)
      .join("\n\n"),
    security: op.access === "public" ? [] : [{ cookieAuth: [] }],
    parameters: [...params, ...query],
    ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: toSchema(op.body) } } } } : {}),
    responses: {
      [op.created ? "201" : "200"]: {
        description: op.created ? "Created" : "Success",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } },
      },
      ...errorRefs([...errors].sort()),
    },
  };
}

const page = [
  { name: "page", description: "Page number, from 1", schema: { type: "integer", minimum: 1 } },
  { name: "pageSize", description: "Items per page (max 100)", schema: { type: "integer", minimum: 1, maximum: 100 } },
];

// ---------- Health ----------
add("get", "/health", { tag: "Health", summary: "Service and database status", access: "public" });

// ---------- Auth ----------
add("post", "/auth/register", {
  tag: "Auth",
  summary: "Create a student or instructor account",
  access: "public",
  body: registerSchema,
  created: true,
  errors: [409],
  description: "Signs the new user in. Admin accounts cannot be registered here.",
});
add("post", "/auth/login", {
  tag: "Auth",
  summary: "Sign in",
  access: "public",
  body: loginSchema,
  errors: [401],
  description: "Sets an HttpOnly access cookie (15 minutes) and a refresh cookie (7 days). After 5 wrong passwords the account is locked for 15 minutes (429).",
});
add("post", "/auth/refresh", {
  tag: "Auth",
  summary: "Rotate the session",
  access: "public",
  errors: [401],
  description: "Uses the refresh cookie to issue a new access and refresh token. Re-using an old refresh token revokes all sessions of that user.",
});
add("post", "/auth/logout", { tag: "Auth", summary: "Sign out this device", access: "public" });
add("get", "/auth/me", { tag: "Auth", summary: "Current user", access: "user" });
add("post", "/auth/forgot-password", {
  tag: "Auth",
  summary: "Request a password reset email",
  access: "public",
  body: forgotPasswordSchema,
  description: "Always answers the same way, whether or not the account exists. Email delivery is not implemented yet.",
});

// ---------- Users ----------
add("get", "/users/me", { tag: "Users", summary: "Own profile", access: "user" });
add("patch", "/users/me", {
  tag: "Users",
  summary: "Update name or avatar",
  access: "user",
  body: updateProfileSchema,
  description: "`avatarUrl` is a small image data URL or an https link; `null` removes it.",
});
add("patch", "/users/me/password", {
  tag: "Users",
  summary: "Change password",
  access: "user",
  body: changePasswordSchema,
  errors: [401],
  description: "Signs the account out on every other device.",
});

// ---------- Courses ----------
add("get", "/courses", {
  tag: "Courses",
  summary: "Browse the published course catalog",
  access: "public",
  query: [
    { name: "q", description: "Keyword in title or summary" },
    { name: "category", description: "Category id" },
    { name: "level", description: "beginner, intermediate or advanced", schema: { type: "string", enum: ["beginner", "intermediate", "advanced"] } },
    { name: "instructorId", description: "Instructor id" },
    ...page,
  ],
});
add("get", "/categories", { tag: "Courses", summary: "Active categories", access: "public" });
add("get", "/courses/mine", { tag: "Courses", summary: "Own courses, any status", access: "instructor" });
add("post", "/courses", { tag: "Courses", summary: "Create a draft course", access: "instructor", body: createCourseBody, created: true });
add("get", "/courses/{courseId}", {
  tag: "Courses",
  summary: "Course detail by id or slug",
  access: "public",
  errors: [404],
  description: "Unpublished courses are visible only to their owner and admins. Lesson bodies are included only for the owner, admins and enrolled students.",
});
add("patch", "/courses/{courseId}", {
  tag: "Courses",
  summary: "Edit own course",
  access: "instructor",
  body: updateCourseBody,
  errors: [404],
  description: "Only the fields sent are changed.",
});
add("post", "/courses/{courseId}/submit-review", {
  tag: "Courses",
  summary: "Submit a draft or rejected course for admin review",
  access: "instructor",
  errors: [404],
});
add("post", "/courses/{courseId}/archive", { tag: "Courses", summary: "Archive a course", access: "instructor or admin", errors: [404] });
add("get", "/courses/{courseId}/lessons", {
  tag: "Courses",
  summary: "Full curriculum with lesson content",
  access: "user",
  errors: [404],
  description: "Owner, admins and enrolled students only.",
});

// ---------- Modules & lessons ----------
add("post", "/courses/{courseId}/modules", {
  tag: "Curriculum",
  summary: "Add a module",
  access: "instructor",
  body: createModuleBody,
  created: true,
  errors: [404],
});
add("patch", "/courses/{courseId}/modules/reorder", {
  tag: "Curriculum",
  summary: "Reorder the modules of a course",
  access: "instructor",
  body: reorderModulesBody,
  errors: [404],
  description: "The list must contain every module of the course exactly once.",
});
add("patch", "/modules/{moduleId}", { tag: "Curriculum", summary: "Edit a module", access: "instructor", body: updateModuleBody, errors: [404] });
add("delete", "/modules/{moduleId}", { tag: "Curriculum", summary: "Delete a module and its lessons", access: "instructor", errors: [404] });
add("post", "/modules/{moduleId}/lessons", {
  tag: "Curriculum",
  summary: "Add a lesson",
  access: "instructor",
  body: createLessonBody,
  created: true,
  errors: [404],
});
add("patch", "/modules/{moduleId}/lessons/reorder", {
  tag: "Curriculum",
  summary: "Set the lesson order of a module",
  access: "instructor",
  body: reorderLessonsBody,
  errors: [404],
  description: "Lessons of the same course listed here are moved into this module.",
});
add("patch", "/lessons/{lessonId}", {
  tag: "Curriculum",
  summary: "Edit a lesson",
  access: "instructor",
  body: updateLessonBody,
  errors: [404],
  description: "Only the fields sent are changed.",
});
add("delete", "/lessons/{lessonId}", { tag: "Curriculum", summary: "Delete a lesson", access: "instructor", errors: [404] });

// ---------- Enrollment & progress ----------
add("post", "/courses/{courseId}/enroll", {
  tag: "Learning",
  summary: "Enroll in a published course",
  access: "student",
  created: true,
  errors: [404, 409],
  description: "A second enrollment returns 409.",
});
add("get", "/enrollments/me", { tag: "Learning", summary: "Own enrollments with progress", access: "student" });
add("get", "/courses/{courseId}/students", { tag: "Learning", summary: "Students enrolled in a course", access: "instructor or admin", errors: [404] });
add("get", "/courses/{courseId}/progress", { tag: "Learning", summary: "Own progress in a course", access: "student", errors: [404] });
add("post", "/lessons/{lessonId}/progress", {
  tag: "Learning",
  summary: "Mark a lesson complete or not complete",
  access: "student",
  body: progressBody,
  errors: [404],
  description: "Idempotent. When the course completion rule is met the enrollment completes and a certificate is issued.",
});

// ---------- Quizzes ----------
add("post", "/courses/{courseId}/quizzes", {
  tag: "Quizzes",
  summary: "Create a quiz with its questions",
  access: "instructor",
  body: createQuizBody,
  created: true,
  errors: [404],
});
add("get", "/courses/{courseId}/quizzes", { tag: "Quizzes", summary: "Quizzes of a course", access: "user", errors: [404] });
add("get", "/quizzes/{quizId}", {
  tag: "Quizzes",
  summary: "Quiz with questions",
  access: "user",
  errors: [404],
  description: "Correct answers are included only for the owning instructor and admins.",
});
add("put", "/quizzes/{quizId}", {
  tag: "Quizzes",
  summary: "Edit a quiz in place",
  access: "instructor",
  body: updateQuizBody,
  errors: [404],
  description: "Questions with an `id` are updated, without an `id` are added, and omitted ones are removed.",
});
add("post", "/quizzes/{quizId}/attempts", {
  tag: "Quizzes",
  summary: "Start (or resume) an attempt",
  access: "student",
  created: true,
  errors: [404],
  description: "Returns questions without answers and a deadline. 403 when attempts are used up.",
});
add("post", "/quiz-attempts/{attemptId}/submit", {
  tag: "Quizzes",
  summary: "Submit answers for server-side grading",
  access: "student",
  body: submitAttemptBody,
  errors: [404, 409],
  description: "409 if already submitted, or `TIME_EXPIRED` when the time limit was exceeded.",
});
add("get", "/quiz-attempts/{attemptId}/result", { tag: "Quizzes", summary: "Detailed result of a submitted attempt", access: "user", errors: [404] });

// ---------- Assignments ----------
add("post", "/courses/{courseId}/assignments", {
  tag: "Assignments",
  summary: "Create an assignment",
  access: "instructor",
  body: createAssignmentBody,
  created: true,
  errors: [404],
});
add("get", "/courses/{courseId}/assignments", {
  tag: "Assignments",
  summary: "Assignments of a course (with own submission for students)",
  access: "user",
  errors: [404],
});
add("get", "/assignments/me", { tag: "Assignments", summary: "All assignments across enrolled courses", access: "student" });
add("get", "/assignments/{assignmentId}", { tag: "Assignments", summary: "Assignment detail", access: "user", errors: [404] });
add("post", "/assignments/{assignmentId}/submissions", {
  tag: "Assignments",
  summary: "Submit work",
  access: "student",
  body: submissionBody,
  created: true,
  errors: [404, 409],
  description: "Late work is flagged. Resubmission is allowed only when the assignment permits it.",
});
add("get", "/assignments/{assignmentId}/submissions", {
  tag: "Assignments",
  summary: "Submissions for an assignment",
  access: "instructor or admin",
  errors: [404],
});
add("get", "/instructor/submissions", {
  tag: "Assignments",
  summary: "Submissions across own courses",
  access: "instructor or admin",
  query: [{ name: "status", description: "submitted or graded", schema: { type: "string", enum: ["submitted", "graded"] } }, ...page],
});
add("patch", "/submissions/{submissionId}/grade", {
  tag: "Assignments",
  summary: "Grade a submission",
  access: "instructor or admin",
  body: gradeBody,
  errors: [404],
  description: "Instructors can only grade submissions in their own courses. Points cannot exceed the assignment maximum.",
});

// ---------- Announcements & reviews ----------
add("get", "/courses/{courseId}/announcements", { tag: "Engagement", summary: "Course announcements", access: "user", errors: [404] });
add("post", "/courses/{courseId}/announcements", {
  tag: "Engagement",
  summary: "Post an announcement",
  access: "instructor",
  body: announcementBody,
  created: true,
  errors: [404],
  description: "Notifies every enrolled student.",
});
add("delete", "/announcements/{announcementId}", { tag: "Engagement", summary: "Delete an announcement", access: "instructor", errors: [404] });
add("get", "/courses/{courseId}/reviews", { tag: "Engagement", summary: "Ratings and reviews", access: "public", errors: [404] });
add("put", "/courses/{courseId}/reviews", {
  tag: "Engagement",
  summary: "Create or update own review",
  access: "student",
  body: reviewBody,
  errors: [404],
  description: "Only students enrolled in the published course. One review per student.",
});
add("delete", "/courses/{courseId}/reviews/mine", { tag: "Engagement", summary: "Remove own review", access: "student", errors: [404] });

// ---------- Certificates, notifications, grades ----------
add("get", "/certificates/me", { tag: "Certificates", summary: "Own certificates", access: "student" });
add("get", "/certificates/verify/{code}", {
  tag: "Certificates",
  summary: "Verify a certificate",
  access: "public",
  errors: [404],
  description: "Returns only the student name, course title and issue date.",
});
add("get", "/notifications", { tag: "Notifications", summary: "Own notifications", access: "user", query: page });
add("patch", "/notifications/read-all", { tag: "Notifications", summary: "Mark all as read", access: "user" });
add("patch", "/notifications/{notificationId}/read", { tag: "Notifications", summary: "Mark one as read", access: "user", errors: [404] });
add("get", "/grades/me", { tag: "Notifications", summary: "Own quiz results and assignment grades", access: "student" });

// ---------- Analytics ----------
add("get", "/student/summary", { tag: "Analytics", summary: "Student dashboard summary", access: "student" });
add("get", "/instructor/analytics", { tag: "Analytics", summary: "Reports for own courses", access: "instructor" });
add("get", "/admin/analytics", { tag: "Analytics", summary: "Platform-wide totals", access: "admin" });

// ---------- Admin ----------
add("get", "/admin/users", {
  tag: "Admin",
  summary: "List users",
  access: "admin",
  query: [{ name: "q", description: "Name or email" }, { name: "role", description: "student, instructor or admin" }, ...page],
});
add("patch", "/admin/users/{userId}/status", {
  tag: "Admin",
  summary: "Suspend or reactivate a user",
  access: "admin",
  body: statusBody,
  errors: [404],
  description: "Suspending signs the user out everywhere. Admins cannot change their own status.",
});
add("get", "/admin/courses", { tag: "Admin", summary: "All courses", access: "admin", query: [{ name: "status", description: "Filter by status" }] });
add("get", "/admin/courses/pending", { tag: "Admin", summary: "Courses waiting for review", access: "admin" });
add("patch", "/admin/courses/{courseId}/approve", { tag: "Admin", summary: "Approve and publish", access: "admin", errors: [404, 409] });
add("patch", "/admin/courses/{courseId}/reject", {
  tag: "Admin",
  summary: "Reject with a moderation note",
  access: "admin",
  body: rejectCourseBody,
  errors: [404, 409],
});
add("get", "/admin/categories", { tag: "Admin", summary: "All categories with course counts", access: "admin" });
add("post", "/admin/categories", { tag: "Admin", summary: "Create a category", access: "admin", body: categoryBody, created: true, errors: [409] });
add("delete", "/admin/categories/{categoryId}", { tag: "Admin", summary: "Delete an empty category", access: "admin", errors: [404] });
add("get", "/admin/audit-logs", { tag: "Admin", summary: "Audit log of administrative actions", access: "admin", query: page });

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "LearnSphere API",
    version: "1.0.0",
    description: [
      "REST API for the LearnSphere learning management system.",
      "",
      "**Authentication:** sign in with `POST /auth/login`. The server sets HttpOnly cookies, so there is nothing to copy. In Swagger UI, sign in first, then use *Try it out*.",
      "The access cookie lasts 15 minutes; call `POST /auth/refresh` to rotate it.",
      "",
      "**Responses:** success is `{ data, message }`; failure is `{ error: { code, message, details } }`.",
    ].join("\n"),
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    "Health",
    "Auth",
    "Users",
    "Courses",
    "Curriculum",
    "Learning",
    "Quizzes",
    "Assignments",
    "Engagement",
    "Certificates",
    "Notifications",
    "Analytics",
    "Admin",
  ].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: "ls_access", description: "HttpOnly session cookie set by /auth/login." } },
    schemas: {
      Success: { type: "object", properties: { data: {}, message: { type: "string" } } },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "details"],
            properties: { code: { type: "string", example: "VALIDATION_ERROR" }, message: { type: "string" }, details: { type: "array", items: {} } },
          },
        },
      },
    },
    responses: {
      E400: errorResponse("Invalid input (VALIDATION_ERROR)"),
      E401: errorResponse("Not signed in, or the session expired (UNAUTHENTICATED)"),
      E403: errorResponse("Signed in but not allowed (FORBIDDEN)"),
      E404: errorResponse("Not found (NOT_FOUND)"),
      E409: errorResponse("Conflict, such as a duplicate (CONFLICT)"),
      E429: errorResponse("Rate limited or account locked (RATE_LIMITED, ACCOUNT_LOCKED)"),
    },
  },
};
