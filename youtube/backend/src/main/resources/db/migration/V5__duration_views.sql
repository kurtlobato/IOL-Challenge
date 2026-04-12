ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION;

ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS video_views (
    video_id UUID NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    viewer_key VARCHAR(128) NOT NULL,
    PRIMARY KEY (video_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS idx_video_views_video_id ON video_views (video_id);
