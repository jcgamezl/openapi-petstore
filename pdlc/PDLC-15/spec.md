---
id: PDLC-15
cycle: 1
title: GET /pet/findByStatus acepta status inválidos y responde 200
sections_included:
  - technical_discovery
  - architecture_decisions
  - api_contract
  - security_design
  - observability
  - handoff_documentation
technical_architecture: >
  Validar cada token de query status contra el enum available/pending/sold
  en PetApiDelegateImpl.findPetsByStatus. Cualquier token inválido (incluido
  en lista mixta) → HTTP 400 con message que lista el enum; no 200 con
  subconjunto. Documentar 400 JSON en openapi.yaml. Extender ExceptionTranslator
  para ResponseStatusException sin stack trace. Tests MockMvc. Sin cambio de
  auth, modelo Pet ni paginación.
handoff_documentation: >
  Develop toca openapi.yaml (400 content), PetApiDelegateImpl (mensaje + trim),
  ExceptionTranslator (handler 400), pom.xml (spring-boot-starter-test alineado
  al parent 2.0.2.RELEASE) y un IT nuevo. No tocar ResourceServerConfiguration
  ni otros /pet. Veredicto: viable (Juan Carlos Gamez Lozano, Jira 10106).
  Estimación: [PENDING — t-shirt no dicha en la aprobación].
new_components_created: []
open_questions:
  - >
    [PENDING — missing: estimación de esfuerzo (t-shirt o rango). La aprobación
    dijo «viable apruebo» y no dio talla; plan.md puede usar el borrador S.]
  - >
    [PENDING — missing: qué tooling de métricas/logs usa este servicio en
    despliegue. Señales abajo son vendor-neutral; la verificación MVP es CI.]
source_docs: []
status: approved
approved_by: Juan Carlos Gamez Lozano
approval_evidence: "https://demoday-agentic.atlassian.net/browse/PDLC-15?focusedCommentId=10106"
---

Derivado de `scope.md` aprobado (Jira comment 10104) e `intent.md` (10101).
Decisión lista mixta → 400 (comment 10102). Sin PRD; sin feature spec-kitti.

Secciones UX omitidas a propósito: no hay UI. `domain_model` omitido: el
enum ya existe en `Pet.StatusEnum`; no hay agregado nuevo.

## Technical discovery

### Hallazgo: el ticket y el código no coinciden

Jira PDLC-15 describe inválidos → **200 + lista vacía**. El código actual
en `PetApiDelegateImpl.findPetsByStatus` (líneas 84-88) hace
`Pet.StatusEnum.fromValue(s)` y si es null lanza
`ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid status: " + s)`.

Eso es un **400** si la petición llega al delegate. No se elige una de las
dos narrativas: develop escribe primero el test de `status=foo` y registra
el status real. Trabajo restante en cualquier caso: mensaje que liste el
enum, 400 documentado en OpenAPI, lista mixta, tests, cuerpo sin stack
trace.

[ASSUMPTION: si el controller generado intercepta el enum antes del
delegate, el 400 de binding puede no listar valores permitidos — hay que
unificar el mensaje en el delegate / ExceptionTranslator.]

### Estado actual (código)

| Componente | Ubicación | Comportamiento hoy |
|---|---|---|
| Contrato | `openapi.yaml:61-107` | `status` array + enum; 400 "Invalid status value" **sin** `content` |
| Delegate | `PetApiDelegateImpl.findPetsByStatus` | 400 con `"Invalid status: " + s`; no lista el enum |
| Repositorio | `PetRepository.findPetsByStatus` | Filtra HashMap; no valida el enum |
| Errores | `ExceptionTranslator` | Solo `ConstraintViolationException` → `ErrorAttributes` (`includeStackTrace=false`) |
| Auth | `ResourceServerConfiguration.java:22` | OAuth2 scopes `read:pets` + `write:pets` |
| Generación | `pom.xml` openapi-generator 3.0.0, `delegatePattern` | Interface generada en build; impl manual |
| Tests | — | No hay `src/test` ni `spring-boot-starter-test` |

`@PostConstruct initPets()` siembra 10 pets (available/pending/sold). Los
IT pueden usar ese seed para el caso válido.

### Viabilidad (borrador — no es el veredicto)

Cambio acotado a un query param, un handler de error y tests. Regenerar
OpenAPI si el 400 con schema cambia la firma; la firma actual
`List<String> statusList` debe **conservarse** para controlar el mensaje
(no pasar a `List<StatusEnum>` en el delegate si el generador lo propone
sin mensaje custom).

## Architecture decisions

### Decision: Reject the whole request on any invalid token

**Status** — Closed (product owner, Jira 10102).

**Context** — El contrato permite varios status separados por coma. El
ticket solo ejemplificaba `status=foo`. Scope: lista mixta → 400 total.

**Options considered**

1. **400 de toda la petición** — for: el cliente ve el typo; against: no
   se entrega el subconjunto válido.
2. **200 filtrando inválidos** — for: más datos; against: vuelve a
   esconder el error (rechazado por el PO).

**Chosen** — opción 1, porque el PO dijo «si es correcto».

**Consequences**

- **Benefits** — un solo código (400) para “parámetro mal escrito”.
- **Accepted trade-offs** — `available,foo` no lista pets available.
- **Mitigations** — el `message` lista el enum completo.

### Decision: Keep 400 on /v3 (breaking vs 200-empty)

**Status** — Closed (ticket + intent + scope). Marcado como call propio
respecto a versionar: el approver puede exigir `/v4`.

**Context** — api-design-refactor: un 200 que pasa a 400 es breaking.
El ticket pide el 400 en el mismo `GET /pet/findByStatus`.

**Options considered**

1. **Mismo `/v3`** — for: el 200+vacío era defecto, no éxito publicado;
   against: clientes que dependían del 200 vacío se rompen.
2. **Nuevo path/versión** — for: no rompe; against: fuera de alcance
   (intent: cambio acotado, no móvil).

**Chosen** — opción 1, porque el alcance aprobado no incluye versionar.

**Consequences**

- **Benefits** — un contrato.
- **Accepted trade-offs** — breaking para quien trataba inválido como
  “sin resultados”.
- **Mitigations** — 200 con enum válido no cambia (guardrail de scope).

### Decision: Error body via ResponseStatusException + ExceptionTranslator

**Status** — Closed (call de diseño; approver debe confirmar).

**Context** — Ticket: “cuerpo de error estándar del API”. Este repo **no**
usa RFC 7807/9457. `ModelApiResponse` es el schema de upload. Los 400 de
`openapi.yaml` no tienen `content`. El delegate ya usa
`ResponseStatusException`. El catálogo Java del cliente (itti RFC 9457)
no aplica a este petstore.

**Options considered**

1. **Spring Boot 2 DefaultErrorAttributes JSON** (`status`, `error`,
   `message`, `path`; sin stack) — for: ya es el camino de
   `ResponseStatusException`; against: no está en OpenAPI hoy.
2. **`ModelApiResponse` (code/type/message)** — for: schema existente;
   against: pensado para upload, no para validación.
3. **RFC 7807 `application/problem+json`** — for: plantilla del
   discipline; against: **inventaría** un segundo formato.

**Chosen** — opción 1, porque no introduce un contrato de error nuevo.

**Consequences**

- **Benefits** — un shape para 400 de validación.
- **Accepted trade-offs** — no es RFC 7807.
- **Mitigations** — documentar el JSON en el 400 de `/pet/findByStatus`;
  `ExceptionTranslator` maneja `ResponseStatusException` con
  `includeStackTrace=false` (hard stop: no stack traces).

`message` (hecho de diseño, no del ticket palabra por palabra):
`Invalid status value. Allowed: available, pending, sold`. Puede incluir
el token rechazado (`got: foo`) — es input del cliente, no un secreto.

### Decision: Trim each comma-separated token before the enum check

**Status** — Closed (call de diseño).

**Context** — `style: form`, `explode: false`. Clientes envían
`available, pending`.

**Options considered**

1. **Trim** — for: evita 400 por espacio; against: no está en Jira.
2. **Match exacto** — for: estricto; against: 400 sorpresa.

**Chosen** — trim, porque el enum sigue siendo la única allowlist.

**Consequences** — Benefits: menos falsos 400. Trade-off: `  foo  ` sigue
siendo inválido. Mitigación: tests con y sin espacios.

## API contract

### Conventions (existentes)

- **Base path** — `/v3` por defecto (`openapi.openAPIPetstore.base-path`).
- **Content-Type** — `application/json` (éxito y 400 de este cambio).
- **Auth** — OAuth2 `petstore_auth`, scopes `write:pets` y `read:pets`
  (sin cambio). Ver security design.
- **Error shape (este endpoint, 400 de status)** — JSON de error Spring
  Boot 2 (`status`, `error`, `message`, `path`). No RFC 7807.
- **Naming** — camelCase en schemas; query `status` como hoy.
- **Versioning** — sin bump; breaking aceptado (ADR arriba).

### GET /v3/pet/findByStatus

**What it does:** lista pets cuyo `status` está en la lista pedida.

**Query**

| Param | Tipo | Required | Constraints |
|---|---|---|---|
| status | array of string (form, no explode) | sí (ya en contrato) | cada token, tras trim, ∈ {available, pending, sold} |

Sin paginación en este ticket (PDLC-14 out of scope).

**200** — todos los tokens válidos. Cuerpo: array JSON de `Pet` (sin
cambio). Content-Type: `application/json`.

```json
[{ "id": 1, "name": "Cat 1", "status": "available" }]
```

**400** — uno o más tokens fuera del enum (incluye lista mixta y
`status=foo`).

```json
{
  "status": 400,
  "error": "Bad Request",
  "message": "Invalid status value. Allowed: available, pending, sold",
  "path": "/v3/pet/findByStatus"
}
```

`timestamp` puede aparecer (DefaultErrorAttributes Boot 2). Los tests
afirman `status=400` y que `message` contiene `available`, `pending` y
`sold`. No afirmar un schema de timestamp rígido.

**401/403** — sin cambio (OAuth2). No es el alcance de los IT de este
ticket más allá de no relajar seguridad.

**Missing `status`** — `required: true` ya en OpenAPI. Fuera de alcance
cambiarlo. [ASSUMPTION: el 400/generated actual se deja como está.]

### OpenAPI (`openapi.yaml`)

1. Conservar enum `available` / `pending` / `sold`.
2. Añadir `content.application/json` al 400 de `/pet/findByStatus` con
   schema de objeto (`status` integer, `error` string, `message` string,
   `path` string) — o `$ref` local `ValidationError` en
   `components/schemas`. No reutilizar `ApiResponse` de upload.
3. Description del 400: invalid status value; mixed lists included.
4. `mvn generate-sources`; si la firma del delegate cambia a
   `List<StatusEnum>`, **revertir/configurar** para seguir recibiendo
   strings (ADR: mensaje controlado).

### Ejemplos

```
GET /v3/pet/findByStatus?status=available
→ 200 Pet[]

GET /v3/pet/findByStatus?status=foo
→ 400, message incluye available, pending, sold

GET /v3/pet/findByStatus?status=available,foo
→ 400 (no 200 con solo available)

GET /v3/pet/findByStatus?status=available,pending
→ 200 Pet[]
```

### Backward compatibility

| Cambio | Breaking? |
|---|---|
| 400 en status inválido (si hoy fuera 200) | sí — aceptado |
| 200 con enum válido | no |
| Forma del array 200 | no |

## Security design

Trigger: endpoint **externo existente** (no uno nuevo). Se incluye porque
cambiamos validación y el cuerpo de error de una superficie autenticada
pública. No hay PII financiera ni LLM/MCP.

### Assets

| Asset | Clasificación | Notas |
|---|---|---|
| Lista de `Pet` | interno / bajo | Demo; no PII financiera |
| Query `status` | input no sensible | Allowlist; no secretos en URL |
| Cuerpo 400 `message` | público al caller | Solo enum + token rechazado |
| Capacidad del endpoint | autenticada | OAuth2 scopes existentes |

### STRIDE — componente `GET /pet/findByStatus` (validación)

| Categoría | ¿Aplica? | Mitigación |
|---|---|---|
| Spoofing | sí — caller sin token | Sin cambio: `ResourceServerConfiguration` exige scopes |
| Tampering | sí — `status` arbitrario | Allowlist enum; lista mixta → 400; trim no amplía el enum |
| Repudiation | sí, débil | [PENDING] sin audit log hoy; MVP = log estructurado en observability, no audit firmado |
| Information disclosure | sí — errores | `message` solo enum + token; `includeStackTrace=false`; no volcar `Pet` en logs |
| Denial of service | sí — listas enormes de tokens | [PENDING] sin rate limit en repo. Mitigación parcial: fail-fast al primer inválido. Gap no bloqueante del MVP; no inventar WAF |
| Elevation of privilege | no con justificación | Params no cambian `authorizeRequests`; misma ruta y scopes |

Gap DoS/rate-limit: no hay control en este servicio. No es “TBD”: queda
en `open_questions` como no cubierto por el ticket (fuera de alcance
igual que caché en PDLC-14). **Waived para MVP** salvo que el engineering
lead lo convierta en condición de viabilidad.

### OWASP (este cambio)

| ID | Aplica | Control |
|---|---|---|
| A01 Broken access control | sí | Mismos scopes; sin relajar `ResourceServerConfiguration` |
| A02 Cryptographic failures | n/a | Sin datos sensibles nuevos; status no es secreto |
| A03 Injection | sí | Allowlist enum; repo en memoria, sin concatenar SQL |
| A04 Insecure design | sí | Fail-closed en token inválido; STRIDE arriba |
| A05 Security misconfiguration | sí | Errores sin stack trace (ExceptionTranslator) |
| A06 Vulnerable components | sí | `spring-boot-starter-test` del BOM parent `2.0.2.RELEASE` (artefacto Spring existente; no inventar coordenadas). Advisory de CVEs: [PENDING] SCA en CI — no se afirma limpio |
| A07 Auth failures | n/a | Sin cambio de login/sesión |
| A08 Software and data integrity | n/a | Lectura + validación; sin deserializar blobs |
| A09 Logging failures | sí | Log de rechazo sin cuerpos Pet; ver observability |
| A10 SSRF | n/a | Sin URLs tomadas del query |

### Auth / secrets

Sin cambio. No loguear tokens. No poner secretos en `message`.

### Eventos auditables (mínimo)

Rechazo 400: `operation=findByStatus`, `reason=invalid_status`, status
HTTP. Sin PII.

## Observability

Sin stack declarado en el repo. Vendor-neutral; tooling en
`open_questions`. Verificación MVP = tests de `scope.md`, no dashboards.

### Service

| Señal | Tipo | Uso |
|---|---|---|
| `pet_find_by_status_requests_total` | counter | labels: `status_code` |
| `pet_find_by_status_invalid_status_total` | counter | 400 por enum; incluye mixtas |

**Logs** (INFO en delegate al rechazar): `operation=findByStatus`,
`outcome=invalid_status`, `http_status=400`. No interpolar la lista
completa de pets. No loguear Authorization.

**Traces:** span del delegate si el runtime ya lo inyecta.
[ASSUMPTION: tracing no configurado — opcional en develop.]

**Data store / infra:** HashMap in-process; sin USE nuevo. Sin datos
durables nuevos → no RPO/RTO.

**SLO:** ninguno nuevo; este path no tiene SLO en el repo.

**Alertas:** no hay on-call ni runbook en este repo. No inventar umbrales
de página. Si más adelante hay tooling, `invalid_status_total` es la
serie; no es alerta de este ticket.

## Handoff documentation

### Archivos

| Archivo | Cambio |
|---|---|
| `src/main/resources/openapi.yaml` | 400 con schema JSON; description lista mixta |
| `PetApiDelegateImpl.java` | Trim; mensaje con enum; 400 si cualquier token falla |
| `ExceptionTranslator.java` | `@ExceptionHandler(ResponseStatusException)` → ErrorAttributes, sin stack |
| `pom.xml` | `spring-boot-starter-test` **sin versión** (BOM parent 2.0.2.RELEASE) |
| `src/test/java/.../PetFindByStatusValidationIT.java` (nuevo) | MockMvc |

**No tocar:** `ResourceServerConfiguration.java`, cliente móvil, otros
`/pet`, paginación.

### Secuencia

1. Test que falle o documente el status actual de `status=foo`.
2. Mensaje + trim + fail-fast en delegate.
3. Handler en `ExceptionTranslator`.
4. `openapi.yaml` + `mvn generate-sources`; conservar `List<String>`.
5. IT:

| Test | Métrica scope | AC |
|---|---|---|
| `status=available` → 200 array | válido sin regresión | #1 |
| `status=foo` → 400, message con los tres valores | inválido → 400 | #2 |
| `status=available,foo` → 400 | lista mixta | #3 |
| `openapi.yaml` 400 documentado | contrato | #4 |
| `status=available,pending` → 200 | guardrail | — |

Auth en tests: reutilizar el mecanismo que ya use el sample (oauth de
demo `user`/`user` en la descripción de OpenAPI) o `@AutoConfigureMockMvc`
con security test. [PENDING — missing: cómo está configurado el test de
OAuth en este repo — no hay tests hoy.] Develop elige MockMvc +
`@WithMockUser` / resource-server test; no hardcodear secretos.

### Estimación (engineering lead)

[PENDING — missing: t-shirt o rango. Borrador técnico no vinculante:
cambio S — ~4-5 archivos, sin migraciones.]

### Veredicto de viabilidad (engineering lead)

Cita, Juan Carlos Gamez Lozano, Jira comment 10106: «viable apruebo».
Veredicto: **viable**. Sin condiciones.

### Done (develop)

- Tres métricas de `scope.md` en CI.
- Cinco AC Given/When/Then cubiertos.
- 400 sin stack trace.
- 200 con enum válido sigue siendo `Pet[]`.
- `openapi.yaml` genera sin error.
