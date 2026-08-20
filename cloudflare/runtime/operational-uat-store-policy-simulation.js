function rows(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

export async function simulateStoreAccessMismatchPolicy(db) {
  if (!db) {
    return Object.freeze({
      verified: false,
      reason: 'control_db_not_bound',
      policyProbe: 'production_control_db_read_only_policy_simulation',
      persistenceScope: 'none',
      persistentActorCreated: false,
    });
  }

  const [permissionResult, storeResult] = await Promise.all([
    db.prepare(`
      SELECT ar.role_key, ar.role_scope, ar.priority, rp.permission_key
      FROM app_roles ar
      JOIN role_permissions rp ON rp.role_key = ar.role_key
      WHERE rp.permission_key = 'ads.read'
      ORDER BY ar.priority ASC, ar.role_key ASC
    `).all(),
    db.prepare(`
      SELECT store_id, store_code
      FROM stores
      WHERE status <> 'disabled'
      ORDER BY sort_order ASC, store_code ASC, store_id ASC
      LIMIT 2
    `).all(),
  ]);

  const permissionRows = rows(permissionResult);
  const stores = rows(storeResult);
  const storeRole = permissionRows.find((item) => String(item?.role_scope || '') === 'store');
  if (!storeRole) {
    return Object.freeze({
      verified: false,
      reason: 'no_store_scoped_ads_read_role',
      policyProbe: 'production_control_db_read_only_policy_simulation',
      persistenceScope: 'none',
      persistentActorCreated: false,
    });
  }
  if (stores.length < 2) {
    return Object.freeze({
      verified: false,
      reason: 'fewer_than_two_non_disabled_stores',
      policyProbe: 'production_control_db_read_only_policy_simulation',
      persistenceScope: 'none',
      persistentActorCreated: false,
    });
  }

  const roleKey = String(storeRole.role_key || '').trim();
  const allowedStoreId = String(stores[0]?.store_id || '').trim();
  const deniedStoreId = String(stores[1]?.store_id || '').trim();
  const simulatedActor = Object.freeze({
    globalRoles: Object.freeze([]),
    storeRoles: Object.freeze({ [allowedStoreId]: roleKey }),
  });
  const canRead = (storeId) => {
    const globalAllowed = simulatedActor.globalRoles.some((assignedRole) => permissionRows.some((row) => (
      String(row?.role_scope || '') === 'global'
      && String(row?.role_key || '') === assignedRole
      && String(row?.permission_key || '') === 'ads.read'
    )));
    if (globalAllowed) return true;
    const assignedRole = simulatedActor.storeRoles[storeId];
    if (!assignedRole) return false;
    return permissionRows.some((row) => (
      String(row?.role_scope || '') === 'store'
      && String(row?.role_key || '') === assignedRole
      && String(row?.permission_key || '') === 'ads.read'
    ));
  };

  const allowed = canRead(allowedStoreId);
  const denied = canRead(deniedStoreId);
  const verified = roleKey.length > 0
    && allowedStoreId.length > 0
    && deniedStoreId.length > 0
    && allowedStoreId !== deniedStoreId
    && simulatedActor.globalRoles.length === 0
    && allowed === true
    && denied === false;

  return Object.freeze({
    verified,
    ...(verified ? {} : { reason: 'store_scope_policy_simulation_failed' }),
    simulatedRoleKey: roleKey,
    allowedStoreId,
    deniedStoreId,
    assignedGlobalRoleCount: simulatedActor.globalRoles.length,
    allowedStorePermission: allowed,
    deniedStorePermission: denied,
    policyProbe: 'production_control_db_read_only_policy_simulation',
    persistenceScope: 'none',
    persistentActorCreated: false,
    permissionMutationAttempted: false,
  });
}
