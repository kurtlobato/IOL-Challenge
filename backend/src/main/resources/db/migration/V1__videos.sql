CREATE TABLE videos (
    id UUID PRIMARY KEY,
    title VARCHAR(512) NOT NULL,
    original_filename VARCHAR(512) NOT NULL,
    content_type VARCHAR(256),
    size_bytes BIGINT,
    status VARCHAR(32) NOT NULL,
    original_object_key VARCHAR(1024) NOT NULL,
    output_prefix VARCHAR(1024),
    manifest_object_key VARCHAR(1024),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_videos_status_created ON videos (status, created_at);
