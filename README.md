# LearnSphere API

REST API for the LearnSphere learning management system: courses, enrollment, progress, quizzes, assignments, grading, certificates, notifications and administration.

**Stack:** Node.js, Express 5, TypeScript, MongoDB (Mongoose), Zod, Argon2id, JWT, Pino, Vitest + Supertest.
The web app lives in the sibling repository `LearnSphere_Front_end`.

## Quick start

```bash
npm install
cp .env.example .env        # then fill it in (see below)
npm run seed:demo           # sample users, courses, quizzes, assignments
npm run dev                 # http://localhost:4000/api/v1
```

Interactive API documentation (Swagger UI): <http://localhost:4000/api/v1/docs>
(raw spec: `/api/v1/openapi.json`). Sign in through `POST /auth/login` first, then use _Try it out_.

### Environment

| Variable                                     | Purpose                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                                | MongoDB Atlas (or local) connection string. Required.                                         |
| `SESSION_SECRET`                             | At least 32 random characters, used to sign access tokens. Required.                          |
| `APP_ORIGIN`                                 | Origin of the web app (CORS allowlist and CSRF check). Required.                              |
| `PORT`                                       | Default `4000`.                                                                               |
| `DNS_SERVERS`                                | Optional, e.g. `8.8.8.8,1.1.1.1`. Fixes `querySrv ECONNREFUSED` on networks whose DNS cannot resolve `mongodb+srv`. |
| `AUTH_RATE_LIMIT`                            | Login/register requests per IP per 15 min (default 30; raise for local testing).              |
| `API_RATE_LIMIT`                             | All API requests per IP per 15 min (default 1500).                                            |
| `TRUST_PROXY`                                | Number of reverse proxies in front of the API (so rate limits see the real client IP).        |
| `ENABLE_DOCS`                                | `true`/`false`. Swagger UI is on in development and off in production by default.             |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`              | Used only by `npm run seed:admin`.                                                            |

Never commit `.env`. It is in `.gitignore`.

## Scripts

| Command                           | What it does                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`                     | Start with auto-reload                                                            |
| `npm run build` / `npm start`     | Compile to `dist/` and run the compiled server                                    |
| `npm test`                        | Run the test suite (in-memory MongoDB, no setup or secrets needed)                |
| `npm run check`                   | Lint, formatting, type check and tests: the same checks CI runs                   |
| `npm run lint` / `lint:fix`       | ESLint                                                                            |
| `npm run format` / `format:check` | Prettier                                                                          |
| `npm run seed:demo`               | Create sample data (skips if it already exists)                                   |
| `npm run seed:demo -- --reset --yes` | **Deletes all data**, then recreates the sample data. Refuses in production.   |
| `npm run seed:admin`              | Create one admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD`                            |

## Demo accounts (from `seed:demo`; local/demo use only)

| Role       | Email                                                        | Password           |
| ---------- | ------------------------------------------------------------ | ------------------ |
| Admin      | admin@learnsphere.test                                       | `Admin@12345`      |
| Instructor | amara@learnsphere.test, kasun@learnsphere.test               | `Instructor@12345` |
| Student    | nimali@ (completed a course, has a certificate), chamod@ (work awaiting grading), tharushi@ (graded work), dilan@ (no activity) `@learnsphere.test` | `Student@12345`    |

## The learning workflow

1. An **instructor** creates a draft course with modules, lessons, quizzes and assignments, then submits it for review.
2. An **admin** approves it, or rejects it with a required note. The instructor can fix and resubmit.
3. **Students** enroll in published courses, complete lessons, take timed quizzes (graded on the server) and submit assignments.
4. **Instructors** grade submissions for their own courses. Students are notified.
5. When every required lesson is complete and every quiz is passed, the enrollment completes and a certificate with a public verification code is issued, once.

Also: announcements, ratings and reviews, drag-to-reorder curriculum, quiz editing, notifications, profile pictures, audit logs and platform/instructor analytics.

## Security model

- **Authentication:** a 15 minute access token (JWT, HS256 pinned) and a 7 day refresh token, both in HttpOnly SameSite cookies. The refresh token is opaque, stored only as a SHA-256 hash, **rotated on every use**, and re-use of an old token revokes all of that user's sessions. The refresh cookie is scoped to `/api/v1/auth`.
- **Passwords:** Argon2id. Unknown email and wrong password take the same time and give the same message. 5 wrong passwords lock the account for 15 minutes. A password change or suspension signs the user out everywhere.
- **Authorization:** every route checks identity, role **and** resource ownership on the server (`protect(...)`, then ownership helpers). The UI hiding a button is never relied on.
- **Input:** every body is validated with strict Zod schemas (unknown fields rejected). Links must be `http(s)` (never `javascript:` or `data:`). Search text is regex-escaped. Route ids that are not valid ObjectIds are a 404.
- **Abuse protection:** per-IP rate limits (strict on auth routes), a 100 KB body limit, helmet security headers, a CORS allowlist and an `Origin` check on state-changing requests.
- **Data protection:** correct quiz answers are never sent before submission; certificate verification exposes only name, course and date; secrets and cookies are redacted from logs.
- **Concurrency:** unique indexes make duplicate enrollment, reviews and certificates impossible; quiz submission, refresh-token use and course completion are atomic.

## Testing

`npm test` runs unit and integration tests (Vitest, Supertest, in-memory MongoDB). They cover authentication and sessions, the permission matrix for every role, the whole course workflow, quiz grading and time limits, assignments and grading, engagement features, administration, security behaviour (token tampering, rotation, lockout, CSRF, rate limiting) and API documentation coverage (a test fails if a route is undocumented).

## Project layout

```
src/
  app.ts, server.ts          Express app (testable) and process entry point
  config/                    Validated environment, database connection
  middleware/                Auth, validation, security, error handling
  modules/<feature>/         *.model.ts, *.schemas.ts (Zod), *.service.ts (business rules), *.routes.ts (HTTP only)
  shared/                    Errors, helpers, logger, URL schema
  docs/openapi.ts            OpenAPI document (request schemas come from the Zod schemas)
  scripts/                   Seed scripts
tests/                       Integration tests; tests/unit for pure logic
```

More detail: [docs/architecture.md](docs/architecture.md).

## Known limitations

- Assignment submissions accept text and a link. File uploads need object storage (S3/Cloudinary).
- Password reset and email verification need an email provider (`/auth/forgot-password` is a stub).
- Avatars are stored as small data URLs in the user document; move them to object storage at scale.
