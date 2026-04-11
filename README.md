# IOL-Challenge — video (iteración 1)

Plataforma mínima de subida y reproducción en HLS: API Java (Spring Boot), almacenamiento tipo S3 (MinIO), metadatos en PostgreSQL, frontend Vite + React + TypeScript.

## Requisitos

- Java 21, Maven 3.9+
- Node.js 20+ y npm
- FFmpeg en el `PATH` (el backend invoca `ffmpeg` para transcodificar)
- Docker (solo para PostgreSQL y MinIO vía `docker compose`)

Si no tenés Java/Maven/Node en el sistema (o `sudo` no está disponible sin contraseña), podés usar **SDKMAN** (`sdk install java 21.0.10-tem`, `sdk install maven 3.9.9`) y **nvm** (`nvm install --lts`). En cada terminal nueva: `source ~/.sdkman/bin/sdkman-init.sh` y `source ~/.nvm/nvm.sh`.

## Arranque de infraestructura

```bash
docker compose up -d
```

PostgreSQL: `localhost:5432`, base `videodb`, usuario `iol` / contraseña `iol`.  
MinIO: API `http://127.0.0.1:9000`, consola `http://127.0.0.1:9001`, credenciales `minioadmin` / `minioadmin`.

## Backend

```bash
cd backend
mvn spring-boot:run
```

API en `http://localhost:8080`. Perfiles por defecto en `application.yml` (ajustá `app.playback-base-url` si el front corre en otro puerto).

## Frontend

```bash
cd frontend
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
cd backend
mvn test
```

## Notas

- Tamaño máximo de subida configurable: `app.max-upload-bytes` (por defecto 1 GB).
- La política de lectura pública en MinIO para `transcoded/*` se aplica al iniciar el backend; si falla, revisá la consola de MinIO y los permisos del bucket `videos`.
- **Reproducción**: el estado pasa a `READY` cuando **termina** el FFmpeg y se suben **todos** los fragmentos a MinIO. No es “play al primer segmento” en tiempo real: para eso haría falta HLS en modo live / publicación incremental, que este MVP no implementa.
