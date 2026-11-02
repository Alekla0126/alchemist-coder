# Organización TAC portable — primer incremento

El coordinador sigue siendo el del IDE. El chat de Organización, `create_bot`, los líderes y los agentes ejecutan con `BotManager → RunnerManager → packages/harness`. La cola añade persistencia y recursos alrededor de ese mismo flujo; no crea una compañía alternativa en el chat.

```text
Encargo + proyecto + motor/permisos guardados + presupuesto
    → coordinador existente y chat de Organización
    → plan (revisión o política de Autopilot vigente)
    → create_bot con perfiles del proyecto / líderes → subagentes
    → cola local persistente → RunnerManager → Codex u otro motor
    → resultados/checkpoints/estados → coordinador revisa → finish_team
    → snapshot y outbox ac.integration.v1 → futuro relay → Dashboard
```

## Configuración reproducible

1. Copia `templates/tac/.alchemist/` dentro de la carpeta del proyecto, conservando la ruta `.alchemist/organization/manifest.json` y `roles/*.md`. Son 17 MD cortos: coordinador y 16 roles de la plantilla. Esto no significa que los 17 estén ejecutándose.
2. Abre la carpeta con **Abrir carpeta** en el IDE. Ese flujo la registra en el índice de proyectos; no edites la base de datos. El proyecto del Dashboard será una carpeta/repositorio independiente cuando se confirme su nombre y ruta; no debe confundirse con otros dashboards existentes.
3. En **Ejecución persistente y recursos → Vincular roles TAC existentes**, revisa nombre, ID y estado de cada perfil. Solo vincula perfiles ya existentes: no crea agentes ni cambia motores, permisos, equipos o el coordinador. Si falta un perfil o el nombre es ambiguo, añade su `configId` al rol del manifiesto y revisa de nuevo. No se aplica una plantilla con roles sin resolver. Selecciona modelos disponibles y permisos por separado en la configuración de cada agente; la vinculación no convierte Claude en Codex ni autoriza acciones.
4. Activa la cola para ese encargo, elige concurrencia/intentos y el presupuesto existente. La reanudación automática está desactivada por defecto y, si la autorizas, abarca solo trabajos en cola que no llegaron a empezar. Es independiente del interruptor global de Autopilot.
5. Escribe al coordinador desde el chat del IDE. Codex funciona para coordinador y subagentes con el catálogo real, esfuerzo compatible y permisos guardados. Los demás motores se conservan; no hay cambio silencioso a otro proveedor.

El coordinador recibe su MD y cada subagente el suyo, al iniciar su conversación. Los archivos están limitados a 16 KB y se incluyen hasta 6.000 caracteres por rol. Se rechazan rutas fuera del proyecto y symlinks externos. El contexto adicional se recupera por tarea; no se cargan todos los roles ni la memoria privada de esta asistencia. Las lecciones existentes del IDE siguen su selección actual.

### Reutilizar una organización existente

Un rol puede declarar un ID local explícito: `{"id":"writer","name":"Redacción","configId":"cfg-existing","role":"Redactar borradores","permissionMode":"plan"}`. El `configId` se toma de la vista previa/configuración del IDE y debe existir y pertenecer al proyecto. No publiques IDs/rutas privadas en la plantilla genérica. Sin ID explícito, se usa una vinculación ya aprobada, el coordinador existente o una coincidencia única por `contextRole`/nombre dentro del ámbito; un perfil del proyecto exacto tiene prioridad sobre uno global. Los homónimos de otro proyecto no se seleccionan. Un perfil no puede representar dos roles del mismo proyecto.

Los enlaces se guardan por proyecto en el archivo privado `org-bindings.json`, con escritura atómica, revisión de concurrencia y hasta 30 cambios de reversión. No se escribe `contextRole` sobre un perfil global: su MD se añade solo en el proyecto vinculado, incluso si trabaja en una copia propia. Los demás proyectos conservan el contexto anterior. Volver a vincular es idempotente; una plantilla más pequeña no elimina vínculos anteriores. La aplicación se bloquea durante trabajo activo, planes pendientes o jobs sin resolver y exige repetir la vista previa si cambian perfiles, manifiesto o MD.

**Revertir vínculos de contexto** restaura la vinculación anterior del proyecto, conserva otros proyectos y no modifica modelos ni permisos. Funciona aunque se haya retirado el manifiesto. Las conversaciones iniciadas antes conservan su contexto de sesión; vincular o revertir afecta conversaciones nuevas, no reescribe las existentes. Una cola o un archivo de vínculos ilegible bloquea la modificación; no se reinicia como vacío. Un lock dejado por un cierre inesperado exige revisar que no haya otro escritor antes de retirarlo manualmente.

Los exportadores antiguos que buscan «Coordinador» por nombre o escriben `opus`/`sonnet`/`haiku` sobre cualquier motor no son una migración Codex. No deben ejecutarse con `--aplicar` para convertir esta organización. Un cambio de modelo debe señalar IDs y proyectos exactos, conservar antes/después para revertir solo `agent` y detectar nuevas preferencias antes de aplicarse. La fuente canónica de departamentos de una empresa existente no se sustituye por los nombres de la plantilla genérica.

Los MD solo contienen instrucciones. Cuentas de marketing, activos y credenciales se identifican con referencias seguras resueltas por el host autorizado. No copies cookies, tokens, sesiones, claves de firma, datos financieros ni historiales privados al repositorio.

## Persistencia, límites y recuperación

- El archivo privado `org-queue.json` guarda jobs, checkpoints y eventos con escritura temporal, fsync y reemplazo atómico; la entrada del directorio también se sincroniza en POSIX. El equipo se guarda antes de despachar. No es una garantía de disponibilidad de una máquina ni de almacenamiento distribuido.
- Máximo 100 jobs sin resolver; hasta 8 slots globales, 1–8 por encargo, 1–5 intentos; se conservan hasta 600 registros de jobs (500 históricos más hasta 100 sin resolver) y los últimos 1.000 eventos. Una espera humana conserva su slot. La espera de coordinación lo cede a sus descendientes y debe readquirirlo antes de responder al modelo. Son límites de trabajos, no cuotas de CPU/RAM ni de herramientas del sistema operativo.
- Un fallo bloquea ese job y sus sucesores del mismo agente; otros independientes pueden avanzar. La cola no sustituye un ejecutor ausente por otro. `executor_unavailable` y `capacity_exhausted` son estados explícitos.
- Se recuperan trabajos pendientes preautorizados. Los que estaban ejecutándose se marcan interrumpidos y no repiten su prompt. Un checkpoint de sesión no prueba si una acción ya ocurrió: hay que revisar el resultado/conversación antes de dar una nueva instrucción. El botón de reanudar solo se ofrece cuando el servidor declara seguro hacerlo.
- Los reintentos automáticos requieren fallo clasificado explícitamente como seguro y preautorizado, respetan backoff y el límite de intentos. Un error genérico del modelo no cumple ese criterio. Cancelar o cerrar invalida preparaciones en vuelo.
- El presupuesto existente se aplica al coste que el proveedor informa. Coste/cuota ausentes siguen desconocidos; no es un límite de facturación exacto previo al consumo. Autopilot no desactiva sandbox, licencia ni autorizaciones exigidas.
- `completed` describe el fin observado del turno; `verification: reported` no certifica su trabajo. La prueba sintética verifica sus propios archivos por separado. La aplicación sigue necesitando evidencia y revisión de resultados.

## Dashboard, ejecutores y conversación

[Dashboard](https://dashboard.thealchemistcode.org/) es un proyecto separado. La versión inicial produce un snapshot/outbox seguro mediante `orgQueue()` en el preload del IDE; `resumeOrgJob()` y `cancelOrgJob()` pasan por IPC y las guardas del mismo motor. Estas son interfaces internas Electron, no una API pública de Internet. Los eventos exportables no contienen prompts, respuestas, rutas, sesiones, credenciales ni informes financieros. El contrato está en [org-events-v1.schema.json](contracts/org-events-v1.schema.json).

No hay todavía relay conectado, API HTTP externa, servidor MCP de control general ni ejecutor remoto. El MCP `alchemist_bots` existente usa un token privado por agente y un puerto loopback; controla descendientes de ese agente, no sirve como API pública de administración. Los flags `--team`/`--org-goal` están bajo el modo de captura/QA y no son una CLI de producción.

La siguiente integración conservará un único núcleo de Organización reutilizado por el IDE y un host sin interfaz, con cola/outbox duraderos, leases, deduplicación y cursor/snapshot del lado servidor. El Mac podrá ejecutar código, render/video y compilaciones según sus capacidades. SEO/monitorización solo irán a un host remoto aprobado y disponible. **El VPS actual de Komodo en Estonia está bloqueado por capacidad: no se despliega ni se ejecuta nada allí.** No se toca VPN, SSH, producción ni grants.

«Une tu Dot al Dashboard» requiere una conexión documentada y autorizada (por ejemplo un conector MCP con alcances explícitos de lectura y acciones). No existe aquí una API implícita de este dot ni se trasplanta su identidad/memoria. El coordinador puede tener un estilo conversacional semejante y recibir el brief que el usuario apruebe.

## Estado del incremento

Hay plantilla, selección de contexto por rol, cola integrada al motor existente, controles de UI, eventos seguros y pruebas con ejecutores simulados. No se ejecutó una inferencia real nueva, no se activó Autopilot, no se publicaron mensajes y no se desplegó nada. Los siguientes pasos son validar el relay con el responsable del Dashboard y aprobar recursos/host antes de habilitar ejecución remota. No se cambia la visibilidad de repositorios ni las guardas de licencia; el código del IDE conserva AGPL-3.0-only.
