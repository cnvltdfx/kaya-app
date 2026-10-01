/* Kool Kaya Kitchen — staff back office (dashboard, orders, inventory, promotions, reports, monitoring). */
(() => {
  'use strict';
  const FLAGS = { SG: '🇸🇬', MY: '🇲🇾', TH: '🇹🇭', HK: '🇭🇰' };
  let refreshTimer = null;

  const TABS = [
    ['dashboard', 'Dashboard'], ['orders', 'Orders'], ['products', 'Products & stock'], ['promotions', 'Promotions'],
    ['reports', 'Reports (S3)'], ['monitoring', 'Monitoring'], ['outbox', 'Notifications'], ['audit', 'Audit log'],
  ];

  async function render(app, tab, q) {
    const { S, esc } = window.KK;
    clearInterval(refreshTimer);
    app.innerHTML = `
      <div class="admin-head"><h1 style="margin:0">Back office</h1><span class="muted small">Signed in as ${esc(S.user.name)} · <span class="pill pill-green">${esc(S.user.role)}</span> · MFA ✓</span></div>
      <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/admin/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <div id="admin-body"></div>`;
    const body = document.getElementById('admin-body');
    const views = { dashboard, orders, products, promotions, reports, monitoring, outbox, audit };
    await (views[tab] || dashboard)(body, q);
  }

  const sgd = (n) => window.KK.money(n, 'SGD');

  // ---------- Dashboard ----------
  async function dashboard(el, q) {
    const { api, esc, statusPill } = window.KK;
    const days = Number(q.get('days')) || 30;
    const d = await api('GET', `/api/admin/dashboard?days=${days}`);
    const totalRev = Object.values(d.byMarket).reduce((s, m) => s + m.revenueSgd, 0) || 1;
    const maxMarket = Math.max(...Object.values(d.byMarket).map((m) => m.revenueSgd), 1);
    el.innerHTML = `
      <div class="filter-row"><span class="muted small">Period</span>${[7, 30, 90].map((n) => `<a class="btn btn-sm ${n === days ? 'btn-brown' : 'btn-ghost'}" href="#/admin/dashboard?days=${n}">Last ${n} days</a>`).join('')}</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Revenue</div><div class="value">${sgd(d.revenueSgd)}</div><div class="sub">Paid orders, last ${days} days</div></div>
        <div class="kpi"><div class="label">Orders</div><div class="value">${d.orders}</div><div class="sub">${(d.orders / days).toFixed(1)} per day</div></div>
        <div class="kpi"><div class="label">Avg order value</div><div class="value">${sgd(d.aovSgd)}</div><div class="sub">All markets, in SGD</div></div>
        <div class="kpi"><div class="label">Customers</div><div class="value">${d.customers}</div><div class="sub">Registered accounts</div></div>
      </div>
      <div class="admin-grid">
        <div class="card"><h3>Daily revenue (SGD)</h3>${barChart(d.series)}
          <details style="margin-top:10px"><summary class="small muted">View as table</summary><div class="table-wrap"><table class="simple"><thead><tr><th>Date</th><th>Revenue (SGD)</th></tr></thead><tbody>${d.series.map((s) => `<tr><td>${s.date}</td><td>${sgd(s.revenueSgd)}</td></tr>`).join('')}</tbody></table></div></details>
        </div>
        <div class="card"><h3>Revenue by market</h3>
          ${Object.entries(d.byMarket).map(([k, m]) => `<div class="hbar" title="${m.orders} orders"><div class="hbar-top"><span>${FLAGS[k]} ${k} <span class="muted small">· ${((m.revenueSgd / totalRev) * 100).toFixed(0)}% · ${m.orders} orders</span></span><span class="val">${sgd(m.revenueSgd)}</span></div><div class="track"><div class="fill" style="width:${(m.revenueSgd / maxMarket) * 100}%"></div></div></div>`).join('')}
          <p class="muted small">Target mix: ~80% Singapore, remainder split across MY / TH / HK.</p>
        </div>
      </div>
      <div class="admin-grid" style="grid-template-columns:1fr 1fr 1fr">
        <div class="card"><h3>Top products</h3><table class="simple"><tbody>${d.topProducts.map((p, i) => `<tr><td>${i + 1}. ${esc(p.name)}</td><td style="text-align:right"><strong>${p.units}</strong> units</td></tr>`).join('')}</tbody></table></div>
        <div class="card"><h3>Low stock</h3>${d.lowStock.length ? `<table class="simple"><tbody>${d.lowStock.map((p) => `<tr><td>${esc(p.name)}</td><td style="text-align:right"><span class="status-dot ${p.stock === 0 ? 'bad-c' : 'warn-c'}">${p.stock === 0 ? 'Out' : p.stock + ' left'}</span></td></tr>`).join('')}</tbody></table><a class="btn btn-ghost btn-sm" href="#/admin/products">Restock →</a>` : '<p class="status-dot ok-c">All products well stocked</p>'}</div>
        <div class="card"><h3>Orders by status</h3><table class="simple"><tbody>${Object.entries(d.statusCounts).map(([s, n]) => `<tr><td>${statusPill(s)}</td><td style="text-align:right"><a href="#/admin/orders?status=${s}">${n}</a></td></tr>`).join('')}</tbody></table></div>
      </div>`;
    wireChart(el);
  }

  function barChart(series) {
    const W = 760, H = 220, padL = 52, padB = 26, padT = 10;
    const max = Math.max(...series.map((s) => s.revenueSgd), 1);
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
    const nice = step * 4;
    const plotW = W - padL - 6, plotH = H - padB - padT;
    const slot = plotW / series.length;
    const gap = 2;
    const bw = Math.max(1, slot - gap);
    const r = Math.min(4, bw / 2);
    const y = (v) => padT + plotH - (v / nice) * plotH;
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i;
      grid += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}</text>`;
    }
    const every = Math.ceil(series.length / 8);
    let bars = '';
    series.forEach((s, i) => {
      const x = padL + i * slot + gap / 2;
      const top = y(s.revenueSgd);
      const h = padT + plotH - top;
      const path = h > 0 ? `M${x},${padT + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${padT + plotH} Z` : '';
      bars += `<g><rect class="hit" x="${x - gap / 2}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent" data-tip="${s.date}: S$${s.revenueSgd.toFixed(2)}"/>${path ? `<path class="bar" d="${path}" pointer-events="none"/>` : ''}</g>`;
      if (i % every === 0) bars += `<text class="axis-label" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${s.date.slice(5)}</text>`;
    });
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily revenue bar chart">${grid}${bars}</svg><div class="chart-tip"></div></div>`;
  }

  function wireChart(root) {
    root.querySelectorAll('.chart').forEach((chart) => {
      const tip = chart.querySelector('.chart-tip');
      chart.addEventListener('mousemove', (e) => {
        const hit = e.target.closest('[data-tip]');
        if (!hit) { tip.style.opacity = 0; return; }
        const box = chart.getBoundingClientRect();
        const hb = hit.getBoundingClientRect();
        tip.textContent = hit.dataset.tip;
        tip.style.left = `${hb.left - box.left + hb.width / 2}px`;
        tip.style.top = `${e.clientY - box.top}px`;
        tip.style.opacity = 1;
        chart.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
      });
      chart.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
    });
  }

  // ---------- Orders ----------
  async function orders(el, q) {
    const { api, esc, fmtDate, statusPill, toast, S } = window.KK;
    const params = new URLSearchParams();
    for (const k of ['status', 'market', 'q']) if (q.get(k)) params.set(k, q.get(k));
    const d = await api('GET', `/api/admin/orders?${params}`);
    const statuses = Object.keys(d.transitions);
    el.innerHTML = `
      <form class="filter-row" id="order-filter">
        <select name="status"><option value="">All statuses</option>${statuses.map((s) => `<option value="${s}" ${q.get('status') === s ? 'selected' : ''}>${esc(window.KK.t('status_' + s))}</option>`).join('')}</select>
        <select name="market"><option value="">All markets</option>${Object.keys(FLAGS).map((m) => `<option value="${m}" ${q.get('market') === m ? 'selected' : ''}>${FLAGS[m]} ${m}</option>`).join('')}</select>
        <input name="q" placeholder="Order ID or email" value="${esc(q.get('q') || '')}">
        <button class="btn btn-brown btn-sm">Filter</button><span class="muted small">${d.total} orders</span>
      </form>
      <div class="card table-wrap"><table class="simple">
        <thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>Market</th><th>Fulfilment</th><th>Total</th><th>Status</th><th>Update</th></tr></thead>
        <tbody>${d.orders.map((o) => `<tr>
          <td><a href="#/order/${esc(o.id)}" class="mono">${esc(o.id)}</a></td>
          <td class="small">${fmtDate(o.createdAt, { dateStyle: 'short', timeStyle: 'short' }, S.config.markets[o.market].timeZone)}</td>
          <td class="small">${esc(o.email)}</td><td>${FLAGS[o.market]} ${o.market}</td>
          <td class="small">${o.fulfilment === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}</td>
          <td><strong>${window.KK.money(o.total, o.currency)}</strong></td><td>${statusPill(o.status)}</td>
          <td>${d.transitions[o.status].filter((n) => (o.fulfilment === 'pickup' ? n !== 'shipped' : n !== 'ready_for_pickup')).length ? `<select data-order="${esc(o.id)}" aria-label="Update status"><option value="">Move to…</option>${d.transitions[o.status].filter((n) => (o.fulfilment === 'pickup' ? n !== 'shipped' : n !== 'ready_for_pickup')).map((n) => `<option value="${n}">${esc(window.KK.t('status_' + n))}</option>`).join('')}</select>` : '<span class="muted small">—</span>'}</td>
        </tr>`).join('')}</tbody></table></div>`;
    document.getElementById('order-filter').onsubmit = (e) => {
      e.preventDefault();
      const p = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v));
      location.hash = `#/admin/orders?${p}`;
    };
    el.querySelectorAll('[data-order]').forEach((s) => (s.onchange = async () => {
      if (!s.value) return;
      if (s.value === 'cancelled' && !confirm('Cancel this order and refund the customer?')) { s.value = ''; return; }
      try {
        await api('PUT', `/api/admin/orders/${s.dataset.order}/status`, { status: s.value });
        toast(`Order ${s.dataset.order} updated — customer notified`, 'ok');
        orders(el, q);
      } catch (e) { toast(e.message, 'error'); s.value = ''; }
    }));
  }

  // ---------- Products ----------
  async function products(el) {
    const { api, esc, toast } = window.KK;
    const d = await api('GET', '/api/admin/products');
    el.innerHTML = `
      <div class="card table-wrap" style="margin-bottom:18px"><table class="simple">
        <thead><tr><th>Product</th><th>Category</th><th>Price (SGD)</th><th>Sale %</th><th>Stock</th><th>Featured</th><th>Active</th><th></th></tr></thead>
        <tbody>${d.products.map((p) => `<tr data-row="${esc(p.id)}">
          <td><strong>${esc(p.name)}</strong><div class="muted small">${esc(p.size)} · ${p.rating ? '★ ' + p.rating : 'no reviews'}</div></td>
          <td class="small">${esc(d.categories.find((c) => c.id === p.category)?.name)}</td>
          <td><input class="inline-input" type="number" step="0.01" min="0.01" name="price" value="${p.price}" aria-label="Price"></td>
          <td><input class="inline-input" type="number" min="0" max="89" name="salePct" value="${p.salePct}" aria-label="Sale percent"></td>
          <td><input class="inline-input" type="number" min="0" name="stock" value="${p.stock}" aria-label="Stock"> ${p.stock === 0 ? '<span class="status-dot bad-c">Out</span>' : p.lowStock ? '<span class="status-dot warn-c">Low</span>' : ''}</td>
          <td><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''} aria-label="Featured"></td>
          <td><input type="checkbox" name="active" ${p.active ? 'checked' : ''} aria-label="Active"></td>
          <td><button class="btn btn-brown btn-sm" data-save="${esc(p.id)}">Save</button></td>
        </tr>`).join('')}</tbody></table></div>
      <form class="card" id="new-product" style="max-width:760px"><h3>Add a product</h3>
        <div class="row"><label class="field"><span>Name</span><input type="text" name="name" required></label><label class="field"><span>Size</span><input type="text" name="size" value="250g"></label></div>
        <div class="row"><label class="field"><span>Category</span><select name="category">${d.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Price (SGD)</span><input type="number" step="0.01" min="0.01" name="price" required></label><label class="field"><span>Opening stock</span><input type="number" min="0" name="stock" value="0"></label></div>
        <label class="field"><span>Description</span><textarea name="description" rows="2"></textarea></label>
        <button class="btn btn-primary">Add product</button>
      </form>`;
    el.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
      const row = el.querySelector(`[data-row="${b.dataset.save}"]`);
      const v = (n) => row.querySelector(`[name=${n}]`);
      try {
        await api('PUT', `/api/admin/products/${b.dataset.save}`, { price: v('price').value, salePct: v('salePct').value, stock: Number(v('stock').value), featured: v('featured').checked, active: v('active').checked });
        toast('Product saved', 'ok');
        products(el);
      } catch (e) { toast(e.message, 'error'); }
    }));
    document.getElementById('new-product').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api('POST', '/api/admin/products', { ...f, stock: Number(f.stock) }); toast('Product added', 'ok'); products(el); } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ---------- Promotions ----------
  async function promotions(el) {
    const { api, esc, toast } = window.KK;
    const d = await api('GET', '/api/admin/promotions');
    el.innerHTML = `
      <div class="card table-wrap" style="margin-bottom:18px"><table class="simple">
        <thead><tr><th>Code</th><th>Description</th><th>Type</th><th>Min spend</th><th>Active</th></tr></thead>
        <tbody>${d.promotions.map((p) => `<tr><td class="mono"><strong>${esc(p.code)}</strong></td><td>${esc(p.description)}</td><td>${p.type === 'percent' ? p.value + '% off' : 'Free shipping'}${p.firstOrderOnly ? ' · first order' : ''}</td><td>${p.minSpend ? sgd(p.minSpend) : '—'}</td>
          <td><label class="check"><input type="checkbox" data-promo="${esc(p.id)}" ${p.active ? 'checked' : ''}> ${p.active ? 'Live' : 'Off'}</label></td></tr>`).join('')}</tbody></table></div>
      <form class="card" id="new-promo" style="max-width:760px"><h3>Create campaign code</h3>
        <p class="muted small">Tip: before a scheduled campaign (e.g. 11.11), pre-scale capacity — see README → Scalability.</p>
        <div class="row"><label class="field"><span>Code</span><input type="text" name="code" placeholder="CNY2027" required></label>
          <label class="field"><span>Type</span><select name="type"><option value="percent">% off</option><option value="shipping">Free shipping</option></select></label>
          <label class="field"><span>Value (%)</span><input type="number" name="value" min="1" max="50" value="10"></label>
          <label class="field"><span>Min spend (SGD)</span><input type="number" name="minSpend" min="0" value="0"></label></div>
        <label class="field"><span>Description</span><input type="text" name="description" placeholder="Lunar New Year: 10% off"></label>
        <button class="btn btn-primary">Create</button>
      </form>`;
    el.querySelectorAll('[data-promo]').forEach((c) => (c.onchange = async () => {
      try { await api('PUT', `/api/admin/promotions/${c.dataset.promo}`, { active: c.checked }); toast('Promotion updated', 'ok'); promotions(el); } catch (e) { toast(e.message, 'error'); }
    }));
    document.getElementById('new-promo').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/admin/promotions', Object.fromEntries(new FormData(e.target))); toast('Promotion created', 'ok'); promotions(el); } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ---------- Reports ----------
  async function reports(el) {
    const { api, esc, fmtDate, toast, S } = window.KK;
    const d = await api('GET', '/api/admin/reports');
    el.innerHTML = `
      <div class="card" style="margin-bottom:18px">
        <h3>Generate a report</h3>
        <p class="muted small">Reports are written as CSV + JSON summary to <span class="mono">${esc(d.destination)}</span>. A daily sales & inventory report is also generated automatically at 00:05 SGT.</p>
        <div class="filter-row">
          <select id="rpt-days" aria-label="Period"><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>
          <button class="btn btn-primary btn-sm" data-run="sales">Run sales report</button>
          <button class="btn btn-ghost btn-sm" data-run="inventory">Run inventory report</button>
        </div>
      </div>
      <div class="card table-wrap"><table class="simple">
        <thead><tr><th>Generated</th><th>Type</th><th>Trigger</th><th>Summary</th><th>Location</th><th></th></tr></thead>
        <tbody>${d.reports.length ? d.reports.map((r) => `<tr>
          <td class="small">${fmtDate(r.createdAt, undefined, 'Asia/Singapore')}</td>
          <td><span class="pill ${r.type === 'sales' ? 'pill-gold' : 'pill-green'}">${esc(r.type)}</span>${r.days ? `<div class="muted small">${r.days}d</div>` : ''}</td>
          <td class="small">${esc(r.trigger)}${r.by ? `<div class="muted">${esc(r.by)}</div>` : ''}</td>
          <td class="small">${r.type === 'sales' ? `${r.summary.orders} orders · ${sgd(r.summary.revenueSgd)}` : `${r.summary.unitsOnHand} units · ${r.summary.lowStock} low · ${r.summary.outOfStock} out`}</td>
          <td class="mono" style="word-break:break-all">${esc(r.location)}</td>
          <td><button class="btn btn-ghost btn-sm" data-dl="${esc(r.id)}">CSV</button></td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted">No reports yet — run one above.</td></tr>'}</tbody></table></div>`;
    el.querySelectorAll('[data-run]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('POST', '/api/admin/reports', { type: b.dataset.run, days: document.getElementById('rpt-days').value });
        toast(`Report pushed to ${r.report.location}`, 'ok');
        reports(el);
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }));
    el.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = async () => {
      try {
        const res = await fetch(`/api/admin/reports/${b.dataset.dl}/download`, { headers: { authorization: `Bearer ${S.token}` } });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        const name = (res.headers.get('content-disposition') || '').match(/filename="(.+)"/)?.[1] || 'report.csv';
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { toast(e.message, 'error'); }
    }));
  }

  // ---------- Monitoring ----------
  async function monitoring(el) {
    const { api, esc, toast } = window.KK;
    const draw = async () => {
      if (!el.isConnected) { clearInterval(refreshTimer); return; }
      const m = await api('GET', '/api/admin/metrics');
      const pctFmt = (x) => (x * 100).toFixed(2) + '%';
      const health = (s) => (s.requests === 0 ? '<span class="muted small">no traffic</span>' : s.errorRate > m.slo.errorRate || s.p95 > m.slo.p95LatencyMs ? '<span class="status-dot bad-c">Breaching SLO</span>' : '<span class="status-dot ok-c">Healthy</span>');
      const rows = (obj, label) => Object.entries(obj).sort((a, b) => b[1].requests - a[1].requests).map(([k, s]) => `<tr><td>${label(k)}</td><td>${s.requests}</td><td>${s.p50} ms</td><td>${s.p95} ms</td><td>${pctFmt(s.errorRate)}</td><td>${health(s)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No requests yet in this window.</td></tr>';
      el.innerHTML = `
        <div class="filter-row"><span class="muted small">Live · last ${m.windowMinutes} min · refreshes every 5s · uptime ${Math.floor(m.uptimeSec / 60)} min · ${m.memoryMb} MB RSS</span>
          <button class="btn btn-ghost btn-sm" id="gen-traffic">Generate test traffic</button></div>
        <div class="kpis">
          <div class="kpi"><div class="label">Requests</div><div class="value">${m.overall.requests}</div><div class="sub">in window</div></div>
          <div class="kpi"><div class="label">p95 latency</div><div class="value">${m.overall.p95} ms</div><div class="sub">SLO ≤ ${m.slo.p95LatencyMs} ms</div></div>
          <div class="kpi"><div class="label">Error rate (5xx)</div><div class="value">${pctFmt(m.overall.errorRate)}</div><div class="sub">SLO ≤ ${pctFmt(m.slo.errorRate)}</div></div>
          <div class="kpi"><div class="label">Active alerts</div><div class="value ${m.activeAlerts.length ? 'bad-c' : 'ok-c'}">${m.activeAlerts.length}</div><div class="sub">${m.activeAlerts.map((a) => esc(a.name)).join(', ') || 'All clear'}</div></div>
        </div>
        <div class="admin-grid" style="grid-template-columns:1fr 1fr">
          <div class="card table-wrap"><h3>Per service</h3><table class="simple"><thead><tr><th>Service</th><th>Req</th><th>p50</th><th>p95</th><th>Errors</th><th>Health</th></tr></thead><tbody>${rows(m.byService, (k) => `<span class="mono">${esc(k)}</span>`)}</tbody></table></div>
          <div class="card table-wrap"><h3>Per market</h3><table class="simple"><thead><tr><th>Market</th><th>Req</th><th>p50</th><th>p95</th><th>Errors</th><th>Health</th></tr></thead><tbody>${rows(m.byMarket, (k) => `${FLAGS[k] || ''} ${esc(k)}`)}</tbody></table></div>
        </div>
        <div class="card"><h3>Alert history</h3>${m.recentAlerts.length ? `<table class="simple"><tbody>${m.recentAlerts.map((a) => `<tr><td class="small">${new Date(a.t).toLocaleTimeString()}</td><td><span class="status-dot warn-c">${esc(a.name)}</span></td><td class="small">${esc(a.detail)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No alerts fired. Alerts trigger on p95 latency / error-rate SLO breaches, low stock and report upload failures (→ CloudWatch Alarms + SNS in AWS).</p>'}</div>`;
      document.getElementById('gen-traffic').onclick = async () => {
        const markets = ['SG', 'SG', 'SG', 'SG', 'SG', 'SG', 'SG', 'SG', 'MY', 'TH', 'HK'];
        const paths = ['/api/catalog/products', '/api/catalog/products?q=pandan', '/api/catalog/products/classic-pandan', '/api/catalog/promotions', '/api/catalog/recommendations'];
        await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(paths[i % paths.length], { headers: { 'x-market': markets[i % markets.length] } })));
        toast('Sent 60 requests across markets', 'ok');
        draw();
      };
    };
    await draw();
    refreshTimer = setInterval(() => draw().catch(() => clearInterval(refreshTimer)), 5000);
  }

  // ---------- Outbox ----------
  async function outbox(el) {
    const { api, esc, fmtDate } = window.KK;
    const d = await api('GET', '/api/admin/notifications');
    el.innerHTML = `<div class="card"><p class="muted small">Every email and SMS the system sends. Locally they're stored here; in production they are delivered via Amazon SES (email) and Amazon SNS (SMS).</p>
      ${d.notifications.length ? d.notifications.map((n) => `<div class="notif"><span class="ch ${n.channel === 'sms' ? 'warn-c' : 'ok-c'}">${esc(n.channel)}</span> → <span class="mono">${esc(n.to)}</span> <span class="pill pill-grey">${esc(n.kind)}</span> <span class="muted small">${fmtDate(n.createdAt)}</span><div><strong>${esc(n.subject)}</strong></div><div class="small">${esc(n.body)}</div></div>`).join('') : '<p class="muted">Nothing sent yet.</p>'}</div>`;
  }

  // ---------- Audit ----------
  async function audit(el) {
    const { api, esc, fmtDate } = window.KK;
    const d = await api('GET', '/api/admin/audit');
    el.innerHTML = `<div class="card table-wrap"><table class="simple"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>${d.entries.map((e) => `<tr><td class="small">${fmtDate(e.at)}</td><td class="small">${esc(e.email || e.userId)}</td><td class="mono">${esc(e.action)}</td><td class="mono small">${esc(JSON.stringify(e.meta || {}))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No entries.</td></tr>'}</tbody></table></div>`;
  }

  window.KKAdmin = { render };
})();
