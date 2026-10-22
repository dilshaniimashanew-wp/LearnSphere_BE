import { badRequest, conflict, forbidden, notFound } from "../../shared/errors.js";
import { assertEnrolledStudent, loadCourse, notify } from "../../shared/helpers.js";
import { Course, Lesson, type CourseDoc } from "../courses/course.model.js";
import { presentCourse } from "../courses/course.presenter.js";
import { User, type UserDoc } from "../users/user.model.js";
import { Enrollment, LessonProgress } from "./enrollment.model.js";
import { courseProgress, evaluateCompletion } from "./progress.service.js";

export async function enroll(student: UserDoc, course: CourseDoc) {
  if (course.status !== "published") throw forbidden("This course is not open for enrollment");
  try {
    await Enrollment.create({ studentId: student._id, courseId: course._id });
  } catch (e) {
    // The unique studentId+courseId index makes duplicate enrollment impossible even under a race.
    if ((e as { code?: number }).code === 11000) throw conflict("You are already enrolled in this course");
    throw e;
  }
  await notify(course.instructorId, "new_enrollment", "New student", `${student.name} enrolled in ${course.title}.`, "/instructor");
}

export async function listForStudent(student: UserDoc) {
  const enrollments = await Enrollment.find({ studentId: student._id }).sort({ enrolledAt: -1 });
  const items = await Promise.all(
    enrollments.map(async (e) => {
      const course = await Course.findById(e.courseId);
      if (!course) return null;
      const progress = await courseProgress(student._id, course._id);
      const done = new Set(progress.completedLessonIds);
      const next = (await Lesson.find({ courseId: course._id }).sort({ order: 1 }).lean()).find((l) => !done.has(String(l._id)));
      return {
        courseId: course.id,
        course: await presentCourse(course),
        status: e.status,
        progress: progress.percent,
        nextLesson: next?.title ?? "",
        enrolledAt: e.enrolledAt,
        completedAt: e.completedAt,
      };
    }),
  );
  return items.filter(Boolean);
}

export async function listStudents(course: CourseDoc) {
  const enrollments = await Enrollment.find({ courseId: course._id }).sort({ enrolledAt: -1 }).lean();
  const users = await User.find({ _id: { $in: enrollments.map((e) => e.studentId) } }).select("name email").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return Promise.all(
    enrollments.map(async (e) => ({
      studentId: String(e.studentId),
      name: byId.get(String(e.studentId))?.name,
      email: byId.get(String(e.studentId))?.email,
      status: e.status,
      progress: (await courseProgress(e.studentId, course._id)).percent,
      enrolledAt: e.enrolledAt,
    })),
  );
}

/** Marks a lesson done (or not) for a student, then re-evaluates course completion. Idempotent. */
export async function setLessonProgress(student: UserDoc, lessonId: string, completed: boolean) {
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) throw notFound("Lesson not found");
  const course = await loadCourse(lesson.courseId);
  await assertEnrolledStudent(course, student);
  if (course.status === "archived") throw badRequest("This course is archived");

  if (completed) {
    // Upsert keeps this idempotent: marking twice never creates duplicates.
    await LessonProgress.updateOne({ studentId: student._id, lessonId: lesson._id }, { $setOnInsert: { courseId: course._id, completedAt: new Date() } }, { upsert: true });
  } else {
    await LessonProgress.deleteOne({ studentId: student._id, lessonId: lesson._id });
  }
  return evaluateCompletion(student._id, course._id);
}
