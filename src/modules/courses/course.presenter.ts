import type { Types } from "mongoose";
import { Enrollment } from "../enrollments/enrollment.model.js";
import { Review } from "../platform/platform.model.js";
import { User } from "../users/user.model.js";
import { Category, CourseModule, Lesson, type CourseDoc } from "./course.model.js";

const groupById = <T extends { _id: unknown }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));

/**
 * Public-safe course shape for a whole list using a fixed number of queries
 * (not 5 per course), so the catalog stays fast as it grows.
 */
export async function presentCourses(courses: CourseDoc[]) {
  if (courses.length === 0) return [];
  const ids = courses.map((c) => c._id);
  const [instructors, categories, lessons, enrollments, reviews] = await Promise.all([
    User.find({ _id: { $in: courses.map((c) => c.instructorId) } })
      .select("name")
      .lean(),
    Category.find({ _id: { $in: courses.map((c) => c.categoryId) } })
      .select("name")
      .lean(),
    Lesson.aggregate<{ _id: Types.ObjectId; count: number; minutes: number }>([
      { $match: { courseId: { $in: ids } } },
      { $group: { _id: "$courseId", count: { $sum: 1 }, minutes: { $sum: "$estimatedMinutes" } } },
    ]),
    Enrollment.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { courseId: { $in: ids } } },
      { $group: { _id: "$courseId", count: { $sum: 1 } } },
    ]),
    Review.aggregate<{ _id: Types.ObjectId; avg: number; count: number }>([
      { $match: { courseId: { $in: ids } } },
      { $group: { _id: "$courseId", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]),
  ]);
  const instructorById = groupById(instructors);
  const categoryById = groupById(categories);
  const lessonsById = groupById(lessons);
  const enrollmentsById = groupById(enrollments);
  const reviewsById = groupById(reviews);

  return courses.map((course) => {
    const key = String(course._id);
    const review = reviewsById.get(key);
    return {
      id: course.id as string,
      slug: course.slug,
      title: course.title,
      summary: course.summary,
      description: course.description,
      thumbnailUrl: course.thumbnailUrl,
      categoryId: String(course.categoryId),
      category: categoryById.get(String(course.categoryId))?.name ?? "Uncategorised",
      level: course.level,
      instructor: instructorById.get(String(course.instructorId))?.name ?? "Unknown",
      instructorId: String(course.instructorId),
      status: course.status,
      moderationNote: course.moderationNote,
      objectives: course.objectives,
      prerequisites: course.prerequisites,
      durationMinutes: lessonsById.get(key)?.minutes ?? 0,
      lessonCount: lessonsById.get(key)?.count ?? 0,
      students: enrollmentsById.get(key)?.count ?? 0,
      rating: review ? Math.round(review.avg * 10) / 10 : 0,
      reviewCount: review?.count ?? 0,
      publishedAt: course.publishedAt,
    };
  });
}

/** One course, optionally with its module/lesson outline. Lesson bodies need `withContent`. */
export async function presentCourse(course: CourseDoc, opts: { withOutline?: boolean; withContent?: boolean } = {}) {
  const [dto] = await presentCourses([course]);
  if (!opts.withOutline) return dto;

  const [modules, lessons] = await Promise.all([
    CourseModule.find({ courseId: course._id }).sort({ order: 1, createdAt: 1 }).lean(),
    Lesson.find({ courseId: course._id }).sort({ order: 1, createdAt: 1 }).lean(),
  ]);
  return {
    ...dto,
    modules: modules.map((m) => ({
      id: String(m._id),
      title: m.title,
      description: m.description,
      order: m.order,
      lessons: lessons
        .filter((l) => String(l.moduleId) === String(m._id))
        .map((l) => ({
          id: String(l._id),
          title: l.title,
          type: l.type,
          minutes: l.estimatedMinutes,
          isRequired: l.isRequired,
          order: l.order,
          ...(opts.withContent ? { content: l.content, videoUrl: l.videoUrl } : {}),
        })),
    })),
  };
}
