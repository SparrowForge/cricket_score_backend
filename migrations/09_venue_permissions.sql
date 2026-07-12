-- ============================================================
-- Migration 09: venue permissions
-- The original permission catalog had no `venue` resource, so venue
-- management was only gated by org membership. Add proper CRUD permissions
-- and grant them to the system roles so venue edit/delete can be
-- permission-checked like teams, tournaments and players.
-- ============================================================

INSERT INTO permissions (resource, action, description) VALUES
  ('venue', 'create', 'Create venues'),
  ('venue', 'read',   'View venues'),
  ('venue', 'update', 'Edit venues'),
  ('venue', 'delete', 'Delete venues')
ON CONFLICT (resource, action) DO NOTHING;

-- Super Admin: every venue permission
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id FROM permissions WHERE resource = 'venue'
ON CONFLICT DO NOTHING;

-- Tournament Admin: full venue management
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM permissions WHERE resource = 'venue'
ON CONFLICT DO NOTHING;

-- Scorer / Commentator / Viewer: read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.organization_id IS NULL AND r.slug IN ('scorer', 'commentator', 'viewer')
  AND p.resource = 'venue' AND p.action = 'read'
ON CONFLICT DO NOTHING;
