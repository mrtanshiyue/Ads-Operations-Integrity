(function initCloudflareNativeAccessConsole(global) {
  'use strict';

  const VERSION = '1.2.0';
  const PAGE_LIMIT = 200;
  const state = {
    mounted: false,
    open: false,
    accessLoaded: false,
    canRead: false,
    canProvision: false,
    canWriteMembership: false,
    currentUserId: '',
    stores: [],
    storeId: '',
    roles: [],
    users: [],
    members: [],
    loading: false,
    requestSerial: 0,
  };

  function api() {
    if (!global.CloudflareNativeAPI) {
      const error = new Error('cloudflare_native_api_not_ready');
      error.code = 'cloudflare_native_api_not_ready';
      throw error;
    }
    return global.CloudflareNativeAPI;
  }

  function listRoles(params = {}) {
    return api().accessRoles({ scope: 'store', ...params });
  }

  function listUsers(params = {}) {
    return api().accessUsers({ limit: PAGE_LIMIT, ...params });
  }

  function createUser(email, displayName) {
    const body = { email: String(email || '').trim() };
    const normalizedDisplayName = String(displayName || '').trim();
    if (normalizedDisplayName) body.displayName = normalizedDisplayName;
    return api().createAccessUser(body);
  }

  function updateUserStatus(userId, status) {
    return api().updateAccessUserStatus(userId, status);
  }

  function listMembers(storeId, params = {}) {
    return api().storeMembers(storeId, { limit: PAGE_LIMIT, ...params });
  }

  function putMember(storeId, userId, roleKey) {
    return api().putStoreMember(storeId, userId, { roleKey });
  }

  function deleteMember(storeId, userId) {
    return api().deleteStoreMember(storeId, userId);
  }

  const publicApi = Object.freeze({
    version: VERSION,
    listRoles,
    listUsers,
    createUser,
    updateUserStatus,
    listMembers,
    putMember,
    deleteMember,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareAccessConsole', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  function mount() {
    if (state.mounted || !global.document?.body) return;
    const host = global.document.querySelector('.header .actions')
      || global.document.querySelector('.bidGovHeaderActions');
    if (!host) return;

    state.mounted = true;
    installStyles();

    const button = global.document.createElement('button');
    button.id = 'btnNativeAccessConsole';
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '成员权限';
    button.title = '预置用户、管理普通用户状态以及店铺成员与店铺级角色';
    button.style.display = 'none';
    button.addEventListener('click', open);
    host.appendChild(button);

    const modal = global.document.createElement('div');
    modal.id = 'nativeAccessConsoleModal';
    modal.className = 'modalOverlay cfAccessOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeAccessConsoleTitle');
    modal.innerHTML = `
      <div class="largeModal cfAccessModal">
        <div class="largeModalHeader cfAccessHeader">
          <div>
            <div class="cfAccessEyebrow">CLOUDFLARE NATIVE ACCESS GOVERNANCE</div>
            <h2 id="nativeAccessConsoleTitle">成员与店铺权限</h2>
            <div class="small">Phase B2：预置普通应用用户，管理普通用户 active / disabled 生命周期，并管理 store membership；不开放全局角色或用户删除。</div>
          </div>
          <div class="cfAccessHeaderActions">
            <span id="cfAccessMode" class="cfAccessBadge">权限检查中</span>
            <button id="btnCfAccessRefresh" class="btn" type="button">刷新</button>
            <button id="btnCfAccessClose" class="btn" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfAccessBody">
          <div class="cfAccessContext">
            <label>店铺<select id="cfAccessStore"></select></label>
            <div class="cfAccessStat"><strong id="cfAccessMemberCount">0</strong><span>当前成员</span></div>
            <div class="cfAccessStat"><strong id="cfAccessUserCount">0</strong><span>用户总数</span></div>
            <div class="cfAccessStat"><strong id="cfAccessRoleCount">0</strong><span>Store Roles</span></div>
          </div>

          <div class="cfAccessProvision" id="cfAccessProvisionPanel">
            <div class="cfAccessSectionTitle">预置用户</div>
            <label>Email<input id="cfAccessNewEmail" type="email" maxlength="320" autocomplete="off" placeholder="operator@example.com"/></label>
            <label>Display Name<input id="cfAccessNewDisplayName" type="text" maxlength="200" autocomplete="off" placeholder="Operator Name"/></label>
            <button id="btnCfAccessProvision" class="btn" type="button">创建 Active 用户</button>
            <div class="small cfAccessHint">创建后 <code>cf_access_sub</code> 保持未绑定，首次通过 Cloudflare Access 验证登录时再完成身份绑定。</div>
          </div>

          <div id="cfAccessStatus" class="cfAccessStatus" aria-live="polite"></div>

          <div class="cfAccessSectionBlock">
            <div class="cfAccessSectionHeading">
              <div><strong>用户目录与生命周期</strong><span>普通用户可停用或恢复；全局角色账号与当前账号受保护。</span></div>
            </div>
            <div class="table-container cfAccessUserTableWrap">
              <table class="cfAccessTable cfAccessUserTable">
                <thead><tr><th>Display Name</th><th>Email</th><th>Status</th><th>Cloudflare Access</th><th>Global Roles</th><th>Last Seen</th><th>操作</th></tr></thead>
                <tbody id="cfAccessUserRows"></tbody>
              </table>
            </div>
          </div>

          <div class="cfAccessAssign" id="cfAccessAssignPanel">
            <div class="cfAccessSectionTitle">店铺成员分配</div>
            <label>用户<select id="cfAccessUser"></select></label>
            <label>角色<select id="cfAccessRole"></select></label>
            <button id="btnCfAccessAssign" class="btn primary" type="button">分配 / 更新成员</button>
          </div>

          <div class="cfAccessSectionBlock">
            <div class="cfAccessSectionHeading">
              <div><strong>店铺成员与角色</strong><span>停用普通用户不会删除这里的 membership；恢复后原角色继续保留。</span></div>
            </div>
            <div class="table-container cfAccessTableWrap">
              <table class="cfAccessTable">
                <thead><tr><th>用户</th><th>Email</th><th>状态</th><th>店铺角色</th><th>最后访问</th><th>加入时间</th><th>操作</th></tr></thead>
                <tbody id="cfAccessRows"></tbody>
              </table>
            </div>
          </div>
          <div class="small cfAccessFoot">用户预置、目录读取与普通用户生命周期要求 global <code>users.manage</code>；店铺成员写入额外要求 global <code>stores.manage</code>。本控制台不修改全局角色，也不删除用户。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    global.document.querySelector('#btnCfAccessClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfAccessRefresh')?.addEventListener('click', refresh);
    global.document.querySelector('#cfAccessStore')?.addEventListener('change', async (event) => {
      state.storeId = String(event.target.value || '');
      await refreshMembers();
    });
    global.document.querySelector('#btnCfAccessProvision')?.addEventListener('click', provisionUserFromForm);
    global.document.querySelector('#btnCfAccessAssign')?.addEventListener('click', assignSelectedMember);
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });

    void probeAccess();
  }

  async function probeAccess() {
    try {
      const [storesPayload, capabilities, session] = await Promise.all([
        api().stores(),
        api().capabilities(),
        api().session(),
      ]);
      const globalPermissions = Array.isArray(capabilities?.globalPermissions)
        ? capabilities.globalPermissions
        : [];
      state.canRead = globalPermissions.includes('users.manage');
      state.canProvision = state.canRead;
      state.canWriteMembership = state.canRead && globalPermissions.includes('stores.manage');
      state.currentUserId = String(session?.user?.userId || '');
      state.stores = normalizeStores(storesPayload?.stores);
      if (!state.stores.some((store) => store.storeId === state.storeId)) {
        state.storeId = state.stores[0]?.storeId || '';
      }
      state.accessLoaded = true;

      const button = global.document.querySelector('#btnNativeAccessConsole');
      if (button) button.style.display = state.canRead ? '' : 'none';
      renderStores();
      renderMode();
    } catch {
      state.accessLoaded = true;
      state.canRead = false;
      state.canProvision = false;
      state.canWriteMembership = false;
      state.currentUserId = '';
      const button = global.document.querySelector('#btnNativeAccessConsole');
      if (button) button.style.display = 'none';
    }
  }

  async function open() {
    if (!state.mounted) mount();
    if (!state.accessLoaded) await probeAccess();
    if (!state.canRead) return;
    const modal = global.document?.querySelector('#nativeAccessConsoleModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    renderStores();
    renderMode();
    await hydrateCatalogs();
    await refreshMembers();
  }

  function close() {
    const modal = global.document?.querySelector('#nativeAccessConsoleModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function refresh() {
    if (!state.open) return;
    await hydrateCatalogs();
    await refreshMembers();
  }

  async function hydrateCatalogs() {
    setBusy(true, '正在加载用户与角色目录…');
    try {
      const [rolesPayload, usersPayload] = await Promise.all([
        listRoles(),
        listUsers(),
      ]);
      state.roles = (Array.isArray(rolesPayload?.roles) ? rolesPayload.roles : [])
        .filter((role) => role.roleScope === 'store');
      state.users = normalizeUsers(usersPayload?.items);
      renderRoles();
      renderUsers();
      renderUserDirectory();
      renderCounts();
      setStatus('用户与角色目录已加载', 'ok');
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function refreshUsersCatalog(selectUserId) {
    const usersPayload = await listUsers();
    state.users = normalizeUsers(usersPayload?.items);
    renderUsers();
    renderUserDirectory();
    if (selectUserId) {
      const select = global.document.querySelector('#cfAccessUser');
      const assignable = activeUsers(state.users);
      if (select && assignable.some((user) => user.userId === selectUserId)) select.value = selectUserId;
    }
    renderCounts();
  }

  async function refreshMembers() {
    if (!state.open) return;
    if (!state.storeId) {
      state.members = [];
      renderMembers();
      renderCounts();
      setStatus('没有可用店铺；仍可预置和管理用户', 'warn');
      return;
    }
    const serial = ++state.requestSerial;
    setBusy(true, '正在读取店铺成员…');
    try {
      const payload = await listMembers(state.storeId);
      if (serial !== state.requestSerial) return;
      state.members = Array.isArray(payload?.items) ? payload.items : [];
      renderMembers();
      renderCounts();
      setStatus(`已加载 ${state.members.length} 名成员`, 'ok');
    } catch (error) {
      if (serial !== state.requestSerial) return;
      state.members = [];
      renderMembers();
      renderCounts();
      setStatus(errorText(error), 'bad');
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  async function provisionUserFromForm() {
    if (!state.canProvision || state.loading) return;
    const emailInput = global.document.querySelector('#cfAccessNewEmail');
    const displayInput = global.document.querySelector('#cfAccessNewDisplayName');
    const email = String(emailInput?.value || '').trim();
    const displayName = String(displayInput?.value || '').trim();
    if (!email) {
      setStatus('请输入用户 Email', 'warn');
      emailInput?.focus();
      return;
    }

    setBusy(true, '正在预置用户…');
    try {
      const payload = await createUser(email, displayName);
      const createdUserId = payload?.user?.userId || '';
      if (emailInput) emailInput.value = '';
      if (displayInput) displayInput.value = '';
      await refreshUsersCatalog(createdUserId);
      setStatus(`用户已预置${payload?.user?.email ? ` · ${payload.user.email}` : ''}；尚未绑定 Cloudflare Access subject`, 'ok');
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function assignSelectedMember() {
    if (!state.canWriteMembership || state.loading) return;
    const userId = String(global.document.querySelector('#cfAccessUser')?.value || '');
    const roleKey = String(global.document.querySelector('#cfAccessRole')?.value || '');
    if (!state.storeId || !userId || !roleKey) {
      setStatus('请选择店铺、用户和角色', 'warn');
      return;
    }
    setBusy(true, '正在保存成员角色…');
    try {
      await putMember(state.storeId, userId, roleKey);
      setStatus('成员角色已保存', 'ok');
      await refreshMembers();
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  function renderStores() {
    const select = global.document.querySelector('#cfAccessStore');
    if (!select) return;
    select.replaceChildren();
    if (!state.stores.length) {
      const option = global.document.createElement('option');
      option.value = '';
      option.textContent = '无可用店铺';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const store of state.stores) {
      const option = global.document.createElement('option');
      option.value = store.storeId;
      option.textContent = [store.displayName || store.storeCode || store.storeId, store.marketplaceCode].filter(Boolean).join(' · ');
      select.appendChild(option);
    }
    select.value = state.storeId;
  }

  function renderUsers() {
    const select = global.document.querySelector('#cfAccessUser');
    if (!select) return;
    const previous = select.value;
    const users = activeUsers(state.users);
    select.replaceChildren();
    if (!users.length) {
      const option = global.document.createElement('option');
      option.value = '';
      option.textContent = '无 active 用户';
      select.appendChild(option);
      return;
    }
    for (const user of users) {
      const option = global.document.createElement('option');
      option.value = user.userId;
      const roles = user.globalRoles.length ? ` · ${user.globalRoles.join(',')}` : '';
      option.textContent = `${user.displayName || user.email || user.userId} · ${user.email || user.userId}${roles}`;
      select.appendChild(option);
    }
    if (users.some((user) => user.userId === previous)) select.value = previous;
  }

  function renderRoles() {
    const select = global.document.querySelector('#cfAccessRole');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    for (const role of state.roles) {
      const option = global.document.createElement('option');
      option.value = role.roleKey;
      option.textContent = `${role.roleName || role.roleKey} · ${role.roleKey}`;
      select.appendChild(option);
    }
    if (state.roles.some((role) => role.roleKey === previous)) select.value = previous;
  }

  function renderUserDirectory() {
    const tbody = global.document.querySelector('#cfAccessUserRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.users.length) {
      const tr = global.document.createElement('tr');
      const td = global.document.createElement('td');
      td.colSpan = 7;
      td.className = 'cfAccessEmpty';
      td.textContent = '没有用户';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const user of state.users) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(user.displayName || '—'));
      tr.appendChild(textCell(user.email || '—'));
      tr.appendChild(statusCell(user.status));
      tr.appendChild(textCell(user.cfAccessBound ? '已绑定' : '未绑定'));
      tr.appendChild(globalRolesCell(user));
      tr.appendChild(textCell(user.lastSeenAt || '—'));
      tr.appendChild(userLifecycleActionCell(user));
      tbody.appendChild(tr);
    }
  }

  function globalRolesCell(user) {
    const td = global.document.createElement('td');
    if (!user.globalRoles.length) {
      td.textContent = '—';
      return td;
    }
    const roles = global.document.createElement('div');
    roles.textContent = user.globalRoles.join(', ');
    const protectedBadge = badge('受保护账号', 'protected');
    td.append(roles, protectedBadge);
    return td;
  }

  function userLifecycleActionCell(user) {
    const td = global.document.createElement('td');
    td.className = 'cfAccessActions';

    const isCurrent = user.userId === state.currentUserId;
    const isProtected = user.globalRoles.length > 0;
    if (isCurrent) td.appendChild(badge('当前账号', 'current'));
    if (isProtected) td.appendChild(badge('受保护账号', 'protected'));
    if (isCurrent || isProtected) return td;

    const nextStatus = user.status === 'active'
      ? 'disabled'
      : user.status === 'disabled' ? 'active' : null;
    if (!nextStatus) {
      td.textContent = '不可操作';
      return td;
    }

    const disabling = nextStatus === 'disabled';
    const label = disabling ? '停用' : '恢复';
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = `btn cfAccessAction${disabling ? ' danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (state.loading) return;
      if (disabling) {
        const confirmed = global.confirm('停用后该用户将失去应用访问权限；现有店铺成员关系和角色会继续保留，之后可以恢复。确认停用？');
        if (!confirmed) return;
      }
      setBusy(true, `正在${label}用户…`);
      try {
        const payload = await updateUserStatus(user.userId, nextStatus);
        await refreshUsersCatalog();
        await refreshMembers();
        const changedText = payload?.changed === false ? '（状态未变化）' : '';
        setStatus(`用户${label}成功${changedText}`, 'ok');
      } catch (error) {
        setStatus(errorText(error), 'bad');
      } finally {
        setBusy(false);
      }
    });
    td.appendChild(button);
    return td;
  }

  function statusCell(status) {
    const td = global.document.createElement('td');
    td.appendChild(badge(status === 'active' ? 'active' : status === 'disabled' ? 'disabled' : status || '—', status));
    return td;
  }

  function badge(label, tone) {
    const span = global.document.createElement('span');
    span.className = `cfAccessMiniBadge${tone ? ` ${tone}` : ''}`;
    span.textContent = label;
    return span;
  }

  function renderMembers() {
    const tbody = global.document.querySelector('#cfAccessRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.members.length) {
      const tr = global.document.createElement('tr');
      const td = global.document.createElement('td');
      td.colSpan = 7;
      td.className = 'cfAccessEmpty';
      td.textContent = state.storeId ? '当前店铺没有成员' : '没有可用店铺';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const member of state.members) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(member.displayName || member.userId || '—'));
      tr.appendChild(textCell(member.email || '—'));
      tr.appendChild(textCell(member.userStatus || '—'));

      const role = memberRoleControl(member);
      tr.appendChild(role.cell);
      tr.appendChild(textCell(member.lastSeenAt || '—'));
      tr.appendChild(textCell(member.memberSince || '—'));
      tr.appendChild(memberActionCell(member, role.select));
      tbody.appendChild(tr);
    }
  }

  function memberRoleControl(member) {
    const cell = global.document.createElement('td');
    if (!state.canWriteMembership) {
      cell.textContent = member.roleName || member.roleKey || '—';
      return { cell, select: null };
    }
    const select = global.document.createElement('select');
    select.className = 'cfAccessInlineRole';
    for (const role of state.roles) {
      const option = global.document.createElement('option');
      option.value = role.roleKey;
      option.textContent = role.roleName || role.roleKey;
      select.appendChild(option);
    }
    select.value = member.roleKey;
    cell.appendChild(select);
    return { cell, select };
  }

  function memberActionCell(member, roleSelect) {
    const td = global.document.createElement('td');
    td.className = 'cfAccessActions';
    if (!state.canWriteMembership) {
      td.textContent = '只读';
      return td;
    }

    const save = actionButton('保存角色', async () => {
      const roleKey = String(roleSelect?.value || '');
      if (!roleKey) return;
      await putMember(state.storeId, member.userId, roleKey);
    });
    const remove = actionButton('移除', async () => {
      await deleteMember(state.storeId, member.userId);
    }, 'danger');
    td.append(save, remove);
    return td;
  }

  function actionButton(label, operation, tone = '') {
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = `btn cfAccessAction${tone ? ` ${tone}` : ''}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (state.loading) return;
      setBusy(true, `${label}…`);
      try {
        await operation();
        setStatus(`${label}成功`, 'ok');
        await refreshMembers();
      } catch (error) {
        setStatus(errorText(error), 'bad');
      } finally {
        setBusy(false);
      }
    });
    return button;
  }

  function renderCounts() {
    setText('#cfAccessMemberCount', state.members.length);
    setText('#cfAccessUserCount', state.users.length);
    setText('#cfAccessRoleCount', state.roles.length);
  }

  function renderMode() {
    const badgeNode = global.document.querySelector('#cfAccessMode');
    if (badgeNode) {
      badgeNode.textContent = state.canWriteMembership ? '用户生命周期 + 成员可管理' : '用户生命周期可管理 · 成员只读';
      badgeNode.classList.toggle('can-write', state.canWriteMembership);
    }
    const provisionPanel = global.document.querySelector('#cfAccessProvisionPanel');
    if (provisionPanel) provisionPanel.style.display = state.canProvision ? 'grid' : 'none';
    const assignPanel = global.document.querySelector('#cfAccessAssignPanel');
    if (assignPanel) assignPanel.style.display = state.canWriteMembership ? 'grid' : 'none';
  }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    const modal = global.document.querySelector('#nativeAccessConsoleModal');
    if (modal) modal.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    for (const control of global.document.querySelectorAll('#nativeAccessConsoleModal button, #nativeAccessConsoleModal select, #nativeAccessConsoleModal input')) {
      if (control.id === 'btnCfAccessClose') continue;
      control.disabled = state.loading || (control.id === 'cfAccessStore' && !state.stores.length);
    }
    if (message) setStatus(message, 'info');
  }

  function setStatus(message, tone) {
    const node = global.document.querySelector('#cfAccessStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone || 'info';
  }

  function normalizeUsers(rows) {
    return (Array.isArray(rows) ? rows : []).map((user) => ({
      ...user,
      userId: String(user.userId || ''),
      email: String(user.email || ''),
      displayName: String(user.displayName || ''),
      status: String(user.status || ''),
      cfAccessBound: Boolean(user.cfAccessBound),
      globalRoles: Array.isArray(user.globalRoles) ? user.globalRoles.map((role) => String(role)) : [],
      lastSeenAt: user.lastSeenAt || null,
    })).filter((user) => user.userId);
  }

  function activeUsers(rows) {
    return (Array.isArray(rows) ? rows : []).filter((user) => user.status === 'active');
  }

  function normalizeStores(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      storeId: String(row.storeId || row.store_id || ''),
      storeCode: String(row.storeCode || row.store_code || ''),
      displayName: String(row.displayName || row.display_name || ''),
      marketplaceCode: String(row.marketplaceCode || row.marketplace_code || ''),
    })).filter((row) => row.storeId);
  }

  function textCell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value ?? '—');
    return td;
  }

  function setText(selector, value) {
    const node = global.document.querySelector(selector);
    if (node) node.textContent = String(value);
  }

  function errorText(error) {
    const code = error?.code || error?.payload?.error || error?.message || 'unknown_error';
    const requestId = error?.requestId ? ` · request ${error.requestId}` : '';
    return `${String(code)}${requestId}`;
  }

  function installStyles() {
    if (global.document.querySelector('#cfAccessStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfAccessStyles';
    style.textContent = `
      .cfAccessModal{width:min(1320px,calc(100vw - 32px));max-width:1320px;max-height:calc(100vh - 32px);overflow:hidden;display:flex;flex-direction:column}
      .cfAccessHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.cfAccessHeader h2{margin:3px 0 5px}.cfAccessEyebrow{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--accent)}.cfAccessHeaderActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cfAccessBadge{padding:6px 9px;border-radius:999px;background:var(--softWarn);color:var(--warn);font-size:11px;font-weight:750}.cfAccessBadge.can-write{background:var(--softGood);color:var(--good)}
      .cfAccessBody{overflow:auto}.cfAccessContext{display:grid;grid-template-columns:minmax(260px,1.7fr) repeat(3,minmax(120px,.6fr));gap:8px;margin-bottom:10px}.cfAccessContext label,.cfAccessAssign label,.cfAccessProvision label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:10.8px;font-weight:700}.cfAccessContext select,.cfAccessAssign select,.cfAccessProvision input,.cfAccessInlineRole{min-width:0;border:1px solid var(--line);background:var(--input-bg);color:var(--text);border-radius:8px;padding:8px 9px}.cfAccessStat{border:1px solid var(--line);background:var(--hover-bg);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}.cfAccessStat strong{font-size:18px;color:var(--text)}.cfAccessStat span{font-size:10.5px;color:var(--muted)}
      .cfAccessProvision,.cfAccessAssign{display:grid;gap:8px;align-items:end;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--hover-bg);margin-bottom:8px}.cfAccessProvision{grid-template-columns:auto 1.35fr 1fr auto 1.5fr}.cfAccessAssign{grid-template-columns:auto 1.6fr 1fr auto}.cfAccessSectionTitle{font-size:11px;font-weight:800;color:var(--text);align-self:center;white-space:nowrap}.cfAccessHint{color:var(--muted);align-self:center}
      .cfAccessStatus{min-height:28px;display:flex;align-items:center;padding:5px 8px;border-radius:8px;margin-bottom:8px;background:var(--hover-bg);color:var(--muted);font-size:11px}.cfAccessStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfAccessStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}.cfAccessStatus[data-tone="warn"]{background:var(--softWarn);color:var(--warn)}
      .cfAccessSectionBlock{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:8px;margin-bottom:8px}.cfAccessSectionHeading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 2px 8px}.cfAccessSectionHeading>div{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.cfAccessSectionHeading strong{font-size:11.5px;color:var(--text)}.cfAccessSectionHeading span{font-size:10.5px;color:var(--muted)}
      .cfAccessTableWrap{max-height:34vh}.cfAccessUserTableWrap{max-height:31vh}.cfAccessTable{width:100%;min-width:1040px;border-collapse:collapse}.cfAccessTable th:nth-child(4){width:190px}.cfAccessUserTable th:nth-child(4){width:auto}.cfAccessActions{display:flex;gap:5px;flex-wrap:wrap;align-items:center}.cfAccessAction{padding:5px 8px;font-size:10.8px}.cfAccessEmpty{text-align:center;color:var(--muted);padding:28px!important}.cfAccessFoot{margin-top:8px;color:var(--muted)}
      .cfAccessMiniBadge{display:inline-flex;align-items:center;width:max-content;padding:3px 6px;border-radius:999px;background:var(--hover-bg);color:var(--muted);font-size:10px;font-weight:750;margin:2px 4px 2px 0}.cfAccessMiniBadge.active{background:var(--softGood);color:var(--good)}.cfAccessMiniBadge.disabled,.cfAccessMiniBadge.protected{background:var(--softWarn);color:var(--warn)}.cfAccessMiniBadge.current{background:var(--softGood);color:var(--good)}
      @media(max-width:1100px){.cfAccessContext{grid-template-columns:repeat(2,minmax(0,1fr))}.cfAccessProvision,.cfAccessAssign{grid-template-columns:1fr 1fr}.cfAccessSectionTitle,.cfAccessHint,.cfAccessProvision .btn,.cfAccessAssign .btn{grid-column:1/-1;width:max-content}.cfAccessHint{width:auto}.cfAccessHeader{flex-direction:column}}
      @media(max-width:620px){.cfAccessContext,.cfAccessProvision,.cfAccessAssign{grid-template-columns:1fr}.cfAccessModal{width:calc(100vw - 18px);max-height:calc(100vh - 18px)}}`;
    global.document.head.appendChild(style);
  }
})(window);
