---
id: PDLC-15
cycle: 1
title: GET /pet/findByStatus acepta status inválidos y responde 200
business_case: >
  Problema (fuente: intent.md aprobado / Jira PDLC-15): GET /pet/findByStatus
  acepta cualquier string en status; un valor fuera de available/pending/sold
  responde 200 con lista vacía o comportamiento inconsistente, y soporte y el
  cliente móvil no distinguen "sin mascotas" de "parámetro mal escrito".

  No hay PRD ni cifras de negocio (source_docs vacío). Este repositorio no
  puede medir tickets de soporte ni errores de cliente móvil: PetRepository
  es un HashMap en memoria, sin telemetría. El valor (menos falsos vacíos,
  contrato predecible) se verifica aquí con métricas de mecanismo en tests
  de integración (ver success_metrics).

  Escenarios de valor — todos [PENDING], sin fuente cuantitativa:
  - Pesimista: pocos clientes envían typos; el 400 solo aclara el contrato.
  - Base: [ASSUMPTION: el problema descrito en Jira es real en el cliente
    móvil y en soporte, no medido en este repo].
  - Optimista: el 400 reduce tiempo de diagnóstico en soporte. Sin volumen
    ni coste, ROI y payback no se calculan.

  Coste/effort: fuera de alcance de define — estimación del engineering
  lead en design (spec.md).

  Riesgo principal: un 400 más estricto rompe clientes que hoy envían
  status inválidos y tratan 200+lista vacía como "sin resultados"
  (mitigación: valores válidos no cambian; el mensaje lista el enum).

  Recomendación: proceder — el ticket es un cambio de contrato acotado
  (enum + 400); la viabilidad y el esfuerzo se confirman en design. El
  caso de negocio queda [PENDING] de cifras.
mvp_scope:
  in_scope:
    - >
      Validar cada valor de query status contra el enum available, pending,
      sold en GET /pet/findByStatus.
    - >
      status=available (y pending, sold) sigue respondiendo 200 con el
      mismo contrato de lista que hoy.
    - >
      Un valor inválido (p. ej. status=foo) responde HTTP 400 con un
      mensaje que indique los valores permitidos.
    - >
      Lista mixta (p. ej. status=available,foo): HTTP 400 para toda la
      petición; no filtrar el inválido ni devolver 200 con el subconjunto
      válido (decisión PO 2026-09-15).
    - >
      Actualizar src/main/resources/openapi.yaml: enum documentado y 400
      con cuerpo de error (forma exacta → spec.md).
    - >
      Tests de integración: al menos un status válido, uno inválido, y
      una lista mixta → 400.
  out_of_scope:
    - Paginación de findByStatus (PDLC-14).
    - Cambios en el cliente móvil.
    - Otros endpoints de /pet (findByTags, getPetById, etc.).
    - Cambiar autenticación o permisos del endpoint (ResourceServerConfiguration).
    - Migración de datos o cambios de modelo Pet.
    - >
      KPIs de tickets de soporte o errores de cliente móvil — no medibles
      en este repo.
success_metrics:
  - >
    North Star: status inválido rechazado — formula: count(HTTP 400) /
    count(peticiones findByStatus con al menos un status fuera del enum)
    = 1; baseline: [PENDING] (el ticket describe 200+lista vacía, no hay
    medición en este repo); target: 100%; window: cada release;
    source: tests de integración
  - >
    Valor válido sin regresión — formula: GET /pet/findByStatus?status=available
    (y pending, sold) responde HTTP 200; baseline: [PENDING]; target: 100%;
    window: cada release; source: tests de integración
  - >
    Lista mixta rechazada — formula: GET con status=available,foo responde
    HTTP 400; baseline: [PENDING]; target: 100%; window: cada release;
    source: tests de integración
  - >
    Guardrail: contrato de lista en 200 — protects: clientes que hoy
    consumen un array de Pet en éxito; alarm at: cualquier 200 de
    findByStatus con status solo-válido cuyo cuerpo deje de ser lista de
    Pet; source: tests de integración
assumptions:
  - >
    PetRepository es un HashMap en memoria; no hay telemetría ni cliente
    móvil en este repo (fuente: PetRepository.java).
  - >
    El enum permitido es available, pending, sold (fuente: intent.md /
    openapi.yaml).
  - >
    PetApiDelegateImpl.findPetsByStatus ya lanza ResponseStatusException
    400 si StatusEnum.fromValue es null (líneas 84-88). El ticket describe
    200+lista vacía; design debe verificar el runtime (capa generada vs
    delegate) y cerrar contrato + mensaje + tests aunque el delegate ya
    rechace. [ASSUMPTION: el hueco puede estar en el contrato, el cuerpo
    de error o un binding que no llega al delegate.]
  - >
    Hoy no hay src/test ni spring-boot-starter-test en pom.xml; los tests
    de integración del AC hay que añadirlos en develop.
dependencies:
  - >
    Ningún ticket bloqueante. PDLC-14 (paginación del mismo endpoint) es
    concurrente y explícitamente fuera de alcance; si ambas ramas tocan
    openapi.yaml y PetApiDelegateImpl, hay riesgo de conflicto de merge
    — no es dependencia funcional.
  - >
    Regeneración OpenAPI (openapi-generator-maven-plugin, delegatePattern)
    si el cambio de contrato regenera el API antes de editar el delegate
    a mano (fuente: pom.xml / intent.md PDLC-14, mismo patrón).
impact_assessment: >
  Dependientes (verificado en código): consumidores de GET /pet/findByStatus
  — el ticket cita soporte y el cliente móvil; implementación en
  PetApiDelegateImpl.findPetsByStatus (líneas 84-91) →
  PetRepository.findPetsByStatus; contrato en openapi.yaml:61; exposición
  OAuth en ResourceServerConfiguration.java:22. ExceptionTranslator solo
  mapea ConstraintViolationException, no ResponseStatusException.

  Impacto de fallo: si el 400 no se emite, el problema del ticket permanece
  (200 ambiguo). Si el 400 se emite para valores válidos, el cliente móvil
  deja de listar inventario. Si una lista mixta devolviera 200 con el
  subconjunto válido, soporte seguiría sin ver el typo — la decisión PO
  es rechazar toda la petición.

  Contención hoy: el cambio está acotado a un query param de un endpoint;
  no hay feature flag. Valores válidos deben conservar 200. No hay
  canary en este repo ([PENDING] para launch).
concept_prototyping: ""
event_storming: ""
feature_prioritization:
  - feature: Validar status contra el enum y 400 en valor inválido
    priority: must
    rationale: Criterios de aceptación Jira #1 y #2; resuelve el problema.
  - feature: Lista mixta (available,foo) → 400 de toda la petición
    priority: must
    rationale: Decisión del product owner 2026-09-15 («si es correcto»).
  - feature: Mensaje 400 que liste los valores permitidos
    priority: must
    rationale: Criterio de aceptación Jira #2.
  - feature: openapi.yaml con enum y 400 documentados
    priority: must
    rationale: Criterio de aceptación Jira #3; contrato público.
  - feature: Tests de integración válido / inválido / lista mixta
    priority: must
    rationale: Criterio de aceptación Jira #4 más la decisión de lista mixta.
  - feature: Paginación, cliente móvil, otros /pet
    priority: wont
    rationale: Explícitamente fuera de alcance en intent.md.
open_questions:
  - >
    Caso de negocio sin cifras (tickets de soporte, volumen de typos).
    Waived para este MVP de demo: las métricas de mecanismo en CI sustituyen
    KPIs de producción en este repo, igual que PDLC-14.
  - >
    Cuerpo de error exacto del 400 («estándar del API») — design / spec.md;
    hoy el 400 de findByStatus no tiene schema y ExceptionTranslator no
    cubre ResponseStatusException.
  - >
    Veredicto de viabilidad y estimación de esfuerzo — engineering lead
    en design (spec.md).
source_docs: []
status: approved
approved_by: Juan Carlos Gamez Lozano
approval_evidence: "https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10104"
---

Derivado de `intent.md` aprobado (evidencia: Jira comment 10101) y de la
decisión de producto 2026-09-15: lista mixta → 400 de toda la petición
(palabras: «si es correcto»; evidencia:
https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10102).

Sin PRD/RFC; `source_docs` vacío. No hay feature spec-kitti para PDLC-15.

### Historia de usuario (INVEST)

Como **consumidor de GET /pet/findByStatus** (soporte o cliente móvil),
quiero **que un status mal escrito se rechace con 400 y los valores
permitidos**, para **no confundir "sin mascotas" con un parámetro inválido**.

| Criterio INVEST | Evaluación |
|---|---|
| Independent | Sí — un query param de un endpoint; PDLC-14 está out of scope |
| Negotiable | Sí — schema exacto del error queda en design |
| Valuable | Sí — quita la ambigüedad 200 vs error (intent.md) |
| Estimable | Sí a nivel de alcance; esfuerzo → design (engineering lead) |
| Small | Sí — acotado a validación de status en findByStatus |
| Testable | Sí — métricas de mecanismo + AC Given/When/Then |

No se parte por capas (controller / contrato / tests): eso es `plan.md`.

### Métricas de éxito — este ticket (mecanismo, CI)

KPIs de soporte y móvil **no aplican** aquí. Vuelven a quien opere el
cliente. Baselines de producción: `[PENDING]` (nunca medidos en este repo).

| # | Métrica | Baseline (hoy) | Objetivo | Verificación |
|---|---|---|---|---|
| 1 | Status inválido → 400 | [PENDING] (ticket: 200+vacío) | 100% HTTP 400 | Test de integración |
| 2 | Status válido → 200 | [PENDING] | 100% HTTP 200 | Test de integración |
| 3 | Lista mixta → 400 | [PENDING] | 100% HTTP 400 | Test de integración |
| Guardrail | 200 sigue siendo array de Pet | contrato actual | sin cambio de forma | Test de integración |

### Criterios de aceptación (Given/When/Then)

1. **Given** el enum `available`/`pending`/`sold`, **When** `GET /pet/findByStatus?status=available`, **Then** HTTP 200 con el mismo contrato de lista que hoy.
2. **Given** un valor fuera del enum, **When** `GET /pet/findByStatus?status=foo`, **Then** HTTP 400 y el mensaje indica los valores permitidos.
3. **Given** una lista mixta, **When** `GET /pet/findByStatus?status=available,foo`, **Then** HTTP 400 para toda la petición (no 200 con solo `available`).
4. **Given** `openapi.yaml` actualizado, **When** se valida el contrato, **Then** el enum y el 400 quedan documentados.
5. **Given** tests de integración, **When** corre el suite, **Then** cubren al menos un status válido, uno inválido y una lista mixta.

### Handoff a design (engineering lead)

Fuera del gate de define — entradas para `spec.md`:

- Verificar runtime: ¿el 200 del ticket ocurre aún, o el delegate ya hace 400?
- Schema del cuerpo de error 400 (ApiResponse vs error Spring).
- Veredicto de viabilidad (viable / viable con condiciones / no viable) y estimación (t-shirt o rango).
