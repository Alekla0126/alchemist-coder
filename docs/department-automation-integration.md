# Departamentos y automatizaciones: continuidad del motor existente

El relay lee BotManager y OrgQueue del IDE. Las automatizaciones actuales ya crean sus equipos mediante AutomationManager → startSolo/BotManager y conservan TeamOrigin (automationId, runId y nodeId) dentro del IDE. No hay otro motor de trabajadores ni scripts de negocio paralelos en este incremento. Los scripts añadidos de QA y receptor de referencia prueban/adaptan el transporte; no reemplazan las automatizaciones de la compañía.

| Departamento | Entrada que se conserva | Salida para Dashboard | Autorizaciones que no se infieren |
|---|---|---|---|
| Marketing | Perfiles y pasos de automatización de redacción, redes y mensajería | Estado de tarea, verificación y recibo de integración; el contenido queda privado | Cuenta y marca exactas, audiencia personal/empresa, lectura o envío, aprobación de publicación y gasto |
| Monitor | Tareas existentes de salud de apps y sus ciclos autorizados | Estado disponible/desconocido, resultado verificado o bloqueo | Nuevas fuentes, scrapers, notificaciones o destinos externos |
| App Factory | Agentes existentes de programación, pruebas, revisión y compilación | Resultado de tarea, evidencia de verificación y bloqueo por capacidad/permiso | Publicación, firma, tienda, credenciales, máquina remota o costes nuevos |

La clasificación de departamentos debe vincularse por **ID existente + proyecto**, con referencias opacas de marca/cuenta y audiencia explícita; no por nombres homónimos. La proyección v1 transporta referencias opacas de tareas/equipos/agentes y estados, sin contenido, credenciales ni sesiones. La vinculación de esos IDs al registro de departamentos/cuentas del Dashboard queda pendiente de acordar con su productor; no se ha aplicado una clasificación nueva a la organización activa. No se interpretará un departamento sin vínculo como una cuenta conectada.

Cada cuenta conserva sus propias credenciales y permisos en su almacén autorizado. El token de ingestión de estados no sirve para enviar WhatsApp, publicar en redes, acceder a una cuenta personal o ejecutar código. Las aprobaciones de las herramientas siguen perteneciendo al ejecutor y al usuario; un recibo HTTP solo acredita almacenamiento de metadatos. Un resultado incierto permanece bloqueado para conciliación y no se repite como operación externa.

La prueba visual local usa etiquetas **ficticias** de Marketing, App Factory y Monitor: dos outputs simulados se escriben y verifican antes de marcarse verificados; Monitor queda bloqueado sin ejecutor. El consumidor lee el inbox mediante HTTP y sobrevive a un ack perdido y reinicio sin repetir esas tareas. Esto valida transporte, proyección y aislamiento; no acredita campañas, ingresos, cuentas conectadas, apps publicadas ni automatización de producción.
