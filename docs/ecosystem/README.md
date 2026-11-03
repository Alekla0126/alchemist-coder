# Índice canónico del ecosistema TAC

La compañía es **The Alchemist Code**. **The Alchemist Coder** es el IDE; Dashboard es otro proyecto. La Dirección de Rentabilidad y Crecimiento es un mandato del coordinador existente, no otro organigrama, backend ni conjunto de agentes.

| Pieza | Fuente canónica | Estado y responsabilidad |
| --- | --- | --- |
| IDE / Organización | [Flujo y vínculos](../organization-portable.md), [plantilla TAC](../../templates/tac/.alchemist/organization/manifest.json) | Chat y motor existentes, perfiles/modelos/permisos guardados. Una plantilla no cambia sesiones ni activa agentes. |
| Cola y recuperación | [Ejecución local y límites](../org-mcp.md#execution-and-deployment-limits) | Checkpoints, idempotencia y recibos; efectos inciertos se concilian antes de reintentar. Adaptador local probado; remoto aún requiere implementación/autorización. |
| Dashboard | [Contrato de proyección](../dashboard-sync.md), [consumidor](../../examples/dashboard-consumer/Projection.tsx) | Observa estado real por BFF/proyección; un ack no prueba rentabilidad. El despliegue/conexión productivos se verifican en su propio repo. |
| MCP | [Guía y scopes](../org-mcp.md), [manifest](../org-mcp-manifest.v1.json) | Lectura stdio probada; comandos reservados deshabilitados. Construido no significa registrado en esta asistencia ni conectado a producción. |
| Backend | [Preparación Firebase/GCP](../../infra/firebase/README.md) | Configuración inactiva; recursos, billing/IAM, autenticación y persistencia transaccional siguen su autorización. Namecheap conserva el alojamiento web acordado. |
| Rentabilidad | [Guía operativa](../profitability-growth.md), [mandato](../../templates/tac/.alchemist/organization/mandates/profitability-growth.md) | Finanzas → priorizar una app → un experimento medible → resultado/revisión/decisión. |
| Agentes / aprendizaje | [Contrato mínimo](../../templates/tac/.alchemist/organization/agent-contract.md), [brief](../../templates/tac/.alchemist/organization/portfolio/initiative.md) | Contexto selectivo, coste por resultado útil y lecciones versionadas/revisadas; sin autoentrenamiento. |

No dupliques fuentes: tareas/estados pertenecen al motor del IDE; facturas y economía real al registro privado de Finanzas por org/marca; activos y producto a sus proyectos; Dashboard consume lo autorizado. Los ejemplos del repo son sintéticos. El contrato público `ac.dashboard.v1` no admite importes ni informes financieros: Dashboard Finance necesita su acceso privado aprobado, no añadir esos datos al relay público.

Para coordinar cambios entre repos, entrega referencias de iniciativa, app, job, checkpoint, revisión, fuente y recibo. Reutiliza los contratos existentes; acuerda extensiones versionadas antes de usarlas. Este incremento no edita Dashboard/App Factory, despliega servicios ni concede acceso.
