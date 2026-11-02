# Codex en Organización

En **Organización → Configuración → un agente**, elige Codex, el proveedor de tu cuenta, el modelo, el esfuerzo de razonamiento y los permisos. Guarda antes de escribir una tarea en el cuadro de esa misma página. Cada agente conserva su propia selección; las tareas nuevas y sus agentes hijos configurados reciben esa selección. Cambiar el perfil no cambia tareas que ya están ejecutándose.

En **Escribe a tu organización → Nuevo encargo**, se muestra el motor real del coordinador. **Elegir otro motor para el coordinador** permite usar Codex para ese encargo nuevo sin modificar el CEO guardado. El modelo y el esfuerzo elegidos se conservan con el borrador al cambiar de vista o destinatario; un error de envío conserva ambos para reintentar. Los colaboradores mantienen sus propios motores y el coordinador mantiene sus permisos. Las conversaciones existentes continúan con su motor original. Si el CEO usa Claude y alcanza su límite de gasto, seleccionar Codex en otro perfil no cambia ese encargo ni su conversación.

**Actualizar modelos** consulta el App Server del Codex instalado. El catálogo y los esfuerzos vienen del runtime; no se deducen del nombre del modelo. Que un modelo aparezca no garantiza que tu cuenta pueda usarlo: la ejecución debe confirmarlo. Si el adaptador no puede aplicar el modelo, esfuerzo o permisos solicitados, detiene la tarea antes de enviar el prompt. No sustituye otro modelo ni proveedor.

Al cambiar de modelo, el selector usa el esfuerzo predeterminado que ese modelo anuncia. También puedes elegir un esfuerzo explícito. **Heredar configuración del runtime** conserva la configuración de Codex, incluido el esfuerzo de una conversación reanudada; no promete un esfuerzo concreto. Para controlar ese coste, guarda un esfuerzo explícito y da a cada tarea un contexto pequeño y específico. La cuota no es una estimación monetaria.

| Permisos | Alcance de Codex |
| --- | --- |
| Preguntar | Sandbox de solo lectura; las escalaciones necesitan autorización. |
| Aceptar ediciones | Escritura en el proyecto; se conservan las solicitudes y reglas de autorización. |
| Solo planear | Solo lectura y bloqueo de herramientas que cambien archivos. |
| Permitir todo | Desactiva el sandbox de Codex por selección explícita. |

Autopilot no cambia esta selección ni desactiva el sandbox. Sin el adaptador ACP, el modo headless conserva el sandbox seleccionado y rechaza escalaciones en lugar de solicitar una aprobación interactiva que no puede mostrar.

La cuenta y las ventanas de cuota se muestran cuando el runtime las informa. Una cuota ausente o una consulta de cuota que agota su tiempo queda **desconocida** y no borra un catálogo válido. La autenticación por API key no muestra la cuenta ChatGPT ambiental como si fuera la cuenta que paga esa ejecución. Los overrides de proveedor que no se pueden inspeccionar con seguridad quedan sin disponibilidad hasta corregirlos.

Los agentes reciben instrucciones de ejecutar las comprobaciones pertinentes, revisar sus resultados, corregir fallos e informar evidencia y bloqueos antes de terminar. Una respuesta completada del modelo no certifica por sí sola que el trabajo esté verificado.

La integración conserva las licencias y los proveedores existentes: no añade acceso cloud a una edición que no lo tenga. No importa la identidad, memoria ni conversaciones privadas de un coordinador externo.

Protocolo: [Codex App Server oficial](https://developers.openai.com/codex/app-server), mediante `model/list`, `account/read` y `account/rateLimits/read`; ejecución por el adaptador ACP existente.
