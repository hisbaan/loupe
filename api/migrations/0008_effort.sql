-- How hard each review worked (quick, standard or thorough) and which
-- repository files the model read, shown as provenance. Not part of the cache
-- key: regenerating at another effort replaces your review.
ALTER TABLE reviews ADD COLUMN effort TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE reviews ADD COLUMN files_read TEXT NOT NULL DEFAULT '[]';
ALTER TABLE self_reviews ADD COLUMN effort TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE self_reviews ADD COLUMN files_read TEXT NOT NULL DEFAULT '[]';
