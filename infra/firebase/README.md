# Backend preparado, sin activar

El Dashboard conserva su alojamiento existente. Firebase/Google Cloud es el destino previsto para la persistencia; la interfaz del IDE y el consumidor usan el contrato HTTP portable ac.dashboard.v1, sin depender del hostname del proveedor. Chipre es un piloto opcional y no un requisito para conectar la interfaz.

El manifiesto adjunto es **configuración de preparación**, no un despliegue ni un archivo que el IDE ejecute automáticamente. Está apagado, no contiene identificadores privados ni credenciales y no habilita APIs, billing, IAM, servicios o bases de datos. El estado de ejecución real continúa preparado/no conectado.

La consulta de solo lectura al proyecto elegido devolvió 403 SERVICE_DISABLED para Firestore. No se habilitó la API. No se pudo identificar una instancia ni su edición, requisito previo a elegir el modelo/SDK de persistencia. Por ello **el adaptador Firestore no está implementado ni validado**; el receptor filesystem es una referencia local durable y no debe trasladarse a un filesystem efímero de Cloud Run para simular persistencia.

Después de aprobar billing/IAM y habilitar la API por la vía acordada con infraestructura:

1. Identificar las instancias, su edición y ubicación. Usar la instancia elegida expresamente; no crear otra por defecto ni modificar la base de datos de licencias u otras apps.
2. Implementar el adaptador transaccional en esa instancia conservando el mismo protocolo: commit durable antes del ack, recibo idempotente, proyección y cursor coherentes, rechazo de conflictos y ámbito de organización/proyecto. Probar con el emulador/fixture correspondiente a esa edición antes de desplegar.
3. Resolver la autenticación cloud. Las credenciales events:write y projection:read del protocolo no son por sí solas permisos IAM de invocación. Un servicio privado de Cloud Run necesita una identidad/broker autorizado adicional; no se añadirá allUsers para hacer desaparecer un 403. La elección de IAM y emisión/rotación de credenciales requieren aprobación concreta.
4. Revisar cuotas, costes y límites. El envío ocurre por cambios del proyecto, no por un heartbeat continuo. Un estado de presupuesto desconocido no equivale a cero ni a permiso para gastar. No se activa una ejecución de modelos o un worker permanente como parte de recibir estados.
5. Montar el consumidor de lectura en el Dashboard existente, con la credencial lectora en su backend. Configurar el origen HTTPS aprobado en el IDE, activar solo el proyecto aprobado y comprobar en pantalla una proyección leída después de persistir, incluyendo desconexión, ack perdido y recuperación. Solo entonces afirmar conexión productiva.

Las piezas reutilizables están en apps/desktop/src/main/dashboard-sync.ts, shared/dashboard-protocol.ts y examples/dashboard-consumer/Projection.tsx. Los comandos, contratos y límites se detallan en [dashboard-sync.md](../../docs/dashboard-sync.md). La fixture visual prueba el recorrido real local con tareas sintéticas; no es una conexión con Firebase ni con el Dashboard productivo.
