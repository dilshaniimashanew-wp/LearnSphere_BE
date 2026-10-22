# Architecture notes

## Layers

Each feature folder under `src/modules/` follows the same shape so a change has one obvious home:

| File              | Responsibility                                                                 | Knows about HTTP? |
| ----------------- | ------------------------------------------------------------------------------ | ----------------- |
| `*.model.ts`      | Mongoose schema, indexes                                                       | no                |
| `*.schemas.ts`    | Zod request validation (also used to generate the API docs)                    | no                |
| `*.service.ts`    | Business rules and use cases; throws `AppError`                                | no                |
| `*.routes.ts`     | Parse request, check access, call a service, shape the response                | yes               |
| `*.presenter.ts`  | Turns documents into API shapes (courses)                                      | no                |

Rules that matter are in services so they can be unit tested without a server, for example `gradeAnswers`, `isPassing`, `courseProgress` and `evaluateCompletion`.

## Request pipeline

```
request -> pino-http -> helmet -> CORS -> JSON parser (100 KB) -> cookies -> Origin check
        -> rate limit -> route:  protect(roles) -> validateBody(schema) -> handler -> service
        -> notFoundHandler / errorHandler  (one JSON error shape for everything)
```

`protect()` is applied **per route**, so an unknown URL is always a 404 and never leaks "authentication required".

## Errors

Services throw `AppError(status, code, message, details)`. The error handler converts it, plus malformed JSON (400), oversized bodies (413) and duplicate keys (409), into `{ error: { code, message, details } }`. Anything else is logged and returned as a generic 500.

## Sessions

```
login -> access JWT (15 min, cookie, path /) + refresh token (7 days, cookie, path /api/v1/auth)
call API with expired access token -> 401 -> web app calls POST /auth/refresh once -> retries
refresh -> old token marked revoked, new token issued (rotation)
old token presented again -> treated as theft -> all sessions of the user deleted
```

Sessions live in the `RefreshSession` collection (hash only, TTL index removes expired ones).

## Completion rule (single source of truth)

`progress.service.ts`: a course is complete when **every required lesson is complete and every published quiz has a passing attempt**. The transition `active -> completed` is a single atomic update, so the certificate and notification are produced exactly once even under concurrent requests.

## Data model decisions

- Small bounded data is embedded (objectives, quiz options). Growing data has its own collection (attempts, submissions, notifications, progress).
- References are validated in services because MongoDB does not enforce foreign keys.
- Unique compound indexes enforce one enrollment, one review and one certificate per student and course, and one progress row per student and lesson.
- Quiz questions store the answer key in a field excluded from queries by default (`select: false`); only the owner's view opts in.
- Grades are stored on the submission (a deliberate simplification of the spec's separate `grades` collection, since a submission has at most one current grade).

## Testing approach

- Integration tests drive the real Express app through Supertest against an in-memory MongoDB, so they run anywhere with no secrets.
- Permission tests are table driven: every role against every sensitive route.
- A docs test parses the route files and fails when a route and the OpenAPI document disagree.
- Bugs found by tests so far (all fixed): `javascript:` links accepted by `z.url()`, partial updates resetting untouched fields through schema defaults, malformed JSON returning 500, and authentication shadowing 404s.
