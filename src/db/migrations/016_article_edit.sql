-- Who may add and change finished-goods articles (and their SKUs and barcodes): its own permission, separate from building BOMs.
-- The business owner may now edit articles and the brand, category and colour masters. For databases made before this change;
-- new ones get the same from the role catalogue in src/seed/rbac.ts.
INSERT INTO permission_def(key, area, label) VALUES ('article.edit', 'Finished goods', 'edit') ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permission(role_key, permission)
  SELECT r.key, p.perm FROM role r CROSS JOIN (VALUES ('article.edit')) AS p(perm) WHERE r.key IN ('MD', 'ENG', 'OWN')
  UNION ALL SELECT r.key, 'catalog.manage' FROM role r WHERE r.key = 'OWN'
  ON CONFLICT (role_key, permission) DO NOTHING;
