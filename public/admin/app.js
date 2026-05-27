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

  /**
   * Tenant activation status pill. Three states:
   *  - Activated   — client has set a password, can log in via email + password.
   *  - Pending     — admin issued an activation link that hasn't been used yet.
   *  - Not active  — no password and no pending link. Click "Issue activation link".
   */
  function activationBadge(t) {
    if (t.hasPassword) return '<span class="badge ok">activated</span>';
    if (t.hasPendingActivation) return '<span class="badge warn">activation pending</span>';
    return '<span class="badge">not activated</span>';
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

  /**
   * Show the activation URL the admin forwards to the client. The URL only
   * exists for one minute on the server; once dismissed there's no way to
   * recover it without re-issuing.
   *
   * `kind` switches the wording between a fresh activation (no password yet)
   * and a password reset (existing password + sessions wiped).
   */
  function showActivationModal({ url, expiresAt, name, kind }) {
    const code = el("div", { class: "code" }, [
      el("span", { html: escapeHtml(url) }),
      el("button", { class: "copy", title: "Copy", html: I.copy, onclick: () => copyText(url) }),
    ]);
    const description = kind === "reset"
      ? `Old password and every active session for ${name} have been wiped. Forward this link — they will set a fresh password.`
      : `${name} can open this link to set their email + password and sign in. The platform admin cannot see what they choose.`;
    const expiryStr = expiresAt ? new Date(expiresAt).toLocaleString() : "in 7 days";
    const body = el("div", {}, [
      el("p", { class: "lede" }, description),
      el("div", { style: "margin-top:14px;" }, [code]),
      el("p", {
        class: "lede",
        style: "margin-top:14px;font-size:12px;color:var(--text-mute);",
        html: `Expires ${escapeHtml(expiryStr)}. Forward via your usual secure channel \u2014 the URL is valid only once.`,
      }),
    ]);
    const done = el("button", { class: "primary" }, "I have saved it");
    const title = kind === "reset" ? "Password reset link (shown once)" : "Activation link (shown once)";
    const m = modal({ title, body, foot: [done], size: "lg" });
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
    setSchemaBanner(t);

    // Fetch subscription summary so the detail page has a billing card. The
    // endpoint may 404 for tenants without a subscription row (the demo tenant
    // before bootstrap, for example) — render a graceful fallback in that case.
    let sub = null;
    try {
      const subRes = await api(`/admin/subscriptions/${encodeURIComponent(id)}`);
      sub = subRes.subscription;
    } catch (_e) {
      sub = null;
    }

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
              · ${activationBadge(t)}
            </p>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="ghost" id="btnToggle">${t.isActive ? "Deactivate" : "Activate"}</button>
          <button class="secondary" id="btnRegen">${I.key}<span>Regenerate key</span></button>
          <button class="secondary" id="btnActivate">${I.key}<span>${t.hasPassword ? "Reset password" : "Issue activation link"}</span></button>
          <button class="primary" id="btnEdit">${I.edit}<span>Edit</span></button>
        </div>
      </div>

      <div class="kpi-grid">
        ${kpiCard("Orders (recent)", ordersTotal, I.box, "rgba(99,102,241,0.18)")}
        ${kpiCard("Paid", paid, I.activity, "rgba(74, 222, 128, 0.16)")}
        ${kpiCard("Has API key", t.hasApiKey ? "Yes" : "No", I.key, "rgba(196, 181, 253, 0.16)")}
        ${kpiCard("Created", new Date(t.createdAt).toLocaleDateString(), I.users, "rgba(96, 165, 250, 0.16)")}
      </div>

      ${sub ? `
        <div class="card" style="margin-bottom:16px;">
          <div class="card-head" style="padding:0;border:0;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
            <h2>Subscription</h2>
            <a class="ghost" href="#/billing">${I.open}<span>Open in billing</span></a>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;">
            <div>
              <div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Plan</div>
              <div style="font-weight:600;margin-top:4px;">${escapeHtml(sub.planName)}</div>
              <div style="color:var(--text-mute);font-size:11px;">${escapeHtml(sub.priceBdt)} BDT/mo</div>
            </div>
            <div>
              <div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Status</div>
              <div style="margin-top:4px;">${subscriptionBadge(sub.status)}</div>
            </div>
            <div>
              <div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Period end</div>
              <div style="margin-top:4px;">${escapeHtml(formatDate(sub.currentPeriodEnd))}</div>
              <div style="color:var(--text-mute);font-size:11px;">${sub.gracePeriodEndsAt ? `Grace ends ${escapeHtml(formatDate(sub.gracePeriodEndsAt))}` : ""}</div>
            </div>
            <div style="text-align:right;">
              <button class="secondary" id="btnSubscriptionDetail">${I.open}<span>Manage</span></button>
            </div>
          </div>
        </div>
      ` : `
        <div class="card" style="margin-bottom:16px;">
          <div class="card-head" style="padding:0;border:0;margin-bottom:8px;"><h2>Subscription</h2></div>
          <p class="lede" style="margin:0;">No subscription on file. The tenant will get a trial when they finish onboarding.</p>
        </div>
      `}

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
            <dt>Email</dt><dd>${t.email ? escapeHtml(t.email) : '<span style="color:var(--text-mute);">not set</span>'}</dd>
            <dt>Login</dt><dd>${activationBadge(t)}${t.hasPendingActivation && t.activationExpiresAt ? ` <span style=\"color:var(--text-mute);font-size:12px;\">expires ${escapeHtml(new Date(t.activationExpiresAt).toLocaleString())}</span>` : ""}</dd>
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
    const btnDetail = $("#btnSubscriptionDetail");
    if (btnDetail) {
      btnDetail.onclick = () => openSubscriptionDetailModal(id);
    }
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

    // Issue activation link / Reset password — single endpoint based on
    // whether the client has set a password yet.
    $("#btnActivate").onclick = async () => {
      const isReset = !!t.hasPassword;
      const ok = await confirmModal({
        title: isReset ? "Reset password" : "Issue activation link",
        message: isReset
          ? `Wipes ${t.name}'s current password and EVERY active session, then mints a fresh activation link. Use only when the client has lost access.`
          : `Issue an activation link for ${t.name}. Any previous link is invalidated. The client opens it to set their email + password — you cannot see what they choose.`,
        danger: isReset,
      });
      if (!ok) return;
      try {
        const path = isReset
          ? `/admin/tenants/${id}/reset-password`
          : `/admin/tenants/${id}/issue-activation`;
        const out = await api(path, { method: "POST" });
        showActivationModal({
          url: out.activationUrl,
          expiresAt: out.activationExpiresAt,
          name: t.name,
          kind: isReset ? "reset" : "activate",
        });
        await loadTenants(true);
        pageClientDetail(id);
      } catch (e) {
        toast(e.message, "err");
      }
    };

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

  // -------------------- Billing ------------------------------------------
  /**
   * Billing page — three sub-views: Plans, Subscriptions, Payments.
   * Routed via hash params (`#/billing?tab=plans`); defaults to Subscriptions.
   * All data is fetched per tab so switching is fast.
   */
  async function pageBilling(params) {
    setCrumbs([{ label: "Billing" }]);
    const tab = params.tab === "plans" || params.tab === "payments" || params.tab === "gateway" ? params.tab : "subscriptions";
    const v = $("#view");
    v.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Billing</h1>
          <p class="lede">Manage plans, subscriptions, and payments. Edits here apply immediately to every tenant on the affected plan.</p>
        </div>
        <button class="ghost" id="billingReload">${I.refresh}<span>Refresh</span></button>
      </div>

      <div class="toolbar">
        <div class="chip-group" id="billingTabs">
          <a href="#/billing?tab=subscriptions" class="chip ${tab === "subscriptions" ? "active" : ""}">Subscriptions</a>
          <a href="#/billing?tab=plans" class="chip ${tab === "plans" ? "active" : ""}">Plans</a>
          <a href="#/billing?tab=payments" class="chip ${tab === "payments" ? "active" : ""}">Payments</a>
          <a href="#/billing?tab=gateway" class="chip ${tab === "gateway" ? "active" : ""}">Gateway</a>
        </div>
      </div>

      <div id="billingBody"></div>
    `;
    $("#billingReload").onclick = () => pageBilling(params);

    if (tab === "plans") return renderPlans();
    if (tab === "payments") return renderPayments();
    if (tab === "gateway") return renderGateway();
    return renderSubscriptions();
  }

  async function renderSubscriptions() {
    const host = $("#billingBody");
    host.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-mute);">Loading subscriptions…</div>`;
    try {
      const data = await api("/admin/subscriptions");
      const subs = data.subscriptions || [];
      if (subs.length === 0) {
        host.innerHTML = emptyHTML("box", "No subscriptions yet", "When a tenant completes onboarding, their trial subscription will show up here.");
        return;
      }
      host.innerHTML = `
        <div class="card flush">
          <div class="table-wrap"><table class="tbl">
            <thead><tr>
              <th>Tenant</th><th>Category</th><th>Plan</th><th>Status</th>
              <th>Period end</th><th>Days left</th><th>Last payment</th><th class="right">Actions</th>
            </tr></thead>
            <tbody>
              ${subs.map((s) => `
                <tr data-tenant="${escapeHtml(s.tenantId)}">
                  <td>
                    <div class="row-name">
                      <div class="avatar">${escapeHtml(initials(s.tenantName))}</div>
                      <div class="row-meta">
                        <strong>${escapeHtml(s.tenantName)}</strong>
                        <span class="slug">${escapeHtml(s.tenantSlug)}</span>
                      </div>
                    </div>
                  </td>
                  <td style="color:var(--text-dim);">${s.businessCategory ? escapeHtml(s.businessCategory) : "—"}</td>
                  <td>${escapeHtml(s.planName)} <span style="color:var(--text-mute);">(${escapeHtml(s.planSlug)})</span></td>
                  <td>${subscriptionBadge(s.status)}</td>
                  <td style="color:var(--text-mute);">${escapeHtml(formatDate(s.currentPeriodEnd))}</td>
                  <td style="font-variant-numeric:tabular-nums;">${s.daysRemaining}d</td>
                  <td>${paymentBadge(s.lastPaymentStatus)}</td>
                  <td class="right">
                    <button class="ghost btn-detail" data-tenant="${escapeHtml(s.tenantId)}">${I.open}<span>Open</span></button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table></div>
        </div>
      `;
      $$("#billingBody .btn-detail").forEach((btn) => {
        btn.onclick = () => openSubscriptionDetailModal(btn.dataset.tenant);
      });
    } catch (e) {
      host.innerHTML = errorPanel(e.message);
    }
  }

  async function renderPlans() {
    const host = $("#billingBody");
    host.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-mute);">Loading plans…</div>`;
    try {
      const data = await api("/admin/plans");
      const plans = data.plans || [];
      if (plans.length === 0) {
        host.innerHTML = emptyHTML("box", "No plans yet", "Run the bootstrap script to seed Starter / Pro / Agency / Enterprise.");
        return;
      }
      host.innerHTML = `
        <div class="card flush">
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Plan</th><th>Price (BDT/mo)</th><th>Trial days</th><th>Limits</th><th>Active</th><th class="right"></th></tr></thead>
            <tbody>
              ${plans.map((p) => `
                <tr data-plan="${escapeHtml(p.id)}">
                  <td>
                    <strong>${escapeHtml(p.displayName)}</strong>
                    <div class="slug">${escapeHtml(p.slug)}</div>
                  </td>
                  <td style="font-variant-numeric:tabular-nums;font-weight:600;">${escapeHtml(p.priceBdt)}</td>
                  <td>${p.trialDays}</td>
                  <td style="color:var(--text-dim);max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:11px;">
                    ${escapeHtml(formatLimits(p.limits))}
                  </td>
                  <td>${p.isActive ? '<span class="badge ok">active</span>' : '<span class="badge">inactive</span>'}</td>
                  <td class="right">
                    <button class="ghost btn-edit-plan" data-plan-id="${escapeHtml(p.id)}">${I.edit}<span>Edit</span></button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table></div>
        </div>
      `;
      $$("#billingBody .btn-edit-plan").forEach((btn) => {
        btn.onclick = () => openPlanEditModal(plans.find((p) => p.id === btn.dataset.planId));
      });
    } catch (e) {
      host.innerHTML = errorPanel(e.message);
    }
  }

  function formatLimits(limits) {
    if (!limits || typeof limits !== "object") return "—";
    const entries = Object.entries(limits);
    if (entries.length === 0) return "—";
    return entries.slice(0, 6).map(([k, v]) => `${k}=${v === -1 ? "∞" : v}`).join("  ");
  }

  function openPlanEditModal(plan) {
    if (!plan) return;
    const limitsJson = JSON.stringify(plan.limits ?? {}, null, 2);
    const flagsJson = JSON.stringify(plan.featureFlags ?? {}, null, 2);
    const body = el("div", { class: "form-grid" });
    body.innerHTML = `
      <div><label class="field">Display name</label><input name="displayName" value="${escapeHtml(plan.displayName)}" /></div>
      <div><label class="field">Price (BDT)</label><input name="priceBdt" inputmode="decimal" value="${escapeHtml(plan.priceBdt)}" /></div>
      <div><label class="field">Trial days</label><input name="trialDays" type="number" min="0" value="${plan.trialDays}" /></div>
      <div><label class="field">Active</label>
        <select name="isActive">
          <option value="true" ${plan.isActive ? "selected" : ""}>Yes</option>
          <option value="false" ${plan.isActive ? "" : "selected"}>No</option>
        </select>
      </div>
      <div class="full"><label class="field">Limits (JSON)</label><textarea name="limits" rows="8">${escapeHtml(limitsJson)}</textarea></div>
      <div class="full"><label class="field">Feature flags (JSON)</label><textarea name="featureFlags" rows="6">${escapeHtml(flagsJson)}</textarea></div>
    `;
    const cancel = el("button", { class: "ghost" }, "Cancel");
    const save = el("button", { class: "primary" }, "Save changes");
    const m = modal({ title: `Edit plan: ${plan.displayName}`, body, foot: [cancel, save], size: "lg" });
    cancel.onclick = m.close;
    save.onclick = async () => {
      const get = (k) => body.querySelector(`[name="${k}"]`).value;
      let limits, featureFlags;
      try { limits = JSON.parse(get("limits")); }
      catch { toast("Limits is not valid JSON", "err"); return; }
      try { featureFlags = JSON.parse(get("featureFlags")); }
      catch { toast("Feature flags is not valid JSON", "err"); return; }
      const patch = {
        displayName: get("displayName"),
        priceBdt: Number(get("priceBdt")),
        trialDays: Number(get("trialDays")),
        isActive: get("isActive") === "true",
        limits,
        featureFlags,
      };
      try {
        await api(`/admin/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        toast("Plan updated", "ok");
        m.close();
        renderPlans();
      } catch (e) {
        toast(e.message, "err");
      }
    };
  }

  async function renderPayments() {
    const host = $("#billingBody");
    host.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-mute);">Loading payments…</div>`;
    try {
      const data = await api("/admin/payments");
      const txns = data.payments || [];
      if (txns.length === 0) {
        host.innerHTML = emptyHTML("box", "No payments yet", "Subscription payments will land here once tenants pay through SSLCommerz.");
        return;
      }
      host.innerHTML = `
        <div class="card flush">
          <div class="table-wrap"><table class="tbl">
            <thead><tr>
              <th>Created</th><th>Tenant</th><th>Gateway</th><th>Status</th>
              <th class="right">Amount</th><th>Tran ID</th><th>Failures</th>
            </tr></thead>
            <tbody>
              ${txns.map((t) => `
                <tr>
                  <td style="color:var(--text-mute);">${escapeHtml(timeAgo(t.createdAt))}</td>
                  <td class="mono" style="font-size:11px;">${escapeHtml(t.tenantId.slice(0, 14))}…</td>
                  <td>${escapeHtml(t.gateway)}</td>
                  <td>${paymentBadge(t.status)}</td>
                  <td class="right" style="font-variant-numeric:tabular-nums;">${escapeHtml(t.amountBdt)} BDT</td>
                  <td class="mono" style="font-size:11px;">${t.sslcommerzTranId ? escapeHtml(t.sslcommerzTranId.slice(0, 16)) : "—"}</td>
                  <td style="color:var(--danger);">${t.failures.length > 0 ? t.failures.length : "—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table></div>
        </div>
      `;
    } catch (e) {
      host.innerHTML = errorPanel(e.message);
    }
  }

  async function openSubscriptionDetailModal(tenantId) {
    let detail;
    try {
      detail = await api(`/admin/subscriptions/${encodeURIComponent(tenantId)}`);
    } catch (e) {
      toast(e.message, "err");
      return;
    }
    const sub = detail.subscription;
    const usage = detail.usage || {};
    const limits = detail.planLimits || {};
    const overrides = detail.overrides || {};
    const pct = detail.percentageUsed || {};

    const limitRows = Object.keys(limits).map((k) => {
      const max = limits[k];
      const counterMap = { maxMonthlyMessages: "messages", maxAiTokensMonthly: "aiTokens", maxPostingPerDay: "posts" };
      const counterKey = counterMap[k];
      const current = counterKey ? (usage[counterKey] ?? 0) : null;
      const override = overrides[k];
      return `
        <tr>
          <td class="mono" style="font-size:11px;">${escapeHtml(k)}</td>
          <td>${typeof max === "boolean" ? (max ? "yes" : "no") : (max === -1 ? "∞" : escapeHtml(String(max)))}</td>
          <td style="color:var(--warn);">${override === undefined ? "—" : escapeHtml(String(override))}</td>
          <td>${current === null ? "—" : escapeHtml(String(current))}</td>
          <td>${pct[k] === null || pct[k] === undefined ? "—" : escapeHtml(pct[k] + "%")}</td>
        </tr>
      `;
    }).join("");

    const body = el("div", {});
    body.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
        <div><div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Tenant</div><div style="font-weight:600;">${escapeHtml(sub.tenantName)}</div></div>
        <div><div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Plan</div><div>${escapeHtml(sub.planName)} (${escapeHtml(sub.planSlug)}) — ${escapeHtml(sub.priceBdt)} BDT/mo</div></div>
        <div><div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Status</div>${subscriptionBadge(sub.status)}</div>
        <div><div class="label-caps" style="color:var(--text-mute);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Period end</div><div>${escapeHtml(formatDate(sub.currentPeriodEnd))}</div></div>
        ${sub.gracePeriodEndsAt ? `<div><div class="label-caps" style="color:var(--text-mute);font-size:10px;">Grace ends</div><div>${escapeHtml(formatDate(sub.gracePeriodEndsAt))}</div></div>` : ""}
        ${sub.cancelledAt ? `<div><div class="label-caps" style="color:var(--text-mute);font-size:10px;">Cancelled at</div><div>${escapeHtml(formatDate(sub.cancelledAt))}</div></div>` : ""}
      </div>

      <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mute);margin:20px 0 8px;">Limits + usage</h4>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Key</th><th>Plan max</th><th>Override</th><th>Current</th><th>Used</th></tr></thead>
        <tbody>${limitRows}</tbody>
      </table></div>

      <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-mute);margin:20px 0 8px;">Recent transitions</h4>
      <div style="max-height:200px;overflow:auto;font-size:11px;">
        ${detail.recentLogs.map((l) => `
          <div style="padding:6px 8px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;">
            <div><span class="mono">${escapeHtml(l.fromStatus ?? "—")} → ${escapeHtml(l.toStatus)}</span> · ${escapeHtml(l.reason)}</div>
            <div style="color:var(--text-mute);">${escapeHtml(timeAgo(l.createdAt))} · ${escapeHtml(l.actor)}</div>
          </div>
        `).join("") || "<div style=\"padding:8px;color:var(--text-mute);\">No transitions recorded.</div>"}
      </div>
    `;

    const suspendBtn = el("button", { class: "ghost" }, "Suspend");
    const reactivateBtn = el("button", { class: "ghost" }, "Reactivate");
    const cancelBtn = el("button", { class: "ghost" }, "Cancel");
    const planBtn = el("button", { class: "secondary" }, "Change plan");
    const overrideBtn = el("button", { class: "secondary" }, "Override limits");
    const closeBtn = el("button", { class: "primary" }, "Close");

    if (sub.status === "suspended") suspendBtn.disabled = true;
    if (sub.status !== "suspended" && sub.status !== "overdue") reactivateBtn.disabled = true;
    if (sub.status === "cancelled" || sub.status === "suspended") cancelBtn.disabled = true;

    const m = modal({
      title: `Subscription · ${sub.tenantName}`,
      body,
      foot: [suspendBtn, reactivateBtn, cancelBtn, planBtn, overrideBtn, closeBtn],
      size: "lg",
    });
    closeBtn.onclick = m.close;

    suspendBtn.onclick = () => promptReasonModal({
      title: "Suspend tenant",
      message: "All outbound messaging + posting will be paused. Data is preserved.",
      onConfirm: async (reason) => {
        await api(`/admin/subscriptions/${encodeURIComponent(tenantId)}/suspend`, {
          method: "POST", body: JSON.stringify({ reason }),
        });
        toast("Suspended", "ok");
        m.close();
        renderSubscriptions();
      },
    });
    reactivateBtn.onclick = () => promptReasonModal({
      title: "Reactivate tenant",
      message: "Outbound messaging + posting will resume within 5 minutes.",
      onConfirm: async (reason) => {
        await api(`/admin/subscriptions/${encodeURIComponent(tenantId)}/reactivate`, {
          method: "POST", body: JSON.stringify({ reason }),
        });
        toast("Reactivated", "ok");
        m.close();
        renderSubscriptions();
      },
    });
    cancelBtn.onclick = async () => {
      const ok = await confirmModal({
        title: "Cancel subscription",
        message: "Status stays Active until the period ends; only the cancellation date is set immediately.",
      });
      if (!ok) return;
      try {
        await api(`/admin/subscriptions/${encodeURIComponent(tenantId)}/cancel`, { method: "POST" });
        toast("Subscription cancelled (effective at period end)", "ok");
        m.close();
        renderSubscriptions();
      } catch (e) { toast(e.message, "err"); }
    };
    planBtn.onclick = async () => {
      let plansData;
      try { plansData = await api("/admin/plans"); }
      catch (e) { toast(e.message, "err"); return; }
      const pickerBody = el("div", {});
      pickerBody.innerHTML = `
        <p class="lede">Pick a new plan for ${escapeHtml(sub.tenantName)}. Period dates and status are preserved.</p>
        <select id="planPick" style="width:100%;margin-top:14px;">
          ${plansData.plans.map((p) => `<option value="${escapeHtml(p.slug)}" ${p.slug === sub.planSlug ? "selected" : ""}>${escapeHtml(p.displayName)} — ${escapeHtml(p.priceBdt)} BDT/mo</option>`).join("")}
        </select>
      `;
      const cb = el("button", { class: "ghost" }, "Cancel");
      const sb = el("button", { class: "primary" }, "Change plan");
      const pm = modal({ title: "Change plan", body: pickerBody, foot: [cb, sb] });
      cb.onclick = pm.close;
      sb.onclick = async () => {
        const newSlug = pickerBody.querySelector("#planPick").value;
        try {
          await api(`/admin/subscriptions/${encodeURIComponent(tenantId)}/change-plan`, {
            method: "POST", body: JSON.stringify({ planSlug: newSlug }),
          });
          toast("Plan changed", "ok");
          pm.close(); m.close(); renderSubscriptions();
        } catch (e) { toast(e.message, "err"); }
      };
    };
    overrideBtn.onclick = () => {
      const ovBody = el("div", {});
      const initial = JSON.stringify(overrides ?? {}, null, 2);
      ovBody.innerHTML = `
        <p class="lede">Per-tenant overrides take precedence over the plan's limits and feature flags.</p>
        <label class="field" style="margin-top:14px;">Overrides (JSON object)</label>
        <textarea id="ovJson" rows="10" style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(initial)}</textarea>
        <p style="font-size:11px;color:var(--text-mute);margin-top:6px;">Example: <code>{"maxProducts":2000,"feature.aiPosting":true}</code></p>
      `;
      const cb = el("button", { class: "ghost" }, "Cancel");
      const sb = el("button", { class: "primary" }, "Save overrides");
      const om = modal({ title: "Override plan limits", body: ovBody, foot: [cb, sb], size: "lg" });
      cb.onclick = om.close;
      sb.onclick = async () => {
        let parsed;
        try { parsed = JSON.parse(ovBody.querySelector("#ovJson").value); }
        catch { toast("Overrides is not valid JSON", "err"); return; }
        try {
          await api(`/admin/subscriptions/${encodeURIComponent(tenantId)}/override-limits`, {
            method: "POST", body: JSON.stringify({ overrides: parsed }),
          });
          toast("Overrides saved", "ok");
          om.close(); m.close(); openSubscriptionDetailModal(tenantId);
        } catch (e) { toast(e.message, "err"); }
      };
    };
  }

  function promptReasonModal({ title, message, onConfirm }) {
    const body = el("div", {});
    body.innerHTML = `
      <p class="lede">${escapeHtml(message)}</p>
      <label class="field" style="margin-top:12px;">Reason (recorded in audit log)</label>
      <textarea id="reasonInput" rows="3" placeholder="e.g. Manual reactivation - paid out-of-band"></textarea>
    `;
    const cancel = el("button", { class: "ghost" }, "Cancel");
    const ok = el("button", { class: "primary" }, "Confirm");
    const m = modal({ title, body, foot: [cancel, ok] });
    cancel.onclick = m.close;
    ok.onclick = async () => {
      const reason = body.querySelector("#reasonInput").value.trim();
      if (!reason) { toast("Reason is required", "err"); return; }
      try {
        await onConfirm(reason);
      } catch (e) { toast(e.message, "err"); }
    };
  }

  function subscriptionBadge(status) {
    const map = {
      trial: "info", active: "ok", overdue: "warn", suspended: "danger", cancelled: "violet",
    };
    const cls = map[status] || "";
    return `<span class="badge ${cls}">${escapeHtml(status || "—")}</span>`;
  }
  function paymentBadge(status) {
    if (!status) return '<span style="color:var(--text-mute);">—</span>';
    const map = { success: "ok", pending: "warn", failed: "danger" };
    return `<span class="badge ${map[status] || ""}">${escapeHtml(status)}</span>`;
  }
  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString();
  }

  // -------------------- Billing → Gateway tab ----------------------------
  /**
   * Platform-billing SSLCommerz credentials editor. This is the store the
   * SaaS operator uses to charge tenants for the subscription itself —
   * NOT the per-tenant SSLCommerz store the tenant uses to take payments
   * from their own customers (those live on tenant.settings.sslcommerz
   * and are edited per tenant in Settings → Payments).
   */
  async function renderGateway() {
    const host = $("#billingBody");
    host.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-mute);">Loading gateway…</div>`;
    let data;
    try {
      data = await api("/admin/platform/gateway");
    } catch (e) {
      host.innerHTML = errorPanel(e.message);
      return;
    }
    const c = data.creds || {};
    const sourceLabel = {
      db: "saved (database)",
      env: "from environment variable",
      fallback: "tenant-customer fallback (dev only)",
      none: "not configured",
    }[c.source] || c.source;
    host.innerHTML = `
      <div class="card" style="max-width:720px;">
        <h2 style="margin:0 0 8px;font-size:16px;font-weight:600;">Platform-billing SSLCommerz</h2>
        <p class="lede" style="margin-bottom:16px;">
          The store the SaaS platform uses to charge tenants for their subscription.
          This is separate from the per-tenant SSLCommerz store your clients use to take
          payments from their own customers — those are configured per tenant in
          Settings → Payments.
        </p>
        <p class="lede" style="margin-bottom:18px;font-size:12px;">
          Current source: <strong>${escapeHtml(sourceLabel)}</strong>
          ${c.hasStorePassword ? '· <span class="badge ok">secret set</span>' : '· <span class="badge warn">no secret</span>'}
        </p>
        <form id="gatewayForm" class="form-grid">
          <div>
            <label class="field">Store ID</label>
            <input name="storeId" required value="${escapeHtml(c.storeId || "")}" placeholder="your_sslcz_store_id" />
          </div>
          <div>
            <label class="field">Environment</label>
            <select name="isSandbox">
              <option value="true" ${c.isSandbox ? "selected" : ""}>Sandbox (test)</option>
              <option value="false" ${c.isSandbox ? "" : "selected"}>Live (production)</option>
            </select>
          </div>
          <div class="full">
            <label class="field">Store Password / Secret</label>
            <input name="storePassword" type="password" autocomplete="off" placeholder="${c.hasStorePassword ? "leave blank to keep existing" : "paste your sslcommerz store password"}" />
            <p style="font-size:11px;color:var(--text-mute);margin-top:6px;">
              Stored encrypted at rest. Never returned in API responses.
            </p>
          </div>
          <div class="full" style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px;">
            <button type="button" class="ghost" id="testGateway">Test connection</button>
            <button type="submit" class="primary">Save credentials</button>
          </div>
        </form>
        <div id="gatewayResult" style="margin-top:18px;"></div>
      </div>
    `;
    const form = $("#gatewayForm");
    const resultHost = $("#gatewayResult");
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const body = {
        storeId: fd.get("storeId") || "",
        storePassword: fd.get("storePassword") || null,
        isSandbox: fd.get("isSandbox") === "true",
      };
      try {
        await api("/admin/platform/gateway", { method: "POST", body: JSON.stringify(body) });
        toast("Credentials saved", "ok");
        renderGateway();
      } catch (e) {
        toast(e.message, "err");
      }
    };
    $("#testGateway").onclick = async () => {
      resultHost.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--text-mute);font-size:12px;"><div class="skeleton" style="height:12px;width:12px;border-radius:50%;"></div>Testing…</div>`;
      try {
        const r = await api("/admin/platform/gateway/test", { method: "POST" });
        if (r.ok) {
          resultHost.innerHTML = `<div class="card" style="border-color:rgba(74,222,128,0.3);background:rgba(74,222,128,0.05);">
            <strong style="color:var(--ok);">SSLCommerz accepted these credentials.</strong>
            <div style="font-size:12px;color:var(--text-dim);margin-top:6px;">
              Environment: ${escapeHtml(r.environment)} · Status: ${escapeHtml(r.status)}
            </div>
          </div>`;
        } else {
          resultHost.innerHTML = `<div class="card" style="border-color:rgba(248,113,113,0.3);background:rgba(248,113,113,0.05);">
            <strong style="color:var(--danger);">Test failed</strong>
            <div style="font-size:12px;color:var(--text-dim);margin-top:6px;">
              ${escapeHtml(r.error || "unknown error")} ${r.environment ? "· " + escapeHtml(r.environment) : ""}
            </div>
          </div>`;
        }
      } catch (e) {
        resultHost.innerHTML = `<div class="card" style="border-color:rgba(248,113,113,0.3);background:rgba(248,113,113,0.05);">
          <strong style="color:var(--danger);">Test failed</strong>
          <div style="font-size:12px;color:var(--text-dim);margin-top:6px;">${escapeHtml(e.message)}</div>
        </div>`;
      }
    };
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

  /**
   * Show / hide the "Active schema" banner. Called from the client detail
   * page once we've loaded the tenant row. The banner is purely
   * informational — it surfaces the Commerce_OS category schema slug so
   * operators can confirm which schema drives the AI / dashboard /
   * order pipeline for the tenant they're looking at. Hides whenever
   * we're not on a tenant-scoped page.
   */
  function setSchemaBanner(tenant) {
    const banner = $("#schemaBanner");
    if (!banner) return;
    if (!tenant || (!tenant.categorySchemaSlug && !tenant.businessCategory)) {
      banner.hidden = true;
      return;
    }
    const slug = tenant.categorySchemaSlug || tenant.businessCategory || "—";
    const meta = [];
    if (tenant.businessCategory && tenant.businessCategory !== slug) {
      meta.push(`category: ${tenant.businessCategory}`);
    }
    if (tenant.businessSubcategory) meta.push(`subcategory: ${tenant.businessSubcategory}`);
    $("#schemaBannerSlug").textContent = slug;
    $("#schemaBannerMeta").textContent = meta.length ? `· ${meta.join(" · ")}` : "";
    banner.hidden = false;
  }
  function clearSchemaBanner() {
    const banner = $("#schemaBanner");
    if (banner) banner.hidden = true;
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
    // Default: hide the per-tenant schema banner. The client-detail page
    // re-shows it after loading the tenant row.
    clearSchemaBanner();
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
    if (head === "billing") {
      setActiveNav("billing");
      return pageBilling(params);
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
