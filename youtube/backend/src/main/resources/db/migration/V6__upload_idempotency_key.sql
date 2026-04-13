ALTER TABLE videos ADD COLUMN upload_idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX idx_videos_uploader_upload_idempotency
    ON videos (uploader_id, upload_idempotency_key)
    WHERE upload_idempotency_key IS NOT NULL;
