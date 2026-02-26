-- EMS-COP PostgreSQL Migration 006
-- Seed default workflow transitions for "Standard Red Team Approval" workflow
-- These define the DAG edges: linear flow + kickback paths

WITH stages AS (
    SELECT ws.id, ws.name, ws.workflow_id
    FROM workflow_stages ws
    JOIN workflows w ON w.id = ws.workflow_id
    WHERE w.name = 'Standard Red Team Approval'
),
plan AS (SELECT id FROM stages WHERE name = 'Plan Drafting'),
e3   AS (SELECT id FROM stages WHERE name = 'E3 Review'),
e2   AS (SELECT id FROM stages WHERE name = 'E2 Review'),
e1   AS (SELECT id FROM stages WHERE name = 'E1 Review'),
exec AS (SELECT id FROM stages WHERE name = 'Execution'),
done AS (SELECT id FROM stages WHERE name = 'Completed'),
wf   AS (SELECT DISTINCT workflow_id AS id FROM stages)
INSERT INTO workflow_transitions (workflow_id, from_stage_id, to_stage_id, trigger, label)
SELECT wf.id, t.from_id, t.to_id, t.trigger, t.label
FROM wf, (
    SELECT plan.id AS from_id, e3.id AS to_id, 'on_complete' AS trigger, 'Submit for Review' AS label FROM plan, e3
    UNION ALL
    SELECT e3.id, e2.id, 'on_approve', 'E3 Approved' FROM e3, e2
    UNION ALL
    SELECT e3.id, plan.id, 'on_reject', 'Kickback to Planner' FROM e3, plan
    UNION ALL
    SELECT e2.id, e1.id, 'on_approve', 'E2 Approved' FROM e2, e1
    UNION ALL
    SELECT e2.id, e3.id, 'on_kickback', 'Kickback to E3' FROM e2, e3
    UNION ALL
    SELECT e1.id, exec.id, 'on_approve', 'E1 Approved' FROM e1, exec
    UNION ALL
    SELECT e1.id, e2.id, 'on_kickback', 'Kickback to E2' FROM e1, e2
    UNION ALL
    SELECT exec.id, done.id, 'on_complete', 'Mark Complete' FROM exec, done
) AS t
WHERE NOT EXISTS (
    SELECT 1 FROM workflow_transitions wt WHERE wt.workflow_id = wf.id
);
