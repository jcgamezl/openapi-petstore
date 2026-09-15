---
id: PDLC-15
cycle: 1
title: GET /pet/findByStatus acepta status inválidos y responde 200
pr_link: "[PENDING — branch pdlc/PDLC-15 not on origin; git-guard blocked push to public jcgamezl/openapi-petstore]"
review_summary: >
  code-review, java-conventions (inferred; stacks-for named none),
  unit-test-writer and security reviewed 41f0599...d279483. First-pass
  blocking items (Surefire skipping *IT, empty tokens → 200, missing
  path in 400 JSON, JDK 8-unsafe --add-opens) were fixed on d279483.
  mvn -B test: 6/6 green. Remaining: spec metrics not emitted (plan
  waived to CI), global ResponseStatusException handler, PR not opened.
rollout_plan: >
  [PENDING — no application deploy pipeline in this repo; only
  .github/workflows/pdlc-gate-check.yml on pull_request/push to
  master/main.] When a PR exists: merge to master after release-manager
  approval of this draft. Deploy is whoever currently ships this sample
  JAR — not defined here. Owner: [PENDING]. Per-env verification: GET
  /v3/pet/findByStatus?status=foo → 400 with Allowed: available, pending,
  sold; GET ...?status=available → 200 array. No feature flag.
rollback_plan: >
  Mechanism: revert the merge commit on master and redeploy the previous
  JAR (last known good: 41f0599). No migration, no flag, point of no
  return: none. Triggers/thresholds/source metrics: [PENDING — spec has
  no on-call or dashboards; plan waived runtime observability]. Owner:
  [PENDING]. Target RTO: [PENDING]. Post-rollback: same two GETs as
  rollout; 400 path gone means clients that sent invalid status see the
  pre-ticket behaviour again (existing 400 with "Invalid status: …" on
  41f0599, not 200 empty). Kill switch: none — flipping nothing disables
  the path; revert is the switch.
verification: >
  Against approved spec.md handoff AC and scope success metrics, via
  PetFindByStatusValidationTest (mvn -B test, 6/6, d279483): (1)
  available → 200 array: met (available_returns200Array). (2) foo → 400
  with three enum values in message: met. (3) available,foo → 400: met.
  (4) OpenAPI 400 schema: met (openapi.yaml ValidationError). (5)
  available,pending → 200: met. Trim: met. Empty token → 400: met (added
  after review). Design QA: no user-facing UI; API contract only, matches
  spec UX-absent technical AC. Spec counters
  pet_find_by_status_requests_total / invalid_status_total: not met —
  plan waived to CI; listed in open_questions. Dashboards/SLO: none in
  repo; watch window [PENDING].
open_questions:
  - >
    PR not on GitHub. git-guard blocked push because the repo is public.
    Release manager cannot click pr_link until a human pushes
    pdlc/PDLC-15 (or git-guard is adjusted).
  - >
    Spec observability counters and reject INFO log were not implemented;
    plan.md waived them (verification MVP = CI). Release manager waives
    or asks for a follow-up.
  - >
    Rollback trigger threshold, named owner, and RTO are [PENDING] —
    no on-call or dashboard in this repo.
  - >
    Merge conflict risk with in-flight pdlc/PDLC-14 (same files: pom.xml,
    PetApiDelegateImpl.java, openapi.yaml).
  - >
    Dependency advisories for jaxb-api/jaxb-runtime 2.3.1 unverified
    (no scanner in repo; would need mvn org.owasp:dependency-check-maven:check
    or osv-scanner).
source_docs:
  - pdlc/PDLC-15/spec.md
  - pdlc/PDLC-15/scope.md
  - pdlc/PDLC-15/plan.md
  - pdlc/PDLC-15/review-summary.md
status: approved
approved_by: Juan Carlos Gamez Lozano
approval_evidence: "https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10110"
---

Launch gate for PDLC-15. Release manager approval recorded from Jira comment 10110 (words: «aprobado»).

### Reviewers

- [code-review](d9b5bce5-3373-4c25-9887-261e670de476)
- [java-conventions](c379a8ac-5e01-4f3d-a967-c67035843047) (inferred)
- [unit-test-writer](68034348-5d1a-42de-bb89-4577f28fa58d)
- [security](ef2e56d5-22e1-430f-8e44-e9f5077e1a5d)

### Ranked findings

See `review-summary.md`. Blocking items from the first pass are fixed on
`d279483`. Nothing in this draft recommends approve or reject.

### What the release manager still needs

1. A public PR URL in `pr_link` (push is currently blocked locally).
2. A decision on the waived metrics.
3. Owner / RTO / trigger numbers, or an explicit waiver of those `[PENDING]` fields.
