-- EMS-COP PostgreSQL Schema
-- Migration 002: Add paused/closed ticket statuses + trigram search index
-- Depends on: 001_core_schema.sql

-- ════════════════════════════════════════════
--  EXPAND TICKET STATUS STATES
-- ════════════════════════════════════════════
-- Original 8: draft, submitted, in_review, approved, rejected, in_progress, completed, cancelled
-- Adding: paused, closed (total: 10)

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
    CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected',
                      'in_progress', 'paused', 'completed', 'closed', 'cancelled'));

-- ════════════════════════════════════════════
--  TRIGRAM INDEX FOR FUZZY SEARCH
-- ════════════════════════════════════════════
-- pg_trgm extension already created in 001
-- This GIN index enables fast ILIKE / similarity() queries on title and description

CREATE INDEX IF NOT EXISTS idx_tickets_trgm
    ON tickets USING GIN ((title || ' ' || description) gin_trgm_ops);
