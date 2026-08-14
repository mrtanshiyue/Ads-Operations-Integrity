-- Ads Operations Integrity - Control D1
-- Migration 0002: explicit read permissions for centralized control-plane APIs.

INSERT OR IGNORE INTO role_permissions(role_key, permission_key) VALUES
  ('owner','products.read'),
  ('admin','products.read'),
  ('operator','products.read'),
  ('analyst','products.read'),
  ('viewer','products.read'),

  ('owner','keywords.read'),
  ('admin','keywords.read'),
  ('operator','keywords.read'),
  ('analyst','keywords.read'),
  ('viewer','keywords.read'),

  ('owner','negatives.read'),
  ('admin','negatives.read'),
  ('operator','negatives.read'),
  ('analyst','negatives.read'),
  ('viewer','negatives.read'),

  ('owner','negatives.manage'),
  ('admin','negatives.manage');

PRAGMA optimize;
