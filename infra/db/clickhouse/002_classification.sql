-- EMS-COP ClickHouse Schema
-- Migration 002: Data Classification columns on audit tables
-- Depends on: init.sql (ems_audit database, events table, c2_telemetry table)
--
-- Adds a classification column to audit event and C2 telemetry tables so that
-- every recorded event carries the classification level of the data it pertains to.
-- This enables enclave-aware audit queries and ensures classification metadata
-- is preserved in the append-only audit trail.
--
-- Valid values: 'UNCLASS', 'CUI', 'SECRET' (enforced at application layer;
-- ClickHouse uses String type — no CHECK constraints in MergeTree).

ALTER TABLE ems_audit.events ADD COLUMN IF NOT EXISTS classification String DEFAULT 'UNCLASS';

ALTER TABLE ems_audit.c2_telemetry ADD COLUMN IF NOT EXISTS classification String DEFAULT 'UNCLASS';
