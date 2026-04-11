package com.iol.video.repo;

import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

public interface VideoRepository extends JpaRepository<Video, UUID> {

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  Optional<Video> findFirstByStatusOrderByCreatedAtAsc(VideoStatus status);
}
