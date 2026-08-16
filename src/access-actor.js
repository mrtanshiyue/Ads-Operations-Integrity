function actorColumns() {
  return 'user_id, cf_access_sub, email, email_norm, display_name, status';
}

export async function enforceStrictAccessActorBinding(db, access) {
  if (!db) {
    return { ok: false, status: 503, error: 'control_db_not_bound' };
  }
  if (!access?.authenticated || !access.identity) {
    return {
      ok: false,
      status: 401,
      error: 'access_denied',
      reason: access?.error || 'unauthenticated',
    };
  }

  const sub = String(access.identity.sub || '').trim();
  const emailNorm = String(access.identity.email || '').trim().toLowerCase();
  if (!sub) {
    return {
      ok: false,
      status: 401,
      error: 'access_denied',
      reason: 'subject_missing',
    };
  }

  const bound = await db.prepare(`
    SELECT ${actorColumns()}
    FROM users
    WHERE status = 'active'
      AND cf_access_sub = ?1
    LIMIT 1
  `).bind(sub).first();

  if (bound) {
    return { ok: true, actor: bound, newlyBound: false };
  }

  if (!emailNorm) {
    return { ok: false, status: 403, error: 'app_user_not_provisioned' };
  }

  const candidate = await db.prepare(`
    SELECT ${actorColumns()}
    FROM users
    WHERE status = 'active'
      AND email_norm = ?1
    LIMIT 1
  `).bind(emailNorm).first();

  if (!candidate) {
    return { ok: false, status: 403, error: 'app_user_not_provisioned' };
  }

  const existingSub = String(candidate.cf_access_sub || '').trim();
  if (existingSub && existingSub !== sub) {
    return {
      ok: false,
      status: 403,
      error: 'access_subject_mismatch',
    };
  }

  if (!existingSub) {
    await db.prepare(`
      UPDATE users
      SET cf_access_sub = ?1, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?2 AND cf_access_sub IS NULL
    `).bind(sub, candidate.user_id).run();
  }

  const verified = await db.prepare(`
    SELECT ${actorColumns()}
    FROM users
    WHERE status = 'active'
      AND user_id = ?1
      AND cf_access_sub = ?2
    LIMIT 1
  `).bind(candidate.user_id, sub).first();

  if (!verified) {
    return {
      ok: false,
      status: 403,
      error: 'access_subject_binding_conflict',
    };
  }

  return {
    ok: true,
    actor: verified,
    newlyBound: !existingSub,
  };
}
