/* ==========================================================================
   Admin Console — vanilla JS app
   - Hash routing (#/dashboard, #/clients, #/clients/:id, #/orders, ...)
   - Tenant mgmt (list, create, edit, regenerate key)
   - Toast + modal system, no alert()/confirm()
   - Designed against /admin/* API on the same Express server
   ========================================================================== */
(() => {
  // ----- constants ---------------------------------------------------------
  const KEY_LS = "saas_admin_api_key";
  const PUBLIC_BASE_LS = "saas_admin_public_base";

  // ----- shared state ------------------------------------------------------
  const state = {
    tenants: null,         // [{ id, name, slug, isActive, integration: { type } | null, hasApiKey, facebookPageId, createdAt }]
    ordersByTenant: {},    // tenantId -> [orders]
    selectedTenantId: null,
  };

  // ----- icons -------------------------------------------------------------
  const I = {
    add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953h-1.514c-1.49 0-1.953.926-1.953 1.875v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
  };

  // ----- DOM helpers -------------------------------------------------------
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function initials(name) {
    return String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("") || "?";
  }
  function timeAgo(iso) {
    if (!iso) return "—";
    const d = new Date(iso).getTime();
    const s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function copyText(t) {
    navigator.clipboard
      .writeText(t)
      .then(() => toast("Copied to clipboard", "ok"))
      .catch(() => toast("Copy failed", "err"));
  }

  // ----- Toast / modal -----------------------------------------------------
  function toast(message, kind = "info", title = "") {
    const host = $("#toasts");
    const node = el("div", { class: `toast ${kind}` }, [
      el("div", { class: "dot" }),
      el("div", { class: "body", html: title ? `<strong>${escapeHtml(title)}</strong>${escapeHtml(message)}` : escapeHtml(message) }),
    ]);
    host.appendChild(node);
    setTimeout(() => {
      node.classList.add("leave");
      setTimeout(() => node.remove(), 200);
    }, 3500);
  }

  function modal({ title, body, foot, size }) {
    const host = $("#modal");
    host.hidden = false;
    host.innerHTML = "";
    const close = () => {
      host.hidden = true;
      host.innerHTML = "";
    };
    const inner = el("div", { class: `modal ${size === "lg" ? "lg" : ""}` });
    const head = el("div", { class: "modal-head" }, [
      el("h3", {}, title),
      el("button", { class: "x-btn", onclick: close, "aria-label": "Close", html: I.x }),
    ]);
    const bodyEl = el("div", { class: "modal-body" });
    if (typeof body === "string") bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);
    const footEl = el("div", { class: "modal-foot" });
    (foot || []).forEach((b) => footEl.appendChild(b));
    inner.appendChild(head);
    inner.appendChild(bodyEl);
    if (foot && foot.length) inner.appendChild(footEl);
    host.appendChild(inner);
    host.onclick = (ev) => {
      if (ev.target === host) close();
    };
    return { close, body: bodyEl };
  }

  function confirmModal({ title, message, danger = false }) {
    return new Promise((resolve) => {
      const cancel = el("button", { class: "ghost" }, "Cancel");
      const ok = el("button", { class: danger ? "danger" : "primary" }, danger ? "Confirm" : "Continue");
      const m = modal({
        title,
        body: el("p", { class: "lede" }, message),
        foot: [cancel, ok],
      });
      cancel.onclick = () => {
        m.close();
        resolve(false);
      };
      ok.onclick = () => {
        m.close();
        resolve(true);
      };
    });
  }

  // ----- API ---------------------------------------------------------------
  function getAdminKey() {
    return sessionStorage.getItem(KEY_LS) || "";
  }
  function setAdminKey(v) {
    if (v) sessionStorage.setItem(KEY_LS, v);
    else sessionStorage.removeItem(KEY_LS);
    syncKeyStatus();
  }
  function publicBase() {
    return localStorage.getItem(PUBLIC_BASE_LS) || window.location.origin;
  }
  function setPublicBase(v) {
    if (v) localStorage.setItem(PUBLIC_BASE_LS, v);
    else localStorage.removeItem(PUBLIC_BASE_LS);
  }

  async function api(path, opts = {}) {
    const key = getAdminKey();
    if (!key) throw new Error("Set the admin API key (lower left).");
    const res = await fetch(path, {
      ...opts,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = typeof data === "object" && data ? data.error || JSON.stringify(data) : text || res.status;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  // ----- Sidebar key status ------------------------------------------------
  function syncKeyStatus() {
    const has = !!getAdminKey();
    const btn = $("#openKeyModal");
    btn.classList.toggle("ok", has);
    $("#keyMetaTitle").textContent = has ? "Admin key set" : "Set admin key";
    $("#keyMetaSub").textContent = has ? "Stored for this tab" : "Required for all actions";
  }

  function openKeyModal() {
    const input = el("input", {
      type: "password",
      placeholder: "paste ADMIN_API_KEY",
      autocomplete: "off",
      value: getAdminKey() || "",
    });
    const body = el("div", {}, [
      el("p", { class: "lede" }, "Set ADMIN_API_KEY in your server .env, restart, then paste the same key here. Stored only in sessionStorage."),
      el("label", { class: "field", style: "margin-top:14px;display:block;" }, "Admin key"),
      input,
    ]);
    const save = el("button", { class: "primary" }, "Save");
    const clear = el("button", { class: "ghost" }, "Clear");
    const m = modal({ title: "Admin API key", body, foot: [clear, save] });
    save.onclick = () => {
      setAdminKey(input.value.trim());
      m.close();
      toast("Admin key saved", "ok");
      route(); // re-render current view
    };
    clear.onclick = () => {
      setAdminKey("");
      m.close();
      toast("Admin key cleared", "info");
      route();
    };
  }

  // ----- Data fetching -----------------------------------------------------
  async function loadTenants(force = false) {
    if (state.tenants && !force) return state.tenants;
    const data = await api("/admin/tenants");
    state.tenants = data.tenants || [];
    $("#navClientsCount").textContent = state.tenants.length;
    return state.tenants;
  }

  async function loadTenant(id) {
    const data = await api(`/admin/tenants/${id}`);
    return data.tenant;
  }

  async function loadOrders(tenantId, force = false) {
    if (!force && state.ordersByTenant[tenantId]) return state.ordersByTenant[tenantId];
    const data = await api(`/admin/tenants/${tenantId}/orders?limit=100`);
    state.ordersByTenant[tenantId] = data.orders || [];
    return state.ordersByTenant[tenantId];
  }

  // ----- Status helpers ----------------------------------------------------
  function badgeForOrderStatus(s) {
    const cls =
      s === "DELIVERED" || s === "COMPLETED" ? "ok" :
      s === "FAILED" || s === "CANCELLED" ? "danger" :
      s === "AWAITING_PAYMENT" || s === "PENDING_CLIENT_SYNC" ? "warn" :
      "info";
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  }
  function badgeForPayment(s) {
    const cls =
      s === "PAID" ? "ok" :
      s === "FAILED" || s === "CANCELLED" ? "danger" :
      s === "PENDING" ? "warn" :
      "info";
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  }
  function badgeForIntegration(t) {
    if (!t) return '<span class="badge">none</span>';
    const cls = t === "API" ? "info" : t === "DATABASE" ? "violet" : "ok";
    return `<span class="badge ${cls}">${escapeHtml(t)}</span>`;
  }

  // ----- Pages -------------------------------------------------------------
  async function pageDashboard() {
    setCrumbs([{ label: "Dashboard" }]);
    const v = $("#view");
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Overview</h1>
          <p class="lede">Tenants connected through your Facebook order automation pipeline.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <a href="#/clients" class="secondary">${I.users}<span>Manage clients</span></a>
          <a href="#/clients/new" class="primary">${I.add}<span>New client</span></a>
        </div>
      </div>
      <div class="kpi-grid" id="kpis">
        ${[1, 2, 3, 4].map(() => `<div class="kpi"><div class="skeleton" style="height:18px;width:60%;"></div><div class="skeleton" style="height:34px;width:40%;margin-top:10px;"></div></div>`).join("")}
      </div>
      <div class="card flush" id="recent">
        <div class="card-head"><h2>Recent clients</h2><a href="#/clients" class="ghost">View all</a></div>
        <div style="padding:32px;text-align:center;color:var(--text-mute);">Loading…</div>
      </div>
    `;

    try {
      const tenants = await loadTenants();
      const total = tenants.length;
      const active = tenants.filter((t) => t.isActive).length;
      const fbConnected = tenants.filter((t) => t.facebookPageId).length;
      const integrated = tenants.filter((t) => t.integration && t.integration.type).length;

      $("#kpis").innerHTML = `
        ${kpiCard("Total clients", total, I.users, "rgba(99, 102, 241, 0.18)")}
        ${kpiCard("Active", active, I.activity, "rgba(74, 222, 128, 0.16)")}
        ${kpiCard("Facebook connected", fbConnected, I.facebook, "rgba(96, 165, 250, 0.16)")}
        ${kpiCard("With integration", integrated, I.box, "rgba(196, 181, 253, 0.16)")}
      `;

      const recent = [...tenants].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
      const recentEl = $("#recent");
      if (recent.length === 0) {
        recentEl.innerHTML = `<div class="card-head"><h2>Recent clients</h2></div>${emptyHTML("users", "No clients yet", "Create your first tenant to start receiving Messenger webhooks.", '<a href="#/clients/new" class="primary">' + I.add + "<span>New client</span></a>")}`;
      } else {
        recentEl.innerHTML = `
          <div class="card-head">
            <h2>Recent clients</h2>
            <a href="#/clients" class="ghost">View all ${I.arrow}</a>
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>Client</th><th>Integration</th><th>Status</th><th>Created</th><th class="right"></th></tr></thead>
              <tbody>
                ${recent.map((t) => clientRowHTML(t)).join("")}
              </tbody>
            </table>
          </div>`;
      }
    } catch (e) {
      $("#kpis").innerHTML = "";
      $("#recent").innerHTML = errorPanel(e.message);
    }
  }

  function kpiCard(label, value, icon, glow) {
    return `<div class="kpi" style="--kpi-glow:${glow};">
      <span class="icon">${icon}</span>
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${value}</div>
    </div>`;
  }

  function clientRowHTML(t) {
    return `
      <tr>
        <td>
          <div class="row-name">
            <div class="avatar">${escapeHtml(initials(t.name))}</div>
            <div class="row-meta">
              <strong>${escapeHtml(t.name)}</strong>
              <span class="slug">${escapeHtml(t.slug)}</span>
            </div>
          </div>
        </td>
        <td>${badgeForIntegration(t.integration && t.integration.type)}</td>
        <td>
          ${t.isActive ? '<span class="badge ok">active</span>' : '<span class="badge">inactive</span>'}
          ${t.facebookPageId ? '<span class="badge info">FB</span>' : ""}
          ${t.hasApiKey ? "" : '<span class="badge warn">no key</span>'}
        </td>
        <td style="color:var(--text-mute);">${escapeHtml(timeAgo(t.createdAt))}</td>
        <td class="right">
          <a class="ghost" href="#/clients/${escapeHtml(t.id)}">${I.open}<span>Open</span></a>
        </td>
      </tr>`;
  }

  // -------------------- Clients (all) -------------------------------------
  const clientsUI = { search: "", filter: "all", sort: "createdAt-desc" };

  async function pageClients() {
    setCrumbs([{ label: "Clients" }]);
    const v = $("#view");
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>All clients</h1>
          <p class="lede">Each client is a tenant in the multi-tenant pipeline. Manage Facebook credentials, integrations, and API keys here.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="ghost" id="reload">${I.refresh}<span>Refresh</span></button>
          <a class="primary" href="#/clients/new">${I.add}<span>New client</span></a>
        </div>
      </div>

      <div class="toolbar">
        <div class="search">
          ${I.search}
          <input id="search" type="search" placeholder="Search by name, slug, page id…" value="${escapeHtml(clientsUI.search)}" />
        </div>
        <div class="chip-group" id="filters">
          ${["all", "active", "inactive", "fb-connected", "no-key"].map((f) => `<button class="chip ${clientsUI.filter === f ? "active" : ""}" data-f="${f}">${labelForFilter(f)}</button>`).join("")}
        </div>
        <select id="sort" style="max-width:200px;">
          <option value="createdAt-desc">Newest first</option>
          <option value="createdAt-asc">Oldest first</option>
          <option value="name-asc">Name A→Z</option>
          <option value="name-desc">Name Z→A</option>
        </select>
      </div>

      <div class="card flush" id="tbl"></div>
    `;
    $("#sort").value = clientsUI.sort;

    $("#reload").onclick = async () => {
      try {
        await loadTenants(true);
        renderClientsTable();
        toast("Clients refreshed", "ok");
      } catch (e) {
        toast(e.message, "err");
      }
    };
    $("#search").oninput = (e) => {
      clientsUI.search = e.target.value;
      renderClientsTable();
    };
    $("#sort").onchange = (e) => {
      clientsUI.sort = e.target.value;
      renderClientsTable();
    };
    $$("#filters .chip").forEach((c) => {
      c.onclick = () => {
        clientsUI.filter = c.dataset.f;
        $$("#filters .chip").forEach((b) => b.classList.toggle("active", b === c));
        renderClientsTable();
      };
    });

    try {
      await loadTenants();
      renderClientsTable();
    } catch (e) {
      $("#tbl").innerHTML = errorPanel(e.message);
    }
  }

  function labelForFilter(f) {
    if (f === "all") return "All";
    if (f === "active") return "Active";
    if (f === "inactive") return "Inactive";
    if (f === "fb-connected") return "FB connected";
    if (f === "no-key") return "Missing key";
    return f;
  }

  function renderClientsTable() {
    const list = applyClientFilters(state.tenants || []);
    const host = $("#tbl");
    if (!host) return;

    if (list.length === 0) {
      host.innerHTML = emptyHTML(
        "users",
        clientsUI.search ? "No clients match your search" : "No clients yet",
        clientsUI.search ? "Try a different name, slug, or page id." : "Create your first tenant to start receiving Messenger webhooks.",
        '<a href="#/clients/new" class="primary">' + I.add + "<span>New client</span></a>",
      );
      return;
    }

    host.innerHTML = `
      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Client</th>
              <th>Integration</th>
              <th>Facebook page</th>
              <th>Status</th>
              <th>Created</th>
              <th class="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${list.map((t) => `
              <tr data-id="${escapeHtml(t.id)}">
                <td>
                  <div class="row-name">
                    <div class="avatar">${escapeHtml(initials(t.name))}</div>
                    <div class="row-meta">
                      <strong>${escapeHtml(t.name)}</strong>
                      <span class="slug">${escapeHtml(t.slug)}</span>
                    </div>
                  </div>
                </td>
                <td>${badgeForIntegration(t.integration && t.integration.type)}</td>
                <td class="mono">${t.facebookPageId ? escapeHtml(t.facebookPageId) : '<span style="color:var(--text-mute);">—</span>'}</td>
                <td>
                  ${t.isActive ? '<span class="badge ok">active</span>' : '<span class="badge">inactive</span>'}
                  ${t.hasApiKey ? "" : ' <span class="badge warn">no key</span>'}
                </td>
                <td style="color:var(--text-mute);">${escapeHtml(timeAgo(t.createdAt))}</td>
                <td class="right">
                  <button class="ghost btn-regen" data-id="${escapeHtml(t.id)}" title="Regenerate API key">${I.key}</button>
                  <a class="secondary" href="#/clients/${escapeHtml(t.id)}">${I.open}<span>Open</span></a>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;

    $$("#tbl .btn-regen").forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.id;
        const t = (state.tenants || []).find((x) => x.id === id);
        const ok = await confirmModal({
          title: "Regenerate tenant API key",
          message: `The current key for ${t?.name || id} will stop working immediately. Make sure the client is ready to receive the new key.`,
          danger: true,
        });
        if (!ok) return;
        try {
          const out = await api(`/admin/tenants/${id}/regenerate-api-key`, { method: "POST" });
          showApiKeyModal(out.apiKey, t?.name || id);
          await loadTenants(true);
          renderClientsTable();
        } catch (e) {
          toast(e.message, "err");
        }
      };
    });
  }

  function applyClientFilters(list) {
    const q = clientsUI.search.trim().toLowerCase();
    let out = list.filter((t) => {
      if (q) {
        const blob = `${t.name} ${t.slug} ${t.facebookPageId || ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (clientsUI.filter === "active" && !t.isActive) return false;
      if (clientsUI.filter === "inactive" && t.isActive) return false;
      if (clientsUI.filter === "fb-connected" && !t.facebookPageId) return false;
      if (clientsUI.filter === "no-key" && t.hasApiKey) return false;
      return true;
    });
    const [field, dir] = clientsUI.sort.split("-");
    out = [...out].sort((a, b) => {
      let va = a[field], vb = b[field];
      if (field === "createdAt") {
        va = new Date(va).getTime();
        vb = new Date(vb).getTime();
      } else {
        va = String(va || "").toLowerCase();
        vb = String(vb || "").toLowerCase();
      }
      return va < vb ? (dir === "asc" ? -1 : 1) : va > vb ? (dir === "asc" ? 1 : -1) : 0;
    });
    return out;
  }

  // -------------------- New client ----------------------------------------
  function pageNewClient() {
    setCrumbs([{ label: "Clients", href: "#/clients" }, { label: "New" }]);
    const v = $("#view");
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Create client</h1>
          <p class="lede">Provision a new tenant. You'll get a one-time API key to give the client for the <code>/api/v1/...</code> endpoints.</p>
        </div>
      </div>
      <div class="card">
        <form id="form" class="form-grid">
          <div>
            <label class="field">Name</label>
            <input name="name" required placeholder="Acme Co." />
          </div>
          <div>
            <label class="field">Slug</label>
            <input name="slug" required pattern="[a-z0-9-]+" placeholder="acme-co" />
          </div>
          <div>
            <label class="field">Facebook page ID <span style="color:var(--text-mute);">(optional)</span></label>
            <input name="facebookPageId" placeholder="123456789012345" />
          </div>
          <div>
            <label class="field">Facebook verify token <span style="color:var(--text-mute);">(optional)</span></label>
            <input name="facebookVerifyToken" placeholder="random string for Meta verification" />
          </div>
          <div class="full">
            <label class="field">Facebook page access token <span style="color:var(--text-mute);">(optional, stored encrypted)</span></label>
            <input name="facebookPageAccessToken" placeholder="EAAB…" />
          </div>
          <div>
            <label class="field">Integration type</label>
            <select name="type" required>
              <option value="WEBHOOK">WEBHOOK — POST to client URL</option>
              <option value="API">API — call client API</option>
              <option value="DATABASE">DATABASE — direct DB</option>
            </select>
          </div>
          <div>
            <label class="field">Sample config <span style="color:var(--text-mute);">(JSON below)</span></label>
            <button type="button" class="ghost" id="useSample">Insert webhook example</button>
          </div>
          <div class="full">
            <label class="field">Integration config (JSON)</label>
            <textarea name="config" rows="8" required placeholder='{"outboundUrl":"https://client.example/hook","outboundSecret":"shared"}'></textarea>
          </div>
          <div class="full" style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px;">
            <a href="#/clients" class="ghost">Cancel</a>
            <button type="submit" class="primary">${I.add}<span>Create client</span></button>
          </div>
        </form>
      </div>
    `;
    const form = $("#form");
    $("#useSample").onclick = () => {
      form.config.value = JSON.stringify(
        {
          outboundUrl: "https://client.example.com/hook",
          outboundSecret: "shared-secret",
          headers: { "X-Source": "saas" },
        },
        null,
        2,
      );
    };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      let config;
      try {
        config = JSON.parse(fd.get("config"));
      } catch {
        toast("Integration config is not valid JSON", "err");
        return;
      }
      const body = {
        name: fd.get("name"),
        slug: fd.get("slug"),
        facebookPageId: fd.get("facebookPageId") || undefined,
        facebookVerifyToken: fd.get("facebookVerifyToken") || undefined,
        facebookPageAccessToken: fd.get("facebookPageAccessToken") || undefined,
        integration: { type: fd.get("type"), config },
      };
      try {
        const res = await api("/admin/tenants", { method: "POST", body: JSON.stringify(body) });
        toast(`Client ${body.name} created`, "ok");
        await loadTenants(true);
        if (res.apiKey) showApiKeyModal(res.apiKey, body.name);
        location.hash = `#/clients/${res.tenant.id}`;
      } catch (e) {
        toast(e.message, "err");
      }
    };
  }

  function showApiKeyModal(key, name) {
    const code = el("div", { class: "code" }, [
      el("span", { html: escapeHtml(key) }),
      el("button", { class: "copy", title: "Copy", html: I.copy, onclick: () => copyText(key) }),
    ]);
    const body = el("div", {}, [
      el("p", { class: "lede" }, `This is the only time the API key for ${name} is shown. Save it somewhere safe and pass it to the client.`),
      el("div", { style: "margin-top:14px;" }, [code]),
      el("p", {
        class: "lede",
        style: "margin-top:14px;font-size:12px;",
        html: 'Use it as <code>Authorization: Bearer ' + escapeHtml(key.slice(0, 14)) + '...</code> against <code>/api/v1/...</code>.',
      }),
    ]);
    const done = el("button", { class: "primary" }, "I have saved it");
    const m = modal({ title: "Tenant API key (shown once)", body, foot: [done], size: "lg" });
    done.onclick = m.close;
  }

  // -------------------- Client detail -------------------------------------
  async function pageClientDetail(id) {
    setCrumbs([{ label: "Clients", href: "#/clients" }, { label: id.slice(0, 12) + "…" }]);
    const v = $("#view");
    v.innerHTML = `<div class="card"><div class="skeleton" style="height:24px;width:30%;"></div><div class="skeleton" style="height:14px;width:60%;margin-top:14px;"></div></div>`;

    let t;
    try {
      t = await loadTenant(id);
    } catch (e) {
      v.innerHTML = errorPanel(e.message);
      return;
    }
    setCrumbs([{ label: "Clients", href: "#/clients" }, { label: t.name }]);

    const orders = state.ordersByTenant[id];
    const ordersTotal = orders ? orders.length : "…";
    const paid = orders ? orders.filter((o) => o.paymentStatus === "PAID").length : "…";

    v.innerHTML = `
      <div class="page-head">
        <div style="display:flex;gap:14px;align-items:center;">
          <div class="avatar" style="width:48px;height:48px;border-radius:14px;font-size:16px;">${escapeHtml(initials(t.name))}</div>
          <div>
            <h1 style="font-size:24px;">${escapeHtml(t.name)}</h1>
            <p class="lede" style="margin-top:4px;">
              <span class="slug" style="font-family:var(--font-mono);color:var(--accent-bright);">${escapeHtml(t.slug)}</span>
              · ${t.isActive ? '<span class="badge ok">active</span>' : '<span class="badge">inactive</span>'}
              · ${badgeForIntegration(t.integration && t.integration.type)}
              ${t.facebookPageId ? '· <span class="badge info">FB connected</span>' : ""}
            </p>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="ghost" id="btnToggle">${t.isActive ? "Deactivate" : "Activate"}</button>
          <button class="secondary" id="btnRegen">${I.key}<span>Regenerate key</span></button>
          <button class="primary" id="btnEdit">${I.edit}<span>Edit</span></button>
        </div>
      </div>

      <div class="kpi-grid">
        ${kpiCard("Orders (recent)", ordersTotal, I.box, "rgba(99,102,241,0.18)")}
        ${kpiCard("Paid", paid, I.activity, "rgba(74, 222, 128, 0.16)")}
        ${kpiCard("Has API key", t.hasApiKey ? "Yes" : "No", I.key, "rgba(196, 181, 253, 0.16)")}
        ${kpiCard("Created", new Date(t.createdAt).toLocaleDateString(), I.users, "rgba(96, 165, 250, 0.16)")}
      </div>

      <div class="detail-grid">
        <div class="card flush">
          <div class="card-head">
            <h2>Recent orders</h2>
            <a class="ghost" href="#/orders?tenant=${escapeHtml(id)}">${I.open}<span>Open in orders</span></a>
          </div>
          <div id="ordersHost"><div style="padding:32px;text-align:center;color:var(--text-mute);">Loading orders…</div></div>
        </div>

        <div class="card">
          <div class="card-head" style="padding:0;border:0;margin-bottom:14px;"><h2>Configuration</h2></div>
          <dl class="kv">
            <dt>Tenant ID</dt><dd class="mono" style="font-size:12px;">${escapeHtml(t.id)}</dd>
            <dt>Slug</dt><dd class="mono" style="font-size:12px;">${escapeHtml(t.slug)}</dd>
            <dt>Page ID</dt><dd class="mono" style="font-size:12px;">${t.facebookPageId ? escapeHtml(t.facebookPageId) : '<span style="color:var(--text-mute);">not set</span>'}</dd>
            <dt>Verify token</dt><dd>${t.facebookVerifyToken ? '<span class="badge ok">set</span>' : '<span class="badge warn">missing</span>'}</dd>
            <dt>Page token</dt><dd>${t.facebookPageAccessToken ? '<span class="badge ok">set</span>' : '<span class="badge warn">missing</span>'}</dd>
            <dt>Integration</dt><dd>${badgeForIntegration(t.integration && t.integration.type)}</dd>
          </dl>

          <div style="margin-top:18px;">
            <label class="field">Integration config</label>
            <pre class="json">${escapeHtml(JSON.stringify(t.integration?.config ?? null, null, 2))}</pre>
          </div>

          <div style="margin-top:18px;">
            <label class="field">Webhook URLs for this client</label>
            ${webhookCodeBlock("Facebook verify + messages", `${publicBase()}/webhooks/facebook/${t.slug}`)}
            ${webhookCodeBlock("Client inbound (webhook integration)", `${publicBase()}/webhooks/client/${t.slug}/inbound`)}
          </div>
        </div>
      </div>
    `;

    // Wire actions
    $("#btnRegen").onclick = async () => {
      const ok = await confirmModal({
        title: "Regenerate tenant API key",
        message: `The current key for ${t.name} will stop working immediately.`,
        danger: true,
      });
      if (!ok) return;
      try {
        const out = await api(`/admin/tenants/${id}/regenerate-api-key`, { method: "POST" });
        showApiKeyModal(out.apiKey, t.name);
      } catch (e) {
        toast(e.message, "err");
      }
    };
    $("#btnToggle").onclick = async () => {
      try {
        await api(`/admin/tenants/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ isActive: !t.isActive }),
        });
        await loadTenants(true);
        toast(t.isActive ? "Client deactivated" : "Client activated", "ok");
        pageClientDetail(id);
      } catch (e) {
        toast(e.message, "err");
      }
    };
    $("#btnEdit").onclick = () => openEditClientModal(t);

    // Load orders for this client
    try {
      const list = await loadOrders(id);
      const host = $("#ordersHost");
      if (!host) return;
      if (list.length === 0) {
        host.innerHTML = emptyHTML("box", "No orders yet", "Orders will appear when conversations convert.");
      } else {
        host.innerHTML = `
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Created</th><th>Reference</th><th>Status</th><th>Payment</th><th class="right">Total</th></tr></thead>
            <tbody>
              ${list.slice(0, 8).map((o) => `
                <tr>
                  <td style="color:var(--text-mute);">${escapeHtml(timeAgo(o.createdAt))}</td>
                  <td class="mono">${escapeHtml(o.id.slice(0, 14))}…</td>
                  <td>${badgeForOrderStatus(o.status)}</td>
                  <td>${badgeForPayment(o.paymentStatus)}</td>
                  <td class="right" style="font-variant-numeric:tabular-nums;">${o.totalAmount != null ? escapeHtml(o.totalAmount + " " + (o.currency || "")) : "—"}</td>
                </tr>`).join("")}
            </tbody>
          </table></div>
          <div style="padding:14px 18px;border-top:1px solid var(--line);text-align:right;">
            <a class="ghost" href="#/orders?tenant=${escapeHtml(id)}">See all ${list.length}</a>
          </div>`;
      }
      // also refresh KPI
      pageClientDetail.kpiUpdate?.(list);
    } catch (e) {
      const host = $("#ordersHost");
      if (host) host.innerHTML = `<div style="padding:18px;color:var(--danger);">${escapeHtml(e.message)}</div>`;
    }
  }

  function webhookCodeBlock(label, url) {
    const safeUrl = escapeHtml(url);
    return `
      <div style="margin-top:8px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-mute);margin-bottom:6px;">${escapeHtml(label)}</div>
        <div class="code">
          <span>${safeUrl}</span>
          <button class="copy" title="Copy" data-copy="${safeUrl}">${I.copy}</button>
        </div>
      </div>`;
  }

  function openEditClientModal(t) {
    const cfgInitial = JSON.stringify(t.integration?.config ?? {}, null, 2);
    const body = el("div", { class: "form-grid" });
    body.innerHTML = `
      <div><label class="field">Name</label><input name="name" value="${escapeHtml(t.name)}" /></div>
      <div><label class="field">Active</label>
        <select name="isActive">
          <option value="true" ${t.isActive ? "selected" : ""}>Yes</option>
          <option value="false" ${t.isActive ? "" : "selected"}>No</option>
        </select>
      </div>
      <div><label class="field">Facebook page ID</label><input name="facebookPageId" value="${escapeHtml(t.facebookPageId || "")}" /></div>
      <div><label class="field">Facebook verify token</label><input name="facebookVerifyToken" placeholder="leave blank to keep" /></div>
      <div class="full"><label class="field">Facebook page access token</label><input name="facebookPageAccessToken" placeholder="leave blank to keep" /></div>
      <div><label class="field">Integration type</label>
        <select name="type">
          <option value="WEBHOOK" ${t.integration?.type === "WEBHOOK" ? "selected" : ""}>WEBHOOK</option>
          <option value="API" ${t.integration?.type === "API" ? "selected" : ""}>API</option>
          <option value="DATABASE" ${t.integration?.type === "DATABASE" ? "selected" : ""}>DATABASE</option>
        </select>
      </div>
      <div></div>
      <div class="full"><label class="field">Integration config (JSON)</label><textarea name="config" rows="10">${escapeHtml(cfgInitial)}</textarea></div>
    `;
    const cancel = el("button", { class: "ghost" }, "Cancel");
    const save = el("button", { class: "primary" }, "Save changes");
    const m = modal({ title: `Edit ${t.name}`, body, foot: [cancel, save], size: "lg" });
    cancel.onclick = m.close;
    save.onclick = async () => {
      const get = (k) => body.querySelector(`[name="${k}"]`).value;
      let config;
      try {
        config = JSON.parse(get("config"));
      } catch {
        toast("Integration config is not valid JSON", "err");
        return;
      }
      const patch = {
        name: get("name"),
        isActive: get("isActive") === "true",
        facebookPageId: get("facebookPageId") || null,
      };
      const newToken = get("facebookVerifyToken").trim();
      if (newToken) patch.facebookVerifyToken = newToken;
      const newPageToken = get("facebookPageAccessToken").trim();
      if (newPageToken) patch.facebookPageAccessToken = newPageToken;
      patch.integration = { type: get("type"), config };

      try {
        await api(`/admin/tenants/${t.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        toast("Client updated", "ok");
        await loadTenants(true);
        m.close();
        pageClientDetail(t.id);
      } catch (e) {
        toast(e.message, "err");
      }
    };
  }

  // -------------------- Orders (cross-tenant) -----------------------------
  const ordersUI = { tenantId: "", search: "", status: "all" };

  async function pageOrders(params) {
    setCrumbs([{ label: "Orders" }]);
    if (params.tenant) ordersUI.tenantId = params.tenant;

    const v = $("#view");
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Orders</h1>
          <p class="lede">Cross-tenant order viewer. Select a client to load up to 100 most recent orders.</p>
        </div>
        <button class="ghost" id="reloadOrders">${I.refresh}<span>Refresh</span></button>
      </div>
      <div class="toolbar">
        <select id="tenantPick" style="max-width:280px;"><option value="">— Choose client —</option></select>
        <div class="search">
          ${I.search}
          <input id="oSearch" type="search" placeholder="Search by order id or data…" />
        </div>
        <div class="chip-group" id="oFilters">
          ${["all", "AWAITING_PAYMENT", "PAID", "DELIVERED", "FAILED"].map((f) => `<button class="chip ${f === ordersUI.status ? "active" : ""}" data-f="${f}">${f.replace(/_/g, " ")}</button>`).join("")}
        </div>
      </div>
      <div class="card flush" id="oTable"></div>
    `;

    try {
      const tenants = await loadTenants();
      const sel = $("#tenantPick");
      sel.innerHTML = `<option value="">— Choose client —</option>` + tenants.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (${escapeHtml(t.slug)})</option>`).join("");
      sel.value = ordersUI.tenantId;
      sel.onchange = async () => {
        ordersUI.tenantId = sel.value;
        await renderOrders();
      };
      $("#reloadOrders").onclick = async () => {
        if (!ordersUI.tenantId) {
          toast("Choose a client first", "info");
          return;
        }
        await loadOrders(ordersUI.tenantId, true);
        await renderOrders();
        toast("Orders refreshed", "ok");
      };
      $("#oSearch").oninput = (e) => {
        ordersUI.search = e.target.value;
        renderOrders();
      };
      $$("#oFilters .chip").forEach((c) => {
        c.onclick = () => {
          ordersUI.status = c.dataset.f;
          $$("#oFilters .chip").forEach((x) => x.classList.toggle("active", x === c));
          renderOrders();
        };
      });

      await renderOrders();
    } catch (e) {
      $("#oTable").innerHTML = errorPanel(e.message);
    }
  }

  async function renderOrders() {
    const host = $("#oTable");
    if (!host) return;
    if (!ordersUI.tenantId) {
      host.innerHTML = emptyHTML("box", "Pick a client", "Choose a client above to load their orders.");
      return;
    }
    let list;
    try {
      list = await loadOrders(ordersUI.tenantId);
    } catch (e) {
      host.innerHTML = errorPanel(e.message);
      return;
    }
    const q = ordersUI.search.trim().toLowerCase();
    const filtered = list.filter((o) => {
      if (ordersUI.status !== "all" && o.status !== ordersUI.status && o.paymentStatus !== ordersUI.status) return false;
      if (q) {
        const blob = `${o.id} ${JSON.stringify(o.structuredData || "")}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
    if (filtered.length === 0) {
      host.innerHTML = emptyHTML("box", "No orders match", "Try a different filter or search term.");
      return;
    }
    host.innerHTML = `
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Created</th><th>Reference</th><th>Customer data</th><th>Status</th><th>Payment</th><th class="right">Total</th></tr></thead>
        <tbody>
          ${filtered.map((o) => `
            <tr>
              <td style="color:var(--text-mute);">${escapeHtml(timeAgo(o.createdAt))}</td>
              <td class="mono">${escapeHtml(o.id.slice(0, 18))}…</td>
              <td style="color:var(--text-dim);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(JSON.stringify(o.structuredData || {}))}</td>
              <td>${badgeForOrderStatus(o.status)}</td>
              <td>${badgeForPayment(o.paymentStatus)}</td>
              <td class="right" style="font-variant-numeric:tabular-nums;">${o.totalAmount != null ? escapeHtml(o.totalAmount + " " + (o.currency || "")) : "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
    `;
  }

  // -------------------- Webhooks ------------------------------------------
  async function pageWebhooks() {
    setCrumbs([{ label: "Webhooks" }]);
    const v = $("#view");
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Webhook URLs</h1>
          <p class="lede">Use these in Meta and SSLCommerz dashboards. Replace <code>:slug</code> with your client's slug.</p>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px;">
        <label class="field">Public base URL <span style="color:var(--text-mute);">(matches <code>PUBLIC_BASE_URL</code>)</span></label>
        <input id="pub" type="url" value="${escapeHtml(publicBase())}" placeholder="https://your-domain.com" />
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Global webhooks</h2></div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:14px;">
          ${webhookCodeBlock("SSLCommerz IPN", `${publicBase()}/webhooks/sslcommerz/ipn`)}
        </div>
      </div>
      <div class="card flush" style="margin-top:16px;">
        <div class="card-head"><h2>Per-client webhooks</h2></div>
        <div id="perClient" style="padding:18px;display:flex;flex-direction:column;gap:18px;"></div>
      </div>
    `;
    $("#pub").oninput = (e) => {
      setPublicBase(e.target.value.trim());
      route(); // re-render
    };

    try {
      const tenants = await loadTenants();
      const host = $("#perClient");
      if (tenants.length === 0) {
        host.innerHTML = emptyHTML("users", "No clients yet", "Create a client first.");
        return;
      }
      host.innerHTML = tenants
        .map(
          (t) => `
        <div style="border:1px solid var(--line);border-radius:12px;padding:14px;background:rgba(255,255,255,0.015);">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
            <div class="avatar">${escapeHtml(initials(t.name))}</div>
            <div>
              <strong>${escapeHtml(t.name)}</strong>
              <div class="slug" style="font-family:var(--font-mono);font-size:12px;color:var(--text-mute);">${escapeHtml(t.slug)}</div>
            </div>
          </div>
          ${webhookCodeBlock("Facebook verify + messages", `${publicBase()}/webhooks/facebook/${t.slug}`)}
          ${webhookCodeBlock("Client inbound", `${publicBase()}/webhooks/client/${t.slug}/inbound`)}
        </div>`,
        )
        .join("");
    } catch (e) {
      $("#perClient").innerHTML = errorPanel(e.message);
    }
  }

  // -------------------- API reference -------------------------------------
  function pageApiReference() {
    setCrumbs([{ label: "API reference" }]);
    const v = $("#view");
    const endpoints = [
      ["GET", "/api/v1/me", "Tenant info"],
      ["GET", "/api/v1/orders", "List orders (paginated)"],
      ["GET", "/api/v1/orders/:id", "Get one order"],
      ["GET", "/api/v1/product-mappings", "Product → SKU mappings"],
      ["POST", "/api/v1/product-mappings", "Add mapping"],
      ["PATCH", "/api/v1/settings", "Update tenant settings"],
    ];
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Tenant API</h1>
          <p class="lede">Clients use the <code>Authorization: Bearer sk_live_…</code> key (shown once when created or regenerated).</p>
        </div>
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Endpoints</h2></div>
        <table class="tbl">
          <thead><tr><th>Method</th><th>Path</th><th>Description</th><th class="right"></th></tr></thead>
          <tbody>
            ${endpoints.map(([m, p, d]) => `
              <tr>
                <td><span class="badge ${m === "GET" ? "info" : m === "POST" ? "ok" : "warn"}">${m}</span></td>
                <td class="mono">${escapeHtml(p)}</td>
                <td style="color:var(--text-dim);">${escapeHtml(d)}</td>
                <td class="right"><button class="ghost" data-copy="${escapeHtml(publicBase() + p)}">${I.copy}</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top:16px;">
        <h2 style="margin:0 0 12px;font-size:15px;">Example</h2>
        <pre class="json">curl -H "Authorization: Bearer sk_live_..." \\
     ${escapeHtml(publicBase())}/api/v1/orders?limit=20</pre>
      </div>
    `;
  }

  // -------------------- Reusable bits -------------------------------------
  function emptyHTML(_icon, title, message, actions = "") {
    return `
      <div class="empty">
        <div class="icon-wrap">${I.users}</div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        ${actions ? `<div class="actions">${actions}</div>` : ""}
      </div>`;
  }
  function errorPanel(msg) {
    return `
      <div class="empty">
        <div class="icon-wrap" style="color:var(--danger);background:rgba(248,113,113,0.08);border-color:rgba(248,113,113,0.25);">${I.x}</div>
        <h3 style="color:var(--text);">Something went wrong</h3>
        <p style="color:var(--text-dim);">${escapeHtml(msg || "Unknown error")}</p>
        <div class="actions"><button class="ghost" onclick="location.reload()">Reload</button></div>
      </div>`;
  }

  function setCrumbs(items) {
    const html = items
      .map((it, i) => {
        const sep = i === items.length - 1 ? "" : '<span class="sep">/</span>';
        if (it.href) return `<a href="${escapeHtml(it.href)}" style="color:var(--text-dim);text-decoration:none;">${escapeHtml(it.label)}</a>${sep}`;
        return `<strong>${escapeHtml(it.label)}</strong>${sep}`;
      })
      .join(" ");
    $("#crumbs").innerHTML = html;
  }

  // ----- Router ------------------------------------------------------------
  function parseHash() {
    const raw = location.hash.replace(/^#/, "") || "/dashboard";
    const [pathPart, queryPart = ""] = raw.split("?");
    const params = Object.fromEntries(new URLSearchParams(queryPart));
    const segs = pathPart.split("/").filter(Boolean);
    return { segs, params };
  }
  function setActiveNav(routeName) {
    $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.route === routeName));
  }

  async function route() {
    const { segs, params } = parseHash();
    const [head, sub] = segs;
    if (!head || head === "dashboard") {
      setActiveNav("dashboard");
      return pageDashboard();
    }
    if (head === "clients") {
      setActiveNav("clients");
      if (!sub) return pageClients();
      if (sub === "new") return pageNewClient();
      return pageClientDetail(sub);
    }
    if (head === "orders") {
      setActiveNav("orders");
      return pageOrders(params);
    }
    if (head === "webhooks") {
      setActiveNav("webhooks");
      return pageWebhooks();
    }
    if (head === "api-reference") {
      setActiveNav("api-reference");
      return pageApiReference();
    }
    setActiveNav("dashboard");
    pageDashboard();
  }

  // ----- Global handlers ---------------------------------------------------
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-copy]");
    if (t) {
      ev.preventDefault();
      copyText(t.dataset.copy);
    }
  });

  // Theme toggle
  const THEME_LS = "saas_admin_theme";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    const lbl = $("#themeLabel");
    if (lbl) lbl.textContent = t === "light" ? "Light" : "Dark";
  }
  applyTheme(localStorage.getItem(THEME_LS) || "dark");
  $("#themeToggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    localStorage.setItem(THEME_LS, next);
    applyTheme(next);
  });

  $("#openKeyModal").addEventListener("click", openKeyModal);
  $("#topRefresh").addEventListener("click", async () => {
    state.tenants = null;
    state.ordersByTenant = {};
    await route();
    toast("Refreshed", "ok");
  });

  window.addEventListener("hashchange", route);

  // boot
  syncKeyStatus();
  if (!getAdminKey()) {
    // friendly first-run nudge
    setTimeout(openKeyModal, 200);
  }
  route();
})();
