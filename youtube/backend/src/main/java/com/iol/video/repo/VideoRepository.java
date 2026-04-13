package com.iol.video.repo;

import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/** Repositorio JPA con consultas pensadas para un solo consumidor por fila (claim de transcodificación). */
public interface VideoRepository extends JpaRepository<Video, UUID> {

  /** Primer video en el estado dado, bloqueado en escritura para actualizar sin carrera. */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  Optional<Video> findFirstByStatusOrderByCreatedAtAsc(VideoStatus status);

  /**
   * Videos en procesamiento cuyo lease expiró (o nunca se fijó): candidatos a ser retomados por
   * otro worker.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query(
      "SELECT v FROM Video v WHERE v.status = :status AND (v.processingLeaseUntil IS NULL OR v.processingLeaseUntil < :now) ORDER BY v.createdAt ASC")
  List<Video> findStaleProcessing(
      @Param("status") VideoStatus status, @Param("now") Instant now, Pageable pageable);

  /** Vídeos en CREATED creados estrictamente antes del instante dado (p. ej. limpieza por abandono). */
  List<Video> findByStatusAndCreatedAtBefore(VideoStatus status, Instant createdAtBefore);

  Optional<Video> findByUploaderIdAndUploadIdempotencyKey(String uploaderId, String uploadIdempotencyKey);

  /** Listado público: solo listos para reproducir, más recientes primero. */
  List<Video> findByStatusOrderByCreatedAtDesc(VideoStatus status);

  /**
   * Inserta par (video, viewer) si no existía y, solo en ese caso, incrementa {@code view_count}.
   * Limpia el contexto de persistencia para que un {@code findById} posterior vea el contador
   * actualizado.
   */
  @Modifying(clearAutomatically = true, flushAutomatically = true)
  @Query(
      value =
          """
          WITH ins AS (
            INSERT INTO video_views (video_id, viewer_key) VALUES (:videoId, :viewerKey)
            ON CONFLICT DO NOTHING RETURNING video_id
          )
          UPDATE videos v SET view_count = view_count + 1
          WHERE v.id = :videoId AND EXISTS (SELECT 1 FROM ins)
          """,
      nativeQuery = true)
  int registerUniqueView(@Param("videoId") UUID videoId, @Param("viewerKey") String viewerKey);
}
