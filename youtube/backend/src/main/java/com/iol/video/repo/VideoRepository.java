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
}
