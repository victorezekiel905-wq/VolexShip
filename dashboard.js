/* VeloxShip — Customer Dashboard Logic */
let dashboardUser = null;

/* ── Stats ── */
function renderDashboardStats(shipments) {
  const el = id => document.getElementById(id);
  el('statTotal').textContent     = shipments.length;
  el('statTransit').textContent   = shipments.filter(s => ['in_transit','customs','out_for_delivery'].includes(s.status)).length;
  el('statPaused').textContent    = shipments.filter(s => s.status === 'paused').length;
  el('statDelivered').textContent = shipments.filter(s => s.status === 'delivered').length;
}

/* ── Profile card ── */
function renderProfileCard(user) {
  const host = document.getElementById('profileHost');
  if (!host) return;
  host.innerHTML = `
    <article class="dashboard-card profile-card reveal visible">
      <div class="card-title-row">
        <div class="profile-avatar-wrap">
          <div class="avatar-lg"><i class="fa-solid fa-user"></i></div>
          <div>
            <h3>${user.name}</h3>
            <p>${user.email}</p>
          </div>
        </div>
      </div>
      <div class="shipment-meta-grid profile-grid">
        <div><label>Full name</label><strong>${user.name}</strong></div>
        <div><label>Email address</label><strong>${user.email}</strong></div>
        <div><label>Phone</label><strong>${user.phone || 'Not added'}</strong></div>
        <div><label>Company</label><strong>${user.company || 'Personal account'}</strong></div>
        <div><label>Delivery address</label><strong>${user.address || '—'}</strong></div>
        <div><label>Member since</label><strong>${formatDate(user.createdAt)}</strong></div>
      </div>
    </article>`;
}

/* ── Messages ── */
function renderMessages(user) {
  const host = document.getElementById('messagesHost');
  if (!host) return;
  const messages = getMessagesForUser(user.email);
  const unread   = messages.filter(m => !m.readBy.includes(user.email.toLowerCase())).length;

  const hdr = document.getElementById('msgBadge');
  if (hdr) hdr.textContent = unread > 0 ? `(${unread} new)` : '';

  if (!messages.length) {
    host.innerHTML = '<div class="empty-state"><div class="icon-pill"><i class="fa-solid fa-envelope-open"></i></div><p>No messages yet.</p></div>';
    return;
  }
  host.innerHTML = messages.map(m => {
    const isUnread = !m.readBy.includes(user.email.toLowerCase());
    return `
      <article class="message-card ${isUnread ? 'unread' : ''}" data-msg-id="${m.id}">
        <div class="message-header">
          <div>
            ${isUnread ? '<span class="msg-dot"></span>' : ''}
            <strong class="message-subject">${m.subject}</strong>
          </div>
          <span class="message-date">${formatDateTime(m.createdAt)}</span>
        </div>
        <p class="message-body">${m.body}</p>
        ${isUnread ? `<button class="btn btn-secondary btn-sm mark-read-btn" data-msg-id="${m.id}">Mark as read</button>` : '<span class="read-tag"><i class="fa-solid fa-check-double"></i> Read</span>'}
      </article>`;
  }).join('');

  host.querySelectorAll('.mark-read-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      markMessageRead(btn.dataset.msgId, user.email);
      renderMessages(user);
    });
  });
}

/* ── Expected products ── */
function renderExpectedProducts(shipments) {
  const host = document.getElementById('expectedProducts');
  if (!host) return;
  if (!shipments.length) {
    host.innerHTML = `
      <div class="empty-state">
        <div class="icon-pill"><i class="fa-solid fa-box-open"></i></div>
        <h3>No shipments yet</h3>
        <p>Once operations assigns a shipment to your email or you confirm a tracking code below, your products will appear here.</p>
      </div>`;
    return;
  }
  host.innerHTML = shipments.map(s => shipmentCardMarkup(s)).join('');
  bindShipmentViewers(host);
  refreshLiveTelemetry(host);
}

/* ── Timeline feed ── */
function renderRecentTimeline(shipments) {
  const host = document.getElementById('recentTimeline');
  if (!host) return;
  const events = shipments
    .flatMap(s => (s.history || []).map(e => ({ ...e, trackingCode: s.trackingCode, productName: s.productName })))
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 10);

  if (!events.length) {
    host.innerHTML = '<div class="empty-state"><p>No movement history yet.</p></div>';
    return;
  }
  host.innerHTML = events.map(e => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-body">
        <strong><span>${e.productName} · ${e.title}</span><span>${formatDateTime(e.time)}</span></strong>
        <span>${e.location} · ${e.detail} · <code>${e.trackingCode}</code></span>
      </div>
    </div>`).join('');
}

/* ── Claim form ── */
function installClaimForm(user) {
  const form = document.getElementById('claimTrackForm');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const alert = document.getElementById('claimAlert');
    const btn   = form.querySelector('button[type="submit"]');
    const code  = document.getElementById('claimTrackingCode').value.trim();
    btn.disabled = true; btn.textContent = 'Linking…';
    try {
      const shipment = await claimTrackingCode(user, code);
      alert.className   = 'alert success';
      alert.textContent = `${shipment.trackingCode} is now linked to your dashboard.`;
      document.getElementById('claimTrackingCode').value = '';
      showToast('Tracking confirmed and linked!', 'success');
      refreshDashboard();
    } catch (err) {
      alert.className   = 'alert error';
      alert.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Confirm tracking';
    }
  });
}

/* ── Main refresh ── */
function refreshDashboard() {
  const shipments = getUserShipments(dashboardUser);
  document.getElementById('dashboardGreeting').textContent = `Welcome back, ${dashboardUser.name} 👋`;
  document.getElementById('dashboardSubtitle').textContent = `${dashboardUser.email} · ${getDataModeLabel()}`;
  renderDashboardStats(shipments);
  renderProfileCard(dashboardUser);
  renderMessages(dashboardUser);
  renderExpectedProducts(shipments);
  renderRecentTimeline(shipments);
}

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;
  dashboardUser = requireRole('user');
  if (!dashboardUser) return;

  refreshDashboard();
  installClaimForm(dashboardUser);

  /* Poll for new messages and shipment updates every 15s */
  setInterval(async () => {
    await ensureShipmentsLoaded(true);
    refreshDashboard();
  }, 15000);

  const modal = document.getElementById('shipmentModal');
  document.querySelectorAll('[data-close-shipment-modal]').forEach(btn =>
    btn.addEventListener('click', () => modal?.classList.remove('active'))
  );
  modal?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
  });

  /* bind viewer for page-level buttons */
  bindShipmentViewers(document);
});
