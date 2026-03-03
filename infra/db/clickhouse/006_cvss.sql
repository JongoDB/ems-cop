-- Add CVSS score columns to dco_alerts
ALTER TABLE ems_audit.dco_alerts ADD COLUMN IF NOT EXISTS cvss_score Float32 DEFAULT 0.0;
ALTER TABLE ems_audit.dco_alerts ADD COLUMN IF NOT EXISTS cvss_vector String DEFAULT '';
