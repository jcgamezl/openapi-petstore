---
id: PDLC-15
cycle: 1
title: GET /pet/findByStatus acepta status inválidos y responde 200
implementation_steps:
  - >
    pom.xml: añadir spring-boot-starter-test (scope test, sin versión — BOM
    parent 2.0.2.RELEASE). Verificado: pom.xml:64-119 no declara tests.
  - >
    NEW src/test/java/org/openapitools/api/PetFindByStatusValidationIT.java:
    primer test status=foo — documenta el status HTTP real (ticket dice 200;
    PetApiDelegateImpl:84-88 lanza 400). Luego el resto de la matriz.
  - >
    PetApiDelegateImpl.java findPetsByStatus: trim de cada token; fail-fast
    400 si fromValue es null; message
    "Invalid status value. Allowed: available, pending, sold" (spec ADR).
  - >
    ExceptionTranslator.java: @ExceptionHandler(ResponseStatusException)
    con ErrorAttributes includeStackTrace=false (el handler actual solo
    cubre ConstraintViolationException, líneas 23-28).
  - >
    src/main/resources/openapi.yaml /pet/findByStatus: content JSON en 400
    (schema ValidationError o inline: status, error, message, path);
    description incluye listas mixtas. Conservar enum existente.
  - >
    mvn generate-sources — revisar firma PetApiDelegate; si el generador
    cambia List<String> a List<StatusEnum>, revertir/configurar para
    conservar strings (spec ADR).
  - >
    Completar PetFindByStatusValidationIT: available → 200 Pet[]; foo → 400
    con los tres valores en message; available,foo → 400; available,pending
    → 200; available, pending (espacio) → 200 tras trim.
  - >
    mvn test — verde en local antes de PR.
touched_systems:
  - openapi-petstore
test_strategy: >
  Integración (principal): PetFindByStatusValidationIT con @SpringBootTest +
  MockMvc. Matriz spec: (1) status=available → 200 array; (2) status=foo →
  400 y message contiene available, pending, sold; (3) status=available,foo
  → 400 (no 200 con subconjunto); (4) status=available,pending → 200;
  (5) contrato 400 documentado vía generate-sources sin error. Seguridad:
  [ASSUMPTION: @AutoConfigureMockMvc(addFilters = false) — OAuth2 no es
  objeto de este ticket, igual que el plan PDLC-14]. Unitario opcional:
  extraer el parse/trim/allowlist a un método estático y testearlo si el
  IT no cubre espacios. Latencia: no es path latency-sensitive en scope;
  sin check de p95. No hay baseline de producción ([PENDING] en scope.md).
risks_and_rollback: >
  Riesgo: 400 en inválidos es breaking frente a clientes que trataban 200
  vacío como "sin resultados" — aceptado en spec ADR (mismo /v3). Riesgo:
  generate-sources cambia la firma del delegate — mitigar revisando el
  diff de generated-sources antes de tocar la impl. Riesgo: conflicto de
  merge con pdlc/PDLC-14 (worktree activo; ya modifica pom.xml,
  PetApiDelegateImpl.java y openapi.yaml). Mitigación: implementar en
  pdlc/PDLC-15 desde master; no copiar la rama 14; rebase/merge consciente
  al integrar. Rollback: revert del commit en pdlc/PDLC-15; sin migración
  ni feature flag. No tocar ResourceServerConfiguration.
open_questions:
  - >
    Confirmar con engineering lead: implementar en pdlc/PDLC-15 aislado de
    PDLC-14 (mismo endpoint, tres archivos compartidos). Si PDLC-14 mergea
    antes, rebase de esta rama sobre esos cambios.
  - >
    Estrategia OAuth en IT si addFilters=false no es aceptable —
    alternativa: spring-security-test. Waived a favor del ASSUMPTION
    salvo que el lead lo contradiga al aprobar.
  - >
    Tooling de métricas en despliegue (spec open_questions) — waived para
    este plan: verificación MVP = CI, no dashboards.
source_docs:
  - pdlc/PDLC-15/spec.md
  - pdlc/PDLC-15/scope.md
status: approved
approved_by: Juan Carlos Gamez Lozano
approval_evidence: "https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10108"
---

Track **standard** — plan derivado de `spec.md` aprobado (Jira comment
10106). Aprobado por el engineering lead (Jira comment 10108, palabras:
«aprobado»). La implementación en `pdlc/PDLC-15` aislada de PDLC-14 queda
aceptada al no contradecir esa pregunta.

### Exploración del repo (confirmado)

| Qué | Resultado |
|---|---|
| `openapi.yaml` `/pet/findByStatus` | Existe `src/main/resources/openapi.yaml:61` — enum + 400 sin `content` |
| `PetApiDelegateImpl.findPetsByStatus` | Existe; 400 vía `ResponseStatusException` si `fromValue` es null |
| `ExceptionTranslator` | Existe; solo `ConstraintViolationException` |
| `PetRepository` | Existe; no se toca (validación no vive ahí) |
| Tests | Ninguno (`src/test` ausente) |
| `spring-boot-starter-test` | No en `pom.xml` |
| `ResourceServerConfiguration` | Sin cambios |
| Módulo/servicio equivalente | El endpoint ya existe — **no** se crea servicio nuevo |
| Trabajo in-flight | Worktree `.worktrees/PDLC-14` rama `pdlc/PDLC-14` ya cambia `pom.xml`, `PetApiDelegateImpl.java`, `openapi.yaml` (83 líneas vs master). Esta rama `pdlc/PDLC-15` está en el mismo commit que master (`41f0599`) |

Contradicción ticket vs código: queda como el primer test, no se elige
una narrativa en silencio (spec.md technical discovery).

### Orden de ejecución (detalle)

**Paso 1 — Dependencia de test**  
Sin esto no hay JUnit/MockMvc. Coordenadas: `org.springframework.boot:spring-boot-starter-test`, `scope` test, versión del parent.

**Paso 2 — Test que caracteriza `status=foo`**  
IT NEW. Arrange seed de `initPets()` (10 pets). Act GET `/v3/pet/findByStatus?status=foo`. Assert: HTTP 400 y `message` con el enum (el assert de message puede fallar hoy — el texto actual es `"Invalid status: " + s`).

**Paso 3 — Delegate**  
Trim; mensaje del spec; lista mixta fail-fast (cualquier token inválido aborta el stream).

**Paso 4 — ExceptionTranslator**  
Mapear `ResponseStatusException` al mismo JSON Boot 2 que el spec documenta. Sin stack trace.

**Paso 5 — OpenAPI**  
400 con schema. `mvn generate-sources`. Conservar `List<String>`.

**Paso 6 — Completar IT**

| Caso | Assert |
|---|---|
| `?status=available` | 200, JSON array |
| `?status=foo` | 400, message contiene los tres valores |
| `?status=available,foo` | 400 |
| `?status=available,pending` | 200, array |
| `?status=available,%20pending` o `available, pending` | 200 (trim) |

**Paso 7** — `mvn test`.

### Estimación

[ASSUMPTION: t-shirt **S**, derivado del spec (4-5 archivos, 1 IT NEW, sin migraciones). El lead no dio talla en 10106; corrige al aprobar este plan.]

### Fuera de este plan

- Paginación (PDLC-14), cliente móvil, otros `/pet`
- Observability runtime / dashboards
- RFC 7807, `ModelApiResponse` para este 400
- Cambiar `required` de `status`
