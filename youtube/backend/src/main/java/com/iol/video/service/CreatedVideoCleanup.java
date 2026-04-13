package com.iol.video.service;

import com.iol.video.domain.VideoStatus;
import com.iol.video.repo.VideoRepository;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Borra la fila de un video en CREATED en una transacción propia, para que el borrado confirme aunque
 * el flujo exterior haga rollback al propagar el fallo de almacenamiento.
 */
@Service
public class CreatedVideoCleanup {

  private final VideoRepository repo;

  public CreatedVideoCleanup(VideoRepository repo) {
    this.repo = repo;
  }

  @Transactional(propagation = Propagation.REQUIRES_NEW)
  public void deleteIfCreated(UUID id) {
    repo.findById(id)
        .filter(v -> v.getStatus() == VideoStatus.CREATED)
        .ifPresent(repo::delete);
  }
}
