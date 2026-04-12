ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS processing_lease_until TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS shedlock (
    name VARCHAR(64) NOT NULL,
    lock_until TIMESTAMP(3) NOT NULL,
    locked_at TIMESTAMP(3) NOT NULL,
    locked_by VARCHAR(255) NOT NULL,
    PRIMARY KEY (name)
);
