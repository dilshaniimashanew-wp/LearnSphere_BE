import mongoose, { type Types } from "mongoose";
import { connectDb } from "../config/db.js";
import { Assignment, Question, Quiz, QuizAttempt, Submission } from "../modules/assessments/assessment.model.js";
import { hashPassword } from "../modules/auth/auth.service.js";
import { Category, Course, CourseModule, Lesson } from "../modules/courses/course.model.js";
import { Enrollment, LessonProgress } from "../modules/enrollments/enrollment.model.js";
import { evaluateCompletion } from "../modules/enrollments/progress.service.js";
import { Announcement, AuditLog, Notification, Review } from "../modules/platform/platform.model.js";
import { User } from "../modules/users/user.model.js";
import { slugify, uniqueSlug } from "../shared/helpers.js";

// Demo accounts. These are sample credentials for local/demo use only.
export const DEMO_PASSWORDS = { admin: "Admin@12345", instructor: "Instructor@12345", student: "Student@12345" };

const day = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * day);

async function reset() {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  console.log("Cleared all collections");
}

async function makeUser(name: string, email: string, role: "admin" | "instructor" | "student") {
  return User.create({ name, email, role, passwordHash: await hashPassword(DEMO_PASSWORDS[role]) });
}

type LessonSeed = [title: string, minutes: number, content: string, video?: string];
type QuestionSeed = { type: "multiple_choice" | "true_false"; prompt: string; options?: string[]; correct: number };

// Dummy question banks so the quizzes feel real.
const mc = (prompt: string, options: string[], correct: number): QuestionSeed => ({ type: "multiple_choice", prompt, options, correct });
const tf = (prompt: string, isTrue: boolean): QuestionSeed => ({ type: "true_false", prompt, correct: isTrue ? 0 : 1 });

const routingQuestions: QuestionSeed[] = [
  mc("Which folder holds routes in the App Router?", ["pages", "app", "routes", "src/api"], 1),
  tf("Layouts can be shared by multiple pages.", true),
  mc("Which file defines a loading UI for a route?", ["loading.tsx", "spinner.tsx", "wait.tsx", "page.css"], 0),
  tf("Server components can use useState.", false),
  mc("Which file defines a not-found UI?", ["error.tsx", "missing.tsx", "not-found.tsx", "404.js"], 2),
  mc("How do you create a dynamic route segment?", ["[slug]", "{slug}", "(slug)", "<slug>"], 0),
  tf("Route groups written in parentheses change the URL path.", false),
  mc("Which component enables client-side navigation between routes?", ["a", "Link", "Route", "Anchor"], 1),
  mc("Which directive marks a client component?", ['"use client"', '"use browser"', '"client only"', '"use state"'], 0),
  tf("A page.tsx file is required for a route to be publicly accessible.", true),
];

const formsQuestions: QuestionSeed[] = [
  mc("Which library validates data with TypeScript type inference?", ["Zod", "Lodash", "Axios", "Moment"], 0),
  tf("Client-side validation alone is enough to keep an API secure.", false),
  mc("Which React Hook Form function connects an input to the form?", ["register", "connect", "bind", "attach"], 0),
  mc("What should every form input have for accessibility?", ["A label", "A tooltip", "A border", "A placeholder only"], 0),
  tf("Validation errors should be announced to screen readers.", true),
  mc("Which HTTP status best fits invalid input?", ["400", "200", "301", "500"], 0),
];

const expressQuestions: QuestionSeed[] = [
  mc("What does Express middleware receive?", ["req, res, next", "only req", "only res", "nothing"], 0),
  tf("MongoDB enforces foreign keys.", false),
  mc("Which status code means the user is not authenticated?", ["401", "403", "404", "201"], 0),
  mc("What is a safe way to store passwords?", ["Argon2id hash", "Plain text", "Base64", "MD5 only"], 0),
  tf("Express 5 forwards errors from rejected async handlers to the error handler.", true),
  mc("What does a unique index in Mongoose prevent?", ["Duplicate values", "Slow queries", "Large files", "CORS errors"], 0),
  tf("Cookies marked HttpOnly can be read by JavaScript.", false),
  mc("Which HTTP method is conventionally used for a partial update?", ["PATCH", "GET", "TRACE", "HEAD"], 0),
];

const pandasQuestions: QuestionSeed[] = [
  mc("Which structure is a 2D table in pandas?", ["Series", "DataFrame", "Array", "Index"], 1),
  tf("pandas can read CSV files.", true),
  mc("Which function reads a CSV file?", ["pd.read_csv", "pd.open_csv", "pd.load", "pd.csv"], 0),
  mc("Which method shows the first rows of a DataFrame?", ["head()", "top()", "first_rows()", "peek()"], 0),
  tf("dropna() removes rows with missing values.", true),
  mc("Which expression counts missing values per column?", ["df.isna().sum()", "df.count_missing()", "df.nulls()", "df.empty"], 0),
  tf("A pandas Series is two dimensional.", false),
  mc("Which method groups rows so you can aggregate them?", ["groupby", "mixby", "sortby", "joinby"], 0),
];

async function makeCourse(opts: {
  instructorId: Types.ObjectId;
  categoryId: Types.ObjectId;
  title: string;
  summary: string;
  description: string;
  level: "beginner" | "intermediate" | "advanced";
  status: "draft" | "pending_review" | "published";
  objectives: string[];
  prerequisites?: string[];
  modules: { title: string; lessons: LessonSeed[] }[];
}) {
  const course = await Course.create({
    instructorId: opts.instructorId,
    categoryId: opts.categoryId,
    title: opts.title,
    slug: uniqueSlug(opts.title),
    summary: opts.summary,
    description: opts.description,
    level: opts.level,
    status: opts.status,
    objectives: opts.objectives,
    prerequisites: opts.prerequisites ?? [],
    publishedAt: opts.status === "published" ? new Date() : undefined,
  });
  const lessons: { _id: Types.ObjectId }[] = [];
  for (const [mi, m] of opts.modules.entries()) {
    const mod = await CourseModule.create({ courseId: course._id, title: m.title, order: mi });
    for (const [li, [title, minutes, content, videoUrl]] of m.lessons.entries()) {
      lessons.push(
        await Lesson.create({
          courseId: course._id,
          moduleId: mod._id,
          title,
          estimatedMinutes: minutes,
          content,
          videoUrl,
          type: videoUrl ? "video" : "text",
          order: li,
        }),
      );
    }
  }
  return { course, lessons };
}

async function makeQuiz(courseId: Types.ObjectId, title: string, questions: QuestionSeed[], passMark = 60) {
  const quiz = await Quiz.create({
    courseId,
    title,
    instructions: "Answer every question. Your best attempt counts.",
    passMark,
    maxAttempts: 3,
    timeLimitSeconds: 600,
  });
  const letters = "abcdefgh";
  await Question.insertMany(
    questions.map((q, order) => {
      const texts = q.type === "true_false" ? ["True", "False"] : (q.options ?? []);
      return {
        quizId: quiz._id,
        type: q.type,
        prompt: q.prompt,
        options: texts.map((t, i) => ({ id: letters[i], text: t })),
        correctOptionId: letters[q.correct],
        points: 1,
        order,
      };
    }),
  );
  return quiz;
}

async function main() {
  await connectDb();
  if (process.argv.includes("--reset")) await reset();
  if (await User.exists({ email: "admin@learnsphere.test" })) {
    console.log("Demo data already exists. Run with --reset to rebuild it (this clears ALL collections).");
    return mongoose.disconnect();
  }

  // ---- People ----
  const admin = await makeUser("Admin User", "admin@learnsphere.test", "admin");
  const amara = await makeUser("Amara Perera", "amara@learnsphere.test", "instructor");
  const kasun = await makeUser("Kasun Silva", "kasun@learnsphere.test", "instructor");
  const nimali = await makeUser("Nimali Fernando", "nimali@learnsphere.test", "student");
  const chamod = await makeUser("Chamod Ekanayake", "chamod@learnsphere.test", "student");
  const tharushi = await makeUser("Tharushi Gunawardena", "tharushi@learnsphere.test", "student");
  await makeUser("Dilan Jayasuriya", "dilan@learnsphere.test", "student");

  // ---- Categories ----
  const cats: Record<string, Types.ObjectId> = {};
  for (const name of ["Web Development", "Data Science", "Design", "Business", "Mobile"]) {
    cats[name] = (await Category.create({ name, slug: slugify(name) }))._id;
  }

  // ---- Courses ----
  const web = await makeCourse({
    instructorId: amara._id,
    categoryId: cats["Web Development"],
    title: "Modern Web Development with Next.js",
    summary: "Build production-ready apps with React, TypeScript and Next.js.",
    description: "A hands-on course covering routing, data fetching, forms, authentication and deployment of full-stack web applications.",
    level: "intermediate",
    status: "published",
    objectives: ["Build pages with the App Router", "Validate forms with Zod", "Deploy to production"],
    prerequisites: ["Basic JavaScript", "HTML & CSS"],
    modules: [
      {
        title: "Getting started",
        lessons: [
          ["Project setup", 12, "Create a Next.js project, understand the folder structure and run the dev server."],
          ["Routing basics", 18, "Pages, layouts, dynamic routes and navigation with the App Router.", "https://www.youtube.com/embed/ZVnjOPwW4ZA"],
        ],
      },
      {
        title: "Data & forms",
        lessons: [
          ["Fetching data", 22, "Fetch data on the server and the client, and handle loading and error states."],
          ["Forms with React Hook Form", 25, "Build accessible forms and validate them with Zod schemas."],
        ],
      },
    ],
  });
  const webQuiz = await makeQuiz(web.course._id, "Routing basics quiz", routingQuestions);
  await makeQuiz(web.course._id, "Forms and validation quiz", formsQuestions, 70);
  const webAssignment = await Assignment.create({
    courseId: web.course._id,
    title: "Build a validated form",
    instructions: "Build a registration form with React Hook Form and Zod. Share a link to your code or write a short description.",
    dueAt: inDays(7),
    maxPoints: 100,
    allowResubmission: true,
  });
  await Assignment.create({
    courseId: web.course._id,
    title: "Deploy your app",
    instructions: "Deploy a small Next.js app and submit the live URL.",
    dueAt: inDays(14),
    maxPoints: 50,
  });

  const api = await makeCourse({
    instructorId: kasun._id,
    categoryId: cats["Web Development"],
    title: "REST APIs with Node.js and MongoDB",
    summary: "Design secure, tested REST APIs using Express and Mongoose.",
    description: "Learn schema design, authentication, authorization, validation and testing for real-world APIs.",
    level: "intermediate",
    status: "published",
    objectives: ["Model data in MongoDB", "Secure endpoints", "Write API tests"],
    prerequisites: ["JavaScript fundamentals"],
    modules: [
      {
        title: "Express fundamentals",
        lessons: [
          ["Routing & middleware", 20, "Routers, middleware and request validation."],
          ["Error handling", 15, "Central error handling and consistent JSON errors."],
        ],
      },
      { title: "MongoDB", lessons: [["Schema design", 25, "Embedding versus referencing and indexes."]] },
    ],
  });
  await makeQuiz(api.course._id, "Express basics quiz", expressQuestions);
  await Assignment.create({
    courseId: api.course._id,
    title: "Design a schema",
    instructions: "Design Mongoose schemas for a blog and explain your index choices.",
    dueAt: inDays(10),
    maxPoints: 100,
  });

  const py = await makeCourse({
    instructorId: kasun._id,
    categoryId: cats["Data Science"],
    title: "Data Analysis with Python",
    summary: "Clean, explore and visualise data using pandas.",
    description: "From raw CSV files to clear charts and insights, step by step.",
    level: "beginner",
    status: "published",
    objectives: ["Use pandas", "Visualise data", "Tell a story with data"],
    modules: [
      {
        title: "Foundations",
        lessons: [
          ["Intro to pandas", 20, "DataFrames, Series and reading CSV files."],
          ["Cleaning data", 25, "Missing values, duplicates and type conversion."],
        ],
      },
    ],
  });
  const pyQuiz = await makeQuiz(py.course._id, "Pandas basics quiz", pandasQuestions);

  // Awaiting admin approval / still drafting
  await makeCourse({
    instructorId: amara._id,
    categoryId: cats["Web Development"],
    title: "Advanced TypeScript",
    summary: "Generics, utility types and type-safe API design.",
    description: "Go beyond the basics with conditional types, mapped types and patterns for large codebases.",
    level: "advanced",
    status: "pending_review",
    objectives: ["Write generic utilities", "Model complex domains"],
    modules: [{ title: "Generics", lessons: [["Generic functions", 20, "Constraints, defaults and inference."]] }],
  });
  await makeCourse({
    instructorId: kasun._id,
    categoryId: cats["Mobile"],
    title: "Intro to Mobile Apps",
    summary: "Build your first cross-platform mobile app.",
    description: "Learn the fundamentals of building mobile apps with React Native.",
    level: "beginner",
    status: "pending_review",
    objectives: ["Build screens", "Handle navigation"],
    modules: [{ title: "Basics", lessons: [["Your first screen", 15, "Components, styling and navigation."]] }],
  });
  await makeCourse({
    instructorId: amara._id,
    categoryId: cats["Web Development"],
    title: "Testing React Apps",
    summary: "Unit, integration and end-to-end testing for React.",
    description: "Write reliable tests with Vitest, Testing Library and Playwright.",
    level: "intermediate",
    status: "draft",
    objectives: ["Write unit tests"],
    modules: [{ title: "Unit testing", lessons: [["Testing components", 20, "Render, query and assert."]] }],
  });

  // ---- Learning activity ----
  // Nimali: part-way through web dev, and has fully completed Data Analysis (earns a certificate).
  await Enrollment.create({ studentId: nimali._id, courseId: web.course._id });
  for (const l of web.lessons.slice(0, 2)) await LessonProgress.create({ studentId: nimali._id, courseId: web.course._id, lessonId: l._id });

  await Enrollment.create({ studentId: nimali._id, courseId: py.course._id });
  for (const l of py.lessons) await LessonProgress.create({ studentId: nimali._id, courseId: py.course._id, lessonId: l._id });
  await QuizAttempt.create({
    quizId: pyQuiz._id,
    courseId: py.course._id,
    studentId: nimali._id,
    attemptNumber: 1,
    status: "submitted",
    submittedAt: new Date(),
    score: 8,
    maxScore: 8,
    passed: true,
  });
  await evaluateCompletion(nimali._id, py.course._id);

  // Chamod: has passed the web quiz and submitted an assignment waiting to be graded.
  await Enrollment.create({ studentId: chamod._id, courseId: web.course._id });
  await Enrollment.create({ studentId: chamod._id, courseId: api.course._id });
  await LessonProgress.create({ studentId: chamod._id, courseId: web.course._id, lessonId: web.lessons[0]._id });
  await QuizAttempt.create({
    quizId: webQuiz._id,
    courseId: web.course._id,
    studentId: chamod._id,
    attemptNumber: 1,
    status: "submitted",
    submittedAt: new Date(),
    score: 8,
    maxScore: 10,
    passed: true,
  });
  await Submission.create({
    assignmentId: webAssignment._id,
    courseId: web.course._id,
    studentId: chamod._id,
    textResponse: "Form built with React Hook Form + Zod: https://github.com/example/form-demo",
    submittedAt: new Date(),
  });

  // Tharushi: already graded.
  await Enrollment.create({ studentId: tharushi._id, courseId: web.course._id });
  await Submission.create({
    assignmentId: webAssignment._id,
    courseId: web.course._id,
    studentId: tharushi._id,
    textResponse: "My validated registration form with inline errors.",
    submittedAt: new Date(Date.now() - 2 * day),
    status: "graded",
    grade: {
      pointsAwarded: 86,
      feedback: "Great validation and clear error messages. Add keyboard focus styles next time.",
      gradedBy: amara._id,
      gradedAt: new Date(),
    },
  });

  // ---- Announcements & reviews ----
  await Announcement.insertMany([
    {
      courseId: web.course._id,
      authorId: amara._id,
      title: "Welcome to the course",
      body: "Welcome everyone! Start with the Getting started module, then try the Routing basics quiz. Ask questions any time.",
    },
    {
      courseId: web.course._id,
      authorId: amara._id,
      title: "Assignment tip",
      body: "For the validated form assignment, share a repository link or describe your approach. Resubmission is allowed until the deadline.",
    },
    {
      courseId: api.course._id,
      authorId: kasun._id,
      title: "Schema design office hour",
      body: "I will review schema designs live on Friday. Bring your index questions.",
    },
    {
      courseId: py.course._id,
      authorId: kasun._id,
      title: "Dataset for practice",
      body: "Use any public CSV dataset for the cleaning exercise. Kaggle has many small ones.",
    },
  ]);
  await Review.insertMany([
    { courseId: py.course._id, studentId: nimali._id, rating: 5, comment: "Clear explanations and practical examples. The cleaning lesson was my favourite." },
    { courseId: web.course._id, studentId: nimali._id, rating: 4, comment: "Great pace. I would love a longer section on deployment." },
    { courseId: web.course._id, studentId: chamod._id, rating: 5, comment: "The quizzes made the concepts stick." },
    { courseId: web.course._id, studentId: tharushi._id, rating: 4, comment: "Helpful feedback on my assignment." },
  ]);

  // ---- Notifications & audit log ----
  await Notification.insertMany([
    {
      recipientId: nimali._id,
      type: "course_completed",
      title: "Course completed",
      body: "You completed Data Analysis with Python. Your certificate is ready.",
      link: "/student/certificates",
    },
    {
      recipientId: nimali._id,
      type: "new_assignment",
      title: "New assignment",
      body: '"Build a validated form" was added to Modern Web Development with Next.js.',
      link: "/student/assignments",
    },
    {
      recipientId: tharushi._id,
      type: "assignment_graded",
      title: "Assignment graded",
      body: '"Build a validated form" was graded: 86/100.',
      link: "/student/grades",
    },
    {
      recipientId: amara._id,
      type: "new_submission",
      title: "New submission",
      body: 'Chamod Ekanayake submitted "Build a validated form".',
      link: "/instructor/submissions",
    },
  ]);
  await AuditLog.insertMany([
    { actorId: admin._id, action: "course.approve", targetType: "course", targetId: String(web.course._id), metadata: { title: web.course.title } },
    { actorId: admin._id, action: "course.approve", targetType: "course", targetId: String(api.course._id), metadata: { title: api.course.title } },
  ]);

  console.log("\nDemo data created.\n");
  console.log("  Admin       admin@learnsphere.test       ", DEMO_PASSWORDS.admin);
  console.log("  Instructors amara@learnsphere.test       ", DEMO_PASSWORDS.instructor);
  console.log("              kasun@learnsphere.test       ", DEMO_PASSWORDS.instructor);
  console.log("  Students    nimali@learnsphere.test      ", DEMO_PASSWORDS.student);
  console.log("              chamod@learnsphere.test      ", DEMO_PASSWORDS.student);
  console.log("              tharushi@learnsphere.test    ", DEMO_PASSWORDS.student);
  console.log("              dilan@learnsphere.test       ", DEMO_PASSWORDS.student);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
