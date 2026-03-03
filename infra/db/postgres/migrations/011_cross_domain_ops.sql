BEGIN;

-- Add routing mode to operations
ALTER TABLE operations ADD COLUMN IF NOT EXISTS routing_mode TEXT NOT NULL DEFAULT 'local' CHECK (routing_mode IN ('local', 'cross_domain'));
ALTER TABLE operations ADD COLUMN IF NOT EXISTS origin_operation_id UUID;  -- links to operation on other enclave
ALTER TABLE operations ADD COLUMN IF NOT EXISTS origin_enclave TEXT CHECK (origin_enclave IS NULL OR origin_enclave IN ('low', 'high'));

-- Cross-domain command queue
CREATE TABLE IF NOT EXISTS cross_domain_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL REFERENCES operations(id),
    command TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    risk_level INT NOT NULL DEFAULT 1,
    classification TEXT NOT NULL DEFAULT 'UNCLASS' CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'queued_cti', 'executing', 'completed', 'failed', 'rejected')),
    requested_by UUID,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    result JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xd_commands_operation ON cross_domain_commands(operation_id);
CREATE INDEX IF NOT EXISTS idx_xd_commands_status ON cross_domain_commands(status);

-- Use the existing update_updated_at function (created in 001_core_schema.sql)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_xd_commands_updated_at'
    ) THEN
        CREATE TRIGGER trg_xd_commands_updated_at
            BEFORE UPDATE ON cross_domain_commands
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END
$$;

COMMIT;
