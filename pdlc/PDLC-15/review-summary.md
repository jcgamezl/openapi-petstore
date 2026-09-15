---
id: PDLC-15
title: GET /pet/findByStatus acepta status inválidos y responde 200
diff: 41f059965cae5ac3355f5c5aceefddc0602390cf...d279483
reviewers:
  - code-review
  - java-conventions (inferred — stacks-for declared no matching pattern)
  - unit-test-writer
  - security
not_dispatched:
  - e2e-testing (no browser flow)
  - design-system (no UI)
---

# Review summary — PDLC-15

Reviewed `pdlc/PDLC-15` (`41f0599...d279483`) in worktree `.worktrees/PDLC-15`. Same diff for every reviewer. `stacks-for --diff 41f0599` named no stack; `java-conventions` was inferred because the change is Java.

This module does not approve the launch gate.

## Blocking (at first pass — subsequently fixed on the branch)

| Finding | Sources | Resolution on `d279483` |
|---|---|---|
| `PetFindByStatusValidationIT` never ran under `mvn test` (Surefire default excludes `*IT.java`; no failsafe plugin). Verified: `mvn -B test` produced no surefire reports. | java-conventions, security | Renamed to `PetFindByStatusValidationTest.java`. Re-ran `mvn -B test`: **Tests run: 6, Failures: 0**. |
| Empty tokens after trim were dropped (`filter(!isEmpty)`), so `status=available,` returned 200. | code-review, unit-test-writer, security | Filter removed; empty token → 400. New test `emptyStatusToken_returns400`. |
| `ValidationError.path` documented but omitted at runtime (`ErrorAttributes` without `/error` dispatch). | code-review | Handler now builds an allowlisted body (`timestamp`, `status`, `error`, `message`, `path`). Test asserts `$.path` contains `/pet/findByStatus`. |
| Unconditional `--add-opens` would break a JDK 8 Surefire JVM (`Unrecognized option`). | code-review | Moved to Maven profile `jdk9-plus` activated on `[9,)`. |

## Remaining — not blocking for this ticket's AC, still advisory

| Severity | Finding | Sources |
|---|---|---|
| Major (waived by plan, still a spec gap) | Spec observability promised `pet_find_by_status_requests_total` and `pet_find_by_status_invalid_status_total` plus an INFO reject log. Diff does not emit them. Plan waived runtime metrics: verification MVP = CI. | pr-review vs spec.md Observability; plan.md open_questions |
| Major (plan-authorized blast radius) | `@ExceptionHandler(ResponseStatusException)` is global (`getPetById` 404, `uploadFile` 500, store/user delegates). Plan asked for this handler; 404/500 now get the allowlisted JSON including `path`. No tests on those other endpoints. | code-review, java-conventions, security |
| Major (advisory) | 200 tests only assert `jsonPath("$").isArray()`, not pet count/content. `PetRepository` unchanged. | unit-test-writer |
| Minor | JAXB runtime on the production classpath (needed to boot OAuth2 JAXB converters on JDK 9+). Advisory status **unverified** — no OWASP dependency-check / osv-scanner run. | security |
| Minor | `addFilters = false` (plan assumption). OAuth not in ticket. | all |
| Minor | No cap/dedupe of status tokens (`EnumSet` would bound cost). | security |
| Out of diff (pre-existing hard stops, true severity) | Committed demo secrets in `application.properties`; hardcoded API key in `ApiUtil`; `DISABLE_OAUTH`. Not introduced here. | security |

## Completeness vs approved plan

Implemented: trim, fail-fast 400, allowed-values message, ExceptionTranslator, OpenAPI 400 + `ValidationError`, generate-sources still `List<String>`, matrix cases 1–5 plus empty token. Extra vs plan (documented): JAXB 2.3.1 for JDK 9+ boot, JDK 9+ Surefire `--add-opens`.

## Verification evidence

- `mvn -B test` after rename: Tests run: 6, Failures: 0, in `PetFindByStatusValidationTest`.
- PR: **not opened**. `git-guard` aborted push because `jcgamezl/openapi-petstore` is publicly visible on GitHub. Local commits: `adcff3d`, `d279483`.
