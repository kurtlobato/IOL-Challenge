# IOL-Challenge — plataforma de video (iteración 1)

Stack mínimo para subida y reproducción HLS: API en Java (Spring Boot), objeto compatible S3 (MinIO), metadatos en PostgreSQL, SPA con Vite, React y TypeScript.

El código de la aplicación y el manifiesto de contenedores viven en [`youtube/`](youtube/) (`backend/`, `frontend/`, [`youtube/docker-compose.yml`](youtube/docker-compose.yml)).

---

## Entorno completo con Docker (recomendado)

**Requisitos:** Docker Engine con plugin Compose v2 (`docker compose`) y permiso para hablar con el daemon.

En Linux, si los comandos solo funcionan con `sudo`, el usuario habitual no pertenece al grupo `docker`. Para usar Docker sin `sudo` (recomendado en máquinas de desarrollo):

```bash
sudo usermod -aG docker "$USER"
```

Tras el cambio, cerrar sesión y volver a entrar (o reiniciar) para que aplique el nuevo grupo. Alternativa: ejecutar `docker compose` con `sudo` (menos cómodo; los artefactos en volúmenes montados pueden quedar con dueño root). El grupo `docker` otorga privilegios elevados sobre el host; conviene reservarlo a entornos de confianza. Otra opción es [Docker rootless](https://docs.docker.com/engine/security/rootless/).

Desde la **raíz del repositorio**, un solo comando construye las imágenes del backend y del frontend y levanta PostgreSQL, MinIO, API, nginx, Prometheus (scraping a `/actuator/prometheus` del servicio `api`) y Grafana con dashboards provisionados (JVM / Spring Boot, Micrometer):

```bash
docker compose -f youtube/docker-compose.yml up --build
```

- Añadir `-d` para ejecutar los servicios en segundo plano.
- La primera ejecución puede tardar por la descarga de imágenes base y la compilación Maven/npm.

**Reinicio y apagado** (desde la raíz del repositorio; anteponé `sudo` si tu usuario no está en el grupo `docker`):

```bash
docker compose -f youtube/docker-compose.yml restart
docker compose -f youtube/docker-compose.yml down
docker compose -f youtube/docker-compose.yml up -d
```

- `restart` vuelve a arrancar los contenedores sin borrarlos.
- `down` los detiene y elimina; los volúmenes nombrados (p. ej. datos de Postgres/MinIO) se conservan salvo que uses `down -v`.

**Endpoints útiles**

| Servicio    | URL / detalle |
|------------|----------------|
| Interfaz   | `http://localhost:8088` (nginx sirve el SPA y proxifica `/api` y `/storage`) |
| API (directo) | `http://localhost:8080` |
| PostgreSQL | `localhost:5432`, base `videodb`, usuario `iol`, contraseña `iol` |
| MinIO API  | `http://127.0.0.1:9000` |
| MinIO consola | `http://127.0.0.1:9001` — usuario y contraseña `minioadmin` |
| Prometheus | `http://localhost:9090` — config en [`youtube/prometheus/prometheus.yml`](youtube/prometheus/prometheus.yml) |
| Grafana | `http://localhost:3000` — usuario y contraseña `admin` / `admin` (solo desarrollo local); carpeta **IOL Video** con dashboards basados en [10280](https://grafana.com/grafana/dashboards/10280) y [14430](https://grafana.com/grafana/dashboards/14430), adaptados al datasource `prometheus` |

La variable `APP_PLAYBACK_BASE_URL` en [`youtube/docker-compose.yml`](youtube/docker-compose.yml) apunta a `http://localhost:8088/storage` para alinear las URLs HLS devueltas por la API con el proxy público del contenedor `web`. Si se publica el servicio `web` en otro host o puerto, debe actualizarse esa variable en consecuencia.

El API usa `MINIO_ENDPOINT` (p. ej. `http://minio:9000`) para hablar con MinIO desde el contenedor, y `MINIO_PUBLIC_ENDPOINT` (p. ej. `http://localhost:9000`) para las URLs presignadas que ejecuta el navegador. Sin esa separación, el host `minio` en la URL de subida no resuelve en el cliente (`ERR_NAME_NOT_RESOLVED`). Si la UI se abre desde otra máquina, `MINIO_PUBLIC_ENDPOINT` debe usar el host o IP alcanzable desde ese cliente y el puerto publicado de MinIO.

---

## Desarrollo local con infraestructura en contenedores

Solo Postgres y MinIO:

```bash
docker compose -f youtube/docker-compose.yml up -d postgres minio
```

A continuación, backend y frontend se ejecutan en el host (véanse las secciones siguientes).

---

## Requisitos para ejecución sin contenedores de aplicación

- **Backend:** Java 21, Maven 3.9+, FFmpeg disponible en `PATH` (el worker de transcodificación invoca `ffmpeg`).
- **Frontend:** Node.js 22 (alineado con la imagen de build en `youtube/frontend/Dockerfile`) y npm.
- **Datos:** instancias de PostgreSQL y MinIO accesibles según `application.yml` y variables de entorno.

Para entornos restringidos, herramientas como SDKMAN (JDK/Maven) o gestores de versiones de Node pueden instalarse según la política del equipo.

---

## Backend

```bash
cd youtube/backend
mvn spring-boot:run
```

La API escucha en `http://localhost:8080`. La propiedad `app.playback-base-url` en [`youtube/backend/src/main/resources/application.yml`](youtube/backend/src/main/resources/application.yml) debe coincidir con el origen desde el que el cliente resuelve el manifiesto HLS (por ejemplo, Vite en el puerto `5173` o nginx en `8088`).

### Observabilidad y operación

- **Health (JDBC + MinIO):** `GET http://localhost:8080/actuator/health`
- **Prometheus:** `GET http://localhost:8080/actuator/prometheus`
- **Info:** `GET http://localhost:8080/actuator/info`
- Niveles de log, pool JDBC (Hikari), timeouts hacia MinIO y umbrales de **Resilience4j** (circuit breaker y time limiter en `ObjectStorageService`) se configuran en `application.yml`.
- Timeouts de FFmpeg: `app.transcode.ffmpeg-timeout-seconds`, `app.transcode.ffmpeg-thumbnail-timeout-seconds`.

Para desactivar el health check específico de MinIO (p. ej. en tests): `management.health.minio.enabled=false`.

---

## Frontend

```bash
cd youtube/frontend
npm install
npm run dev
```

En desarrollo, Vite proxifica `/api` hacia el backend y `/storage` hacia MinIO para mantener mismo origen en HLS y evitar problemas de CORS.

---

## Flujo funcional resumido

1. `POST /api/videos` — respuesta con `uploadUrl` (PUT firmado) e `id`.
2. El cliente envía el archivo con `PUT` a `uploadUrl`.
3. `POST /api/videos/{id}/complete` — confirma la subida y deja el vídeo listo para el worker.
4. Un scheduler reclama vídeos en `UPLOADED`, ejecuta FFmpeg (HLS) y pasa el estado a `READY` o `FAILED`.
5. `GET /api/videos/{id}` — incluye `manifestUrl` cuando el estado es `READY`.

---

## Tests

```bash
cd youtube/backend
mvn test
```

`ActuatorHealthIntegrationTest` utiliza Testcontainers (PostgreSQL + MinIO) y se omite si Docker no está disponible (`disabledWithoutDocker = true`).

En el frontend:

```bash
cd youtube/frontend
npm test
```

---

## Notas de producto y limitaciones

- Tope de tamaño de subida: `app.max-upload-bytes` (por defecto 1 GB).
- La política de lectura pública en MinIO para el prefijo `transcoded/*` se aplica al arranque del backend; si falla, conviene revisar la consola de MinIO y los permisos del bucket `videos`.
- El estado `READY` indica que el pipeline de FFmpeg terminó y los artefactos están en almacenamiento; no se implementa HLS en modo live ni publicación incremental segmento a segmento.

---

## Documentación de arquitectura

Decisiones de diseño, alternativas consideradas y diagramas: [`youtube/DESIGN.md`](youtube/DESIGN.md).
