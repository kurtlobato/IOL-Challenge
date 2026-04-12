# IOL-Challenge — video (iteración 1)

Plataforma mínima de subida y reproducción en HLS: API Java (Spring Boot), almacenamiento tipo S3 (MinIO), metadatos en PostgreSQL, frontend Vite + React + TypeScript.

**Código y `docker-compose` de la app:** carpeta [`youtube/`](youtube/) (ahí viven `backend/`, `frontend/` y [`youtube/docker-compose.yml`](youtube/docker-compose.yml)).

## Requisitos

- Java 21, Maven 3.9+
- Node.js 20+ y npm
- FFmpeg en el `PATH` (el backend invoca `ffmpeg` para transcodificar)
- Docker (PostgreSQL, MinIO y opcionalmente la app completa vía `docker compose`)

Si no tenés Java/Maven/Node en el sistema (o `sudo` no está disponible sin contraseña), podés usar **SDKMAN** (`sdk install java 21.0.10-tem`, `sdk install maven 3.9.9`) y **nvm** (`nvm install --lts`). En cada terminal nueva: `source ~/.sdkman/bin/sdkman-init.sh` y `source ~/.nvm/nvm.sh`.

## Arranque con Docker (API + web + datos)

Construye y levanta PostgreSQL, MinIO, backend (con FFmpeg en la imagen) y nginx con el frontend:

```bash
cd youtube
docker compose up --build
```

- API: `http://localhost:8080` (también alcanzable vía `http://localhost:8088/api/` a través del front).
- UI: `http://localhost:8088` (nginx proxifica `/api` al backend y `/storage` a MinIO).
- PostgreSQL: `localhost:5432`, base `videodb`, usuario `iol` / contraseña `iol`.
- MinIO: API `http://127.0.0.1:9000`, consola `http://127.0.0.1:9001`, credenciales `minioadmin` / `minioadmin`.

`APP_PLAYBACK_BASE_URL` en compose apunta a `http://localhost:8088/storage` para que las URLs HLS del API coincidan con el proxy del contenedor `web`. Si cambiás el puerto publicado del servicio `web`, actualizá esa variable en [`youtube/docker-compose.yml`](youtube/docker-compose.yml).

## Arranque solo infraestructura (desarrollo local)

```bash
cd youtube
docker compose up -d postgres minio
```

Luego backend y frontend en la máquina host como abajo.

## Backend

```bash
cd youtube/backend
mvn spring-boot:run
```

API en `http://localhost:8080`. Ajustá `app.playback-base-url` en [`youtube/backend/src/main/resources/application.yml`](youtube/backend/src/main/resources/application.yml) si el front corre en otro origen (p. ej. Vite en `5173`).

### Observabilidad y operación

- **Health (incluye MinIO y JDBC):** `GET http://localhost:8080/actuator/health`
- **Prometheus:** `GET http://localhost:8080/actuator/prometheus`  
- **Info:** `GET http://localhost:8080/actuator/info`
- **Logging:** niveles en `application.yml`; pool JDBC (Hikari) y timeouts HTTP de MinIO configurables ahí.
- **Resilience4j:** circuit breaker + time limiter sobre llamadas MinIO (`ObjectStorageService`); umbrales en `resilience4j.*` en `application.yml`.
- **FFmpeg:** timeouts configurables con `app.transcode.ffmpeg-timeout-seconds` y `app.transcode.ffmpeg-thumbnail-timeout-seconds`.

Para desactivar el health dedicado de MinIO (p. ej. en tests): `management.health.minio.enabled=false`.

## Frontend

```bash
cd youtube/frontend
npm install
npm run dev
```

Vite proxifica `/api` al backend y `/storage` a MinIO para evitar problemas de CORS al reproducir HLS durante el desarrollo.

## Flujo

1. `POST /api/videos` — devuelve `uploadUrl` (pre-signed PUT) y `id`.
2. El cliente sube el archivo con `PUT` a `uploadUrl`.
3. `POST /api/videos/{id}/complete` — confirma la subida y encola transcodificación.
4. Un worker programado toma videos en estado `UPLOADED`, genera HLS con FFmpeg y pasa a `READY`.
5. `GET /api/videos/{id}` — incluye `manifestUrl` cuando está `READY`.

## Tests

```bash
cd youtube/backend
mvn test
```

El test `ActuatorHealthIntegrationTest` usa Testcontainers (PostgreSQL + MinIO) y se **omite** si Docker no está disponible (`disabledWithoutDocker = true`).

## Notas

- Tamaño máximo de subida configurable: `app.max-upload-bytes` (por defecto 1 GB).
- La política de lectura pública en MinIO para `transcoded/*` se aplica al iniciar el backend; si falla, revisá la consola de MinIO y los permisos del bucket `videos`.
- **Reproducción**: el estado pasa a `READY` cuando **termina** el FFmpeg y se suben **todos** los fragmentos a MinIO. No es “play al primer segmento” en tiempo real: para eso haría falta HLS en modo live / publicación incremental, que este MVP no implementa.
