-- Migration 013: Add CVSS score to alerts
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS cvss_score NUMERIC(3,1);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS cvss_vector TEXT;

-- Index for CVSS-based queries
CREATE INDEX IF NOT EXISTS idx_alerts_cvss_score ON alerts(cvss_score DESC);

-- Add comment explaining CVSS severity mapping
COMMENT ON COLUMN alerts.cvss_score IS 'CVSS v3.1 base score (0.0-10.0). Severity derived: Critical>=9.0, High>=7.0, Medium>=4.0, Low>=0.1, Info=0/null';
COMMENT ON COLUMN alerts.cvss_vector IS 'CVSS v3.1 vector string, e.g. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
