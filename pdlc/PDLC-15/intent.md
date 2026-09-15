---
id: PDLC-15
cycle: 1
title: GET /pet/findByStatus acepta status inválidos y responde 200
problem: >
  GET /pet/findByStatus acepta cualquier string en el query param status.
  Un valor que no está en el enum del contrato (available, pending, sold)
  responde 200 con lista vacía o un comportamiento inconsistente según la
  capa de persistencia. Soporte y el cliente móvil no distinguen "sin
  mascotas" de "parámetro mal escrito".
proposed_outcome: >
  Validar status contra el enum del OpenAPI. Una petición con un valor
  permitido (p. ej. status=available) sigue funcionando como hoy. Un valor
  inválido (p. ej. status=foo) responde HTTP 400 con un mensaje que indique
  los valores permitidos, usando el cuerpo de error estándar del API. El
  contrato en openapi.yaml documenta el enum y el 400; tests de integración
  cubren al menos un status válido y uno inválido.
affected_systems:
  - openapi-petstore
constraints:
  - >
    Fuera de alcance: paginación (PDLC-14), cambios en el cliente móvil,
    y otros endpoints de /pet.
  - >
    El contrato en src/main/resources/openapi.yaml debe documentar el enum
    (available, pending, sold) y el código de error 400.
  - >
    Tests de integración cubren al menos un status válido y uno inválido.
  - >
    Lista mixta: si cualquiera de los valores separados por coma está
    fuera del enum (p. ej. status=available,foo), toda la petición
    responde 400. No se filtra el inválido ni se devuelve 200 con el
    subconjunto válido (decisión del product owner, 2026-09-15,
    https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10102).
open_questions: []
requested_by: Juan Carlos Gamez Lozano (gamezj@gmail.com)
source_docs: []
source: jira-intake
status: approved
approved_by: Juan Carlos Gamez Lozano
approval_evidence: "https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10101"
---

Track `standard` (Story). Criterios de aceptación tomados del ticket Jira PDLC-15:

1. `GET /pet/findByStatus?status=available` sigue funcionando como hoy.
2. `GET /pet/findByStatus?status=foo` responde **400** con un mensaje que indique los valores permitidos.
3. El contrato en `openapi.yaml` documenta el enum y el código de error.
4. Tests de integración cubren al menos un status válido y uno inválido.

El ticket cita el enum en `openapi.yaml`. Ese contrato ya declara
`available` / `pending` / `sold`, `status` como array (valores separados
por coma) y un 400 "Invalid status value" **sin** schema de cuerpo. La
forma exacta del "cuerpo de error estándar" queda para `spec.md`, no se
inventa aquí.

Decisión del product owner (2026-09-15), palabras: «si es correcto»:
si llega una lista mixta (`status=available,foo`), toda la petición
responde 400 (Jira comment 10102).

Sin epic ni PRD/RFC enlazados; `source_docs` vacío a propósito.
