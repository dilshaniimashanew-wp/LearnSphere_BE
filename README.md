# LearnSphere API

Express + TypeScript + MongoDB (Mongoose) REST API for the LearnSphere LMS. Base path: `/api/v1`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in (MongoDB Atlas URI, a 32+ character `SESSION_SECRET`).
   If your network DNS cannot resolve `mongodb+srv` (error `querySrv ECONNREFUSED`), set `DNS_SERVERS=8.8.8.8,1.1.1.1`.
3. `npm run seed:demo` creates sample users, courses, quizzes, assignments and activity.
   `npm run seed:demo -- --reset` clears **all** collections first and rebuilds the demo data.
4. `npm run dev` starts the API on http://localhost:4000

## Demo accounts (created by `seed:demo`, for local/demo use only)

| Role       | Email                                                           | Password         |
| ---------- | --------------------------------------------------------------- | ---------------- |
| Admin      | admin@learnsphere.test                                          | Admin@12345      |
| Instructor | amara@learnsphere.test                                          | Instructor@12345 |
| Instructor | kasun@learnsphere.test                                          | Instructor@12345 |
| Student    | nimali@learnsphere.test (completed a course, has a certificate) | Student@12345    |
| Student    | chamod@learnsphere.test (submitted work awaiting grading)       | Student@12345    |
| Student    | tharushi@learnsphere.test (graded assignment)                   | Student@12345    |
| Student    | dilan@learnsphere.test (no activity)                            | Student@12345    |

## Workflow

Instructor creates a course (draft) with modules, lessons, quizzes and assignments, then submits it for review.
Admin approves or rejects it (a note is required to reject). Students enroll in published courses, complete lessons,
take server-graded quizzes and submit assignments. Instructors grade submissions for their own courses.
When every required lesson is complete and every quiz is passed, the enrollment completes and a certificate with a
public verification code is issued.

## More features

- **Announcements:** instructors post to their course; enrolled students are notified.
- **Ratings and reviews:** only enrolled students can review a published course (one review each, editable). Course cards show the average.
- **Reorder:** modules and lessons can be reordered, and lessons moved between modules (`PATCH /courses/:id/modules/reorder`, `PATCH /modules/:id/lessons/reorder`).
- **Edit quizzes:** `PUT /quizzes/:id` updates settings and questions in place. Existing questions keep their ids, so past attempts stay valid.
- **Profile avatar:** `PATCH /users/me` accepts a small image data URL (or https link). The web app crops and resizes it to 128px first.
- **Sample data:** quizzes have 6 to 10 dummy questions each, plus sample announcements and reviews.

## Notes

- Authentication uses an HttpOnly session cookie. Every protected route checks identity, role and ownership on the server.
- Assignment submissions accept text and a link. File uploads need object storage (S3/Cloudinary), which is not configured yet.
- Password reset and email verification are not implemented yet (`/auth/forgot-password` is a stub).
