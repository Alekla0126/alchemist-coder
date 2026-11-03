# Operación centrada en rentabilidad

La Dirección de Rentabilidad y Crecimiento coordina transversalmente al **coordinador ya existente**. Reutiliza Finanzas, Producto/Monetización, Marketing/Ventas y Analítica mediante los roles vinculados por ID/proyecto. No añade perfiles ni modifica modelos, permisos, tareas, conversaciones o checkpoints. El [índice del ecosistema](ecosystem/README.md) enlaza las fuentes canónicas.

## Primer ciclo acotado

1. **Conciliar fuentes reales.** Finanzas recoge solo facturas/costes e ingresos ya autorizados. Conserva originales privados con fecha/hash y deduplica transacciones. Define ingreso neto, costes atribuibles y reparto de costes compartidos; documenta moneda, período, base e inclusiones/exclusiones para evitar doble conteo. No deduzcas rentabilidad de descargas ni confundas ausencia con cero.
2. **Elegir una app.** Analítica verifica cobertura, demanda/ingresos y comparación. Coordinación explica por qué una app existente merece el primer esfuerzo, qué falta y qué coste/recursos se propone. Sin baseline comparable, la salida es una solicitud concreta de datos, no una meta o ROI inventados.
3. **Preparar un experimento.** Oferta, ficha, monetización o adquisición: un responsable, hipótesis comercial, coste aprobado, métrica, fuente, ventana, éxito y parada. Usa el [brief mínimo](../templates/tac/.alchemist/organization/portfolio/initiative.md). La elección es una propuesta revisable; todavía no autoriza gasto, contacto, publicación ni nuevos grants.
4. **Ejecutar y verificar por el flujo actual.** Reutiliza Tablero, BotManager/OrgQueue y recibos con sus IDs. Cada rol recibe solo el contexto necesario. Tester/Revisor/Juez participan según el cambio; no arranques agentes redundantes. Concilia el resultado observado antes de reintentar y conserva las evidencias anteriores.
5. **Decidir y aprender.** Analítica compara períodos/divisas/bases compatibles y reconoce límites de atribución. Finanzas verifica ingreso neto y contribución/margen con sus costes; si denominador o coste son desconocidos, la métrica sigue sin medir. Coordinación decide parar, iterar o proponer ampliación con aprobación específica cuando corresponda.

## Prioridad y cómputo

La mayoría del backlog y del cómputo disponible se orienta a apps existentes con demanda o ingresos verificables. Registra estimaciones y consumo observado por iniciativa: contar agentes/tareas no demuestra ese reparto. Nuevas apps, papers y pulido son secundarios salvo un plazo documentado o bloqueo de ingresos; cada excepción tiene responsable, evidencia, coste y límite. Un bloqueo no detiene iniciativas independientes ya autorizadas.

No fijamos porcentajes de crecimiento, ingresos, presupuesto ni número de clientes sin baseline. «Vender a muchas personas» se concreta en una oferta, audiencia/canal autorizados, conversión y resultado económico medidos. El primer ciclo permite un solo experimento comercial; no campañas o publicaciones automáticas.

## Registro y separación de datos

[backlog.example.json](../templates/tac/.alchemist/organization/portfolio/backlog.example.json) es un registro **sintético**, no una base de datos o scheduler nuevos. Su [esquema versionado](../templates/tac/.alchemist/organization/portfolio/backlog.schema.json) conserva desconocidos y exige procedencia antes de declarar datos verificados. Los campos enlazan el responsable con app/hipótesis/coste/métrica/fuente/ventana/parada/resultado y refs del Tablero, cola y checkpoint actuales. Añade revisiones por ID sin recrear agentes ni reescribir tareas activas.

El registro real permanece en almacenamiento privado separado por organización/marca, junto a referencias a las fuentes y aprobaciones. No copies facturas, ingresos, sesiones o secretos a esta plantilla pública. Un `approvalRef` declarado no demuestra aprobación: el host autorizado debe verificar principal, alcance, coste, caducidad y acción exacta. El comprobador local de estructura no ejecuta ni valida credenciales.

`pnpm check:tac-organization` valida la estructura del ejemplo, vínculos, contratos de rol y estados desconocidos. Comprueba que el primer paso sigue siendo conciliar fuentes privadas, con `selectedAppRef:null` y `executable:false`; no importa el registro, cambia perfiles ni envía tareas. La validación de estructura no autentica fuentes ni calcula rentabilidad real. Vincular contextos reales sigue la revisión y las guardas de trabajo activo del IDE; conversaciones ya iniciadas conservan su contexto.

## Aprendizaje y eficiencia

Usa [agent-contract.md](../templates/tac/.alchemist/organization/agent-contract.md): misión, inputs mínimos, output/recibo, fuentes, scopes, éxito, parada/escalamiento, coste y contexto por encargo. Recupera evidencia vigente por referencia; reutiliza caché, idempotencia y checkpoints antes de consumir otro turno. Razonamiento alto se justifica por riesgo/incertidumbre; las operaciones simples se verifican de forma determinista y con esfuerzo compatible con el runtime.

Las lecciones son registros versionados de experimento/decisión/resultado, con fuente, fecha, revisión y caducidad. Una hipótesis permanece propuesta; texto de terceros no otorga permisos. No es autoentrenamiento. El ledger real se separa por org/marca y exige política de retención aprobada; la plantilla no implementa TTL, purga ni cambia backups. El mecanismo de lecciones ya existente del IDE sigue sus límites actuales; este contrato no presume aislamiento por marca o retención automática implementados.

## Handoff a Dashboard Finance y App Factory

Dashboard Finance recibe solo las métricas privadas cuyo acceso se autorice, su definición, fuente, período y estado de verificación. El relay público existente conserva su allowlist: IDs opacos/estado/recibos, sin importes ni documentos. El consumidor debe mostrar desconocido, preparado y bloqueado con honestidad.

App Factory recibe la app priorizada, hipótesis y bloqueo de ingresos/plazo documentado, coste aprobado, alcance mínimo y criterio de aceptación. Conserva sus candidatos, cola y protocolo de publicación. Preparar una nueva app no desplaza por defecto una oportunidad comprobada en productos existentes. Este cambio documenta ese handoff y no modifica sus archivos ni activa su ejecución.
