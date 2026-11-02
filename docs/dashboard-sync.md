# Coder → Dashboard: transporte local y contrato v1

El transporte de este incremento está implementado y probado con HTTP loopback. No hay un despliegue productivo ni una conexión verificada con el Dashboard alojado. El ejecutor VPS sigue sin implementarse: recibir estados no permite ejecutar tareas.

El único motor de Organización sigue siendo BotManager. DashboardSync lee una proyección del proyecto registrado: trabajos de OrgQueue y estados de agentes legados, incluidos los que no usan la cola durable. No crea agentes, no activa Autopilot y no repite tareas.

## Configuración del IDE

1. En Ajustes → Dashboard y VPS, guarda un origen HTTPS. HTTP solo se admite para loopback de desarrollo. La URL no lleva usuario, contraseña, query ni ruta.
2. Configura sincronización, selecciona el proyecto registrado y las referencias opacas de organización/proyecto acordadas con el receptor. No uses nombres privados como referencias.
3. Activa expresamente el envío de estado en segundo plano y guarda. Sin esa opción no se crea un outbox ni se realiza una solicitud.
4. Para un destino remoto hace falta una credencial existente events:write, limitada a esas dos referencias. El dueño la introduce en el campo de contraseña del IDE; se guarda mediante el almacén cifrado del sistema, separada del JSON de preferencias. No se devuelve al renderer ni al Dashboard. El IDE no emite credenciales ni amplía su alcance. Si el sistema no puede cifrarla, rechaza guardarla.
5. Reintentar sincronización comprueba el destino y procesa el mismo outbox. Guardar/reemplazar una credencial no equivale a conceder permiso para ejecutar agentes. Desarrollo loopback explícito puede usar un receptor sin credenciales, solo para fixtures locales.

El ámbito del outbox y de la credencial incluye origen, organización, proyecto y carpeta local. Cambiarlo crea un stream distinto y conserva el anterior sin enviarlo al nuevo destino. Desactivar interrumpe la solicitud en vuelo; una respuesta de la configuración anterior se ignora. Una solicitud ya aceptada por el servidor no puede deshacerse desde el cliente. Eliminar la credencial local no revoca por sí mismo la del emisor: debe revocarse allí también.

## Contrato para el responsable Dashboard

La fuente canónica es [dashboard-protocol.ts](../apps/desktop/src/shared/dashboard-protocol.ts), acompañada de [JSON Schema](contracts/dashboard-sync-v1.schema.json) y [ejemplo sintético](contracts/dashboard-sync-v1.example.json). Se usa **ac.dashboard.v1** para la envoltura HTTP. Los eventos de la cola interna conservan su contrato ac.integration.v1; el MCP interno no se expone.

    POST /api/coder-sync/v1/batches
    Authorization: Bearer <credencial events:write>
    Content-Type: application/json
    { message: <snapshot versionado>, digest: <sha256(JSON.stringify(message))> }

El receptor valida el esquema exacto, alcance, digest, stream y secuencia; persiste inbox, recibo y proyección antes de responder. El ack contiene únicamente version, orgRef, projectRef, streamId, sequence, messageId y digest. El cliente exige coincidencia de todos ellos. Una respuesta 200 o un booleano accepted no bastan.

    GET /api/coder-sync/v1/projects/<orgRef>/<projectRef>
    Authorization: Bearer <credencial projection:read>

El backend del Dashboard realiza ese GET y adapta streams[].data a sus tarjetas. La credencial lectora se mantiene en su backend, nunca en JavaScript del navegador. Una credencial escritora no puede leer y una lectora no puede ingerir. No existe una ruta para arrancar trabajos, publicar, cambiar permisos o controlar el IDE. El receptor rechaza solicitudes con Origin de navegador: este incremento requiere un backend/BFF autorizado.

Cada snapshot incluye estados y verificación de trabajos, estados de agentes legados y eventos observados. Los IDs se convierten en referencias SHA256 ligadas al stream; no salen IDs de sesión, nombres, rutas, prompts, respuestas, MD, cuenta/cuota ni informes financieros. El cursor global permanece local; los contadores públicos son propios del stream/proyecto. Cambios de otros proyectos no generan entregas. Un estado idle indica que terminó un turno; no acredita que la compañía alcanzó su objetivo. reported tampoco equivale a verificación independiente.

Una cola ilegible se representa como available:false, jobs:null y sourceSequence:null; nunca como cero trabajos. historyCoverage:partial declara que ningún snapshot acredita un historial completo: la proyección actual puede recuperarse, pero no se inventan eventos históricos que hayan salido de la retención local. El consumidor debe mostrar ese límite.

## Durabilidad y recuperación

- Outbox privado por ámbito, escritura temporal + fsync + rename, un solo escritor y recuperación de un lock cuyo proceso ya murió. Si el lock de recuperación es ilegible o sigue activo, se bloquea; no se roba.
- Se conservan hasta 100 batches y un máximo de 15 MB antes de añadir otro. La lectura admite 16 MB. Al alcanzar el límite se mantienen los pendientes y no se avanza el cursor de eventos que no se hayan persistido. Tras drenar, se captura el estado pendiente. No se bloquea el trabajo local de Organización.
- Un batch conserva messageId, secuencia y digest al reintentarse, incluso después de un reinicio. Un ack perdido puede volver a entregarse; el receptor devuelve el mismo recibo sin aplicar otra vez la proyección. Conflictos de contenido o secuencia devuelven 409 y requieren revisión.
- Hasta cinco intentos por entrega, backoff exponencial de 1 a 16 segundos, timeout de 10 segundos, ack limitado a 8 KiB y redirecciones prohibidas. Fallos de red, 429 y 5xx tienen reintentos acotados; autorización, protocolo y ack inválido requieren intervención explícita. Reiniciar no reinicia el presupuesto. Reintentar sí lo restablece, sin ejecutar trabajos.
- Abrir/reintentar obtiene un ack nuevo aunque el estado no haya cambiado. Solo un ack de la generación actual y de hace menos de un minuto muestra Sincronizado. El ack anterior queda como dato histórico. Quitar la credencial desconecta de inmediato.
- Un archivo corrupto o un fallo de persistencia no se sobrescribe ni se trata como outbox vacío. El retry explícito puede volver a adquirir/releerlo después de resolver un bloqueo. El receptor también valida sus proyecciones persistidas antes de publicarlas.

## Receptor de referencia y prueba reproducible

Construir en el equipo de desarrollo, no en el VPS limitado:

    node scripts/build-dashboard-receiver.mjs
    AC_DASHBOARD_LOCAL_DEVELOPMENT=1 node out/dashboard-receiver/examples/dashboard-receiver/serve.js /ruta/privada/inbox.json

El ejecutable de referencia escucha solo en 127.0.0.1:5182. El perfil CLI piloto limita un stream y cuerpos de 64 KiB, cuatro conexiones, 128 recibos por stream y tiempos de espera. El adaptador general admite hasta cuatro streams y cuerpos de 1 MB; no se presupone que ese perfil quepa en el VPS. El Dashboard conserva su alojamiento actual.

Para modo autenticado se usa AC_DASHBOARD_GRANTS_FILE, un JSON privado 0600 con objetos tokenHash, orgRef, projectRef, scope y expiresAt (epoch milisegundos). Solo se guarda el SHA256 del token. No se incluyen tokens reales ni un archivo de grants en el repositorio. Un grant vencido se rechaza. Un cuerpo superior al límite devuelve 413 sin guardar ni confirmar: requiere reducir el alcance o aprobar un perfil con recursos mayores; no se descartan datos silenciosamente.

Pruebas funcionales sin inferencia:

    pnpm exec vitest run apps/desktop/test/dashboard-sync.test.ts --maxWorkers=1
    node scripts/qa-dashboard-sync-server.mjs
    playwright-cli -s=alchemist-transport-qa open http://127.0.0.1:5181/dashboard-sync.html --headed
    playwright-cli -s=alchemist-transport-qa snapshot
    playwright-cli -s=alchemist-transport-qa run-code --filename scripts/check-dashboard-sync-settings.js
    playwright-cli -s=alchemist-transport-qa close

La fixture monta el componente real con backend en memoria y un proyecto sintético. Cubre consentimiento apagado por defecto, ámbito, campo secreto, ack, eliminación/reemplazo, fallos, conflicto y un Save retenido que cruza el polling. No conecta servicios externos ni arranca agentes. Cierra también el servidor de QA al terminar.

## Backend de producción y piloto opcional

El destino previsto es Firebase/Google Cloud para persistencia y el Dashboard conserva su alojamiento actual en Namecheap. El contrato HTTP es portable y el consumidor reutilizable está en examples/dashboard-consumer/Projection.tsx. La configuración [inactiva](../infra/firebase/README.md) no crea recursos ni representa una conexión. Firestore respondió SERVICE_DISABLED en una consulta de solo lectura: falta habilitar la API por la vía aprobada e identificar instancia/edición antes de implementar su adaptador. El filesystem local del receptor no se presentará como persistencia de un servicio serverless.

Infraestructura preparó por separado un piloto opcional de 30 minutos en Chipre, con datos ficticios y aprobación todavía pendiente. La revisión aislada del receptor llegó a unos 154 MiB RSS en Mac ARM; **64 MiB queda descartado** para ese perfil. La propuesta es 192 MiB/20%CPU, receptor privado 127.0.0.1:8788 y túnel SSH existente con forward local 18788, dos credenciales temporales y sin tocar 80/443/VPN. No son recursos garantizados en Linux y no se ha desplegado ni abierto ese túnel. El wrapper de infraestructura, con 1 MB/cuerpo y un stream, es distinto del CLI de desarrollo limitado a 64 KiB de este repositorio.

Los tres archivos del protocolo/receptor/almacenamiento coinciden con la copia congelada de infraestructura. El sender genera un streamId UUID durable: el wrapper del piloto debe fijarse a ese UUID de la fixture, no al literal de ejemplo mac-pilot-v1. Un UUID de stream no es una credencial. No modificar el sender para reutilizar identidades de otros ámbitos ni reiniciar su cursor.

La aprobación productiva debe fijar destino, región/instancia, billing e IAM, estrategia de invocación, emisión/revocación de credenciales y límites de coste. El acceso events:write no incluye execution:write, tiendas, redes sociales o cuentas personales. No se habilitarán APIs ni allUsers por detectar un 403. El Dashboard debe mantener la credencial lectora en su backend y adaptar la proyección antes de afirmar conexión live.

Antes de promover cualquier host: medir el proceso compilado con carga representativa, comprobar límites y reserva de recursos, persistencia/recibos, desconexión, reinicio y retorno a la versión previa. Conservar inbox/outbox y copias privadas; un restore atrasado requiere conciliar cursores. Los logs solo contienen códigos y contadores. Ninguna aprobación de transporte activa Autopilot, workers de modelos, WhatsApp, publicaciones o gastos.

## Prueba visual del recorrido completo

Después de construir el receptor, el servidor de QA monta también dashboard-projection.html. Su BFF de fixture usa lectura HTTP autenticada del inbox real; las credenciales ficticias no llegan al navegador. Los botones __proof solo existen en ese servidor local de pruebas y no en la API productiva. Dos tareas locales verifican A_OK/B_OK, una tercera queda bloqueada sin ejecutor; perder el ack y reiniciar sender/receptor mantiene dos ejecuciones, dos resultados verificados y el mismo recibo.

    node scripts/build-dashboard-receiver.mjs
    node scripts/qa-dashboard-sync-server.mjs
    playwright-cli -s=alchemist-transport-qa open http://127.0.0.1:5181/dashboard-projection.html --headed
    playwright-cli -s=alchemist-transport-qa snapshot
    playwright-cli -s=alchemist-transport-qa run-code --filename scripts/check-dashboard-projection.js

Cerrar la ventana y el servidor propios al terminar. Esta prueba no instala nada en el IDE abierto ni conecta la organización personal. La atribución real por departamento/cuenta y sus autorizaciones se describen en [department-automation-integration.md](department-automation-integration.md).
