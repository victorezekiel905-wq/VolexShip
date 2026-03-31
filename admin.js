/* VeloxShip — Admin Panel Logic */
let adminUser          = null;
let editingShipmentId  = null;

/* ── Stats ── */
function renderAdminStats(shipments, users, requests) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('adminShipments', shipments.length);
  set('adminCustomers', users.length);
  set('adminPaused',    shipments.filter(s => s.status === 'paused').length);
  set('adminDelivered', shipments.filter(s => s.status === 'delivered').length);
  set('adminRequests',  requests.filter(r => r.status === 'new').length);
  set('adminMessages',  getAllMessages().length);
}

/* ── Customer dropdown ── */
function populateCustomerOptions() {
  const select = document.getElementById('customerEmail');
  if (!select) return;
  const users = getAllUsers();
  select.innerHTML = '<option value="">— Select customer account —</option>' +
    users.map(u => `<option value="${u.email}">${u.name} · ${u.email}</option>`).join('');
}

/* ── Shipments table ── */
function renderShipmentTable() {
  const host = document.getElementById('shipmentTableHost');
  if (!host) return;
  const shipments = getAllShipments();
  if (!shipments.length) {
    host.innerHTML = '<div class="empty-state"><div class="icon-pill"><i class="fa-solid fa-box"></i></div><p>No shipments yet.</p></div>';
    return;
  }
  host.innerHTML = `
    <div class="table-card responsive-table-card">
      <table>
        <thead>
          <tr><th>Tracking</th><th>Customer</th><th>Product</th><th>Status</th><th>Location</th><th>ETA</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${shipments.map(s => `
            <tr>
              <td><code>${s.trackingCode}</code></td>
              <td><span>${s.customerName || '—'}</span><br><small>${s.customerEmail || 'Unassigned'}</small></td>
              <td>${s.productName}</td>
              <td>${shipmentStatusBadge(s.status)}</td>
              <td>${s.currentLocation || '—'}</td>
              <td>${formatDateTime(s.estimatedArrival)}</td>
              <td>
                <div class="table-actions">
                  <button class="table-btn"        data-open-edit="${s.id}">Update</button>
                  <button class="table-btn warn"   data-copy-code="${s.trackingCode}">Copy code</button>
                  <button class="table-btn danger" data-delete-shipment="${s.id}">Delete</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-open-edit]').forEach(btn =>
    btn.addEventListener('click', () => openEditModal(btn.dataset.openEdit)));

  host.querySelectorAll('[data-copy-code]').forEach(btn =>
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.dataset.copyCode).catch(() => {});
      showToast(`Copied: ${btn.dataset.copyCode}`, 'success');
    }));

  host.querySelectorAll('[data-delete-shipment]').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this shipment? This cannot be undone.')) return;
      await deleteShipment(btn.dataset.deleteShipment);
      showToast('Shipment removed.', 'info');
      refreshAdmin();
    }));
}

/* ── Users table ── */
function renderUserTable() {
  const host = document.getElementById('userTableHost');
  if (!host) return;
  const users = getAllUsers();
  if (!users.length) {
    host.innerHTML = '<div class="empty-state"><div class="icon-pill"><i class="fa-solid fa-users"></i></div><p>No registered users yet.</p></div>';
    return;
  }
  host.innerHTML = `
    <div class="table-card responsive-table-card">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Address</th><th>Registered</th><th>Shipments</th></tr></thead>
        <tbody>
          ${users.map(u => {
            const count = getAllShipments().filter(s => s.customerEmail === u.email).length;
            return `<tr>
              <td>${u.name}</td>
              <td>${u.email}</td>
              <td>${u.phone || '—'}</td>
              <td>${u.address || '—'}</td>
              <td>${formatDate(u.createdAt)}</td>
              <td>${count}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ── Requests table ── */
function renderRequestTable() {
  const host = document.getElementById('requestTableHost');
  if (!host) return;
  const requests = getAllRequests();
  if (!requests.length) {
    host.innerHTML = '<div class="empty-state"><div class="icon-pill"><i class="fa-solid fa-inbox"></i></div><p>No shipping requests yet.</p></div>';
    return;
  }
  host.innerHTML = `
    <div class="table-card responsive-table-card">
      <table>
        <thead><tr><th>Customer</th><th>Product</th><th>Weight</th><th>Route</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${requests.map(r => `
            <tr>
              <td>${r.customerName || '—'}<br><small>${r.customerEmail || ''}</small></td>
              <td>${r.productName}<br><small>${r.productInfo || ''}</small></td>
              <td>${r.weightKg} kg</td>
              <td>${r.origin} → ${r.destination}</td>
              <td>${shipmentStatusBadge(r.status === 'new' ? 'processing' : 'confirmed')}</td>
              <td>
                <div class="table-actions">
                  <button class="table-btn"      data-use-request="${r.id}">Use</button>
                  <button class="table-btn warn" data-mark-request="${r.id}">Mark contacted</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-use-request]').forEach(btn =>
    btn.addEventListener('click', () => useRequestInForm(btn.dataset.useRequest)));
  host.querySelectorAll('[data-mark-request]').forEach(btn =>
    btn.addEventListener('click', () => {
      markRequestStatus(btn.dataset.markRequest, 'contacted');
      showToast('Marked as contacted.', 'success');
      refreshAdmin();
    }));
}

/* ── Messages panel ── */
function renderAdminMessages() {
  const host = document.getElementById('adminMessagesHost');
  if (!host) return;
  const messages = getAllMessages();
  if (!messages.length) {
    host.innerHTML = '<div class="empty-state"><p>No messages sent yet.</p></div>';
    return;
  }
  host.innerHTML = `
    <div class="table-card responsive-table-card">
      <table>
        <thead><tr><th>To</th><th>Subject</th><th>Sent</th><th>Read by</th></tr></thead>
        <tbody>
          ${messages.map(m => `
            <tr>
              <td>${m.to === 'all' ? '<span class="badge info">All users</span>' : m.to}</td>
              <td>${m.subject}</td>
              <td>${formatDateTime(m.createdAt)}</td>
              <td>${m.readBy.length} user(s)</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ── Use request in form ── */
function useRequestInForm(requestId) {
  const r = getAllRequests().find(r => r.id === requestId);
  if (!r) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('customerEmail',        r.customerEmail);
  set('customerNameFallback', r.customerName);
  set('productName',          r.productName);
  set('productCategory',      'Customer requested shipment');
  set('weightKg',             r.weightKg);
  set('origin',               r.origin);
  set('destination',          r.destination);
  set('adminNotes',           r.productInfo);
  document.getElementById('createShipmentSection')?.scrollIntoView({ behavior: 'smooth' });
  showToast('Request details loaded into shipment creator.', 'info');
}

/* ── Main refresh ── */
function refreshAdmin() {
  const users     = getAllUsers();
  const shipments = getAllShipments();
  const requests  = getAllRequests();
  const el = document.getElementById('adminGreeting');
  if (el) el.textContent = `Operations Workspace`;
  const mode = document.getElementById('adminDataMode');
  if (mode) mode.textContent = getDataModeLabel();
  renderAdminStats(shipments, users, requests);
  populateCustomerOptions();
  renderShipmentTable();
  renderUserTable();
  renderRequestTable();
  renderAdminMessages();
}

/* ── Create shipment form ── */
function installCreateShipmentForm() {
  const form = document.getElementById('createShipmentForm');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Creating…';
    const alert = document.getElementById('adminAlert');
    try {
      const emailVal   = document.getElementById('customerEmail').value;
      const matchedUser = getAllUsers().find(u => u.email === emailVal);
      const shipment = await createShipment({
        customerEmail:      emailVal,
        customerName:       matchedUser?.name || document.getElementById('customerNameFallback').value,
        productName:        document.getElementById('productName').value,
        productCategory:    document.getElementById('productCategory').value,
        productDescription: document.getElementById('productDescription').value,
        quantity:           document.getElementById('quantity').value,
        weightKg:           document.getElementById('weightKg').value,
        valueUsd:           document.getElementById('valueUsd').value,
        origin:             document.getElementById('origin').value,
        destination:        document.getElementById('destination').value,
        currentLocation:    document.getElementById('currentLocation').value,
        shippingMode:       document.getElementById('shippingMode').value,
        priority:           document.getElementById('priority').value,
        departureTime:      document.getElementById('departureTime').value || null,
        estimatedArrival:   document.getElementById('estimatedArrival').value,
        status:             document.getElementById('status').value,
        notes:              document.getElementById('adminNotes').value
      });
      alert.className   = 'alert success';
      alert.innerHTML   = `<strong>Shipment created!</strong> Tracking code: <code>${shipment.trackingCode}</code>`;
      form.reset();
      showToast(`Tracking code: ${shipment.trackingCode}`, 'success');
      refreshAdmin();
    } catch (err) {
      alert.className   = 'alert error';
      alert.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Generate tracking code & create shipment';
    }
  });
}

/* ── Edit modal ── */
function openEditModal(id) {
  editingShipmentId = id;
  const s = getAllShipments().find(s => s.id === id);
  if (!s) return;
  const set = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v || ''; };
  const codeEl = document.getElementById('editShipmentCode');
  if (codeEl) codeEl.textContent = s.trackingCode;
  set('editStatus',       s.status);
  set('editLocation',     s.currentLocation);
  set('editEta',          s.estimatedArrival ? s.estimatedArrival.slice(0, 16) : '');
  set('editDepartureTime',s.departureTime    ? s.departureTime.slice(0, 16)    : '');
  set('editPauseReason',  s.pausedReason);
  set('editHistoryTitle', '');
  set('editHistoryDetail','');
  document.getElementById('editModal')?.classList.add('active');
}

function installEditForm() {
  const form = document.getElementById('editShipmentForm');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!editingShipmentId) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const status = document.getElementById('editStatus').value;
      await updateShipment(editingShipmentId, {
        status,
        currentLocation:  document.getElementById('editLocation').value,
        estimatedArrival: document.getElementById('editEta').value || null,
        departureTime:    document.getElementById('editDepartureTime')?.value || null,
        pausedReason:     document.getElementById('editPauseReason').value,
        historyTitle:     document.getElementById('editHistoryTitle').value || undefined,
        historyDetail:    document.getElementById('editHistoryDetail').value || undefined
      });
      document.getElementById('editModal')?.classList.remove('active');
      showToast('Shipment updated.', 'success');
      const alert = document.getElementById('adminAlert');
      if (alert) { alert.className = 'alert success'; alert.textContent = 'Shipment updated successfully.'; }
      refreshAdmin();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Save update';
    }
  });
}

/* ── Send message form ── */
function installMessageForm() {
  const form = document.getElementById('sendMessageForm');
  if (!form) return;
  // Populate recipient select
  const recipSelect = document.getElementById('msgRecipient');
  if (recipSelect) {
    const users = getAllUsers();
    recipSelect.innerHTML = '<option value="all">📢 All registered users</option>' +
      users.map(u => `<option value="${u.email}">${u.name} · ${u.email}</option>`).join('');
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn   = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      sendMessage({
        to:      document.getElementById('msgRecipient').value,
        subject: document.getElementById('msgSubject').value,
        body:    document.getElementById('msgBody').value
      });
      showToast('Message sent.', 'success');
      form.reset();
      // Re-populate recipient
      const users = getAllUsers();
      const sel = document.getElementById('msgRecipient');
      if (sel) sel.innerHTML = '<option value="all">📢 All registered users</option>' +
        users.map(u => `<option value="${u.email}">${u.name} · ${u.email}</option>`).join('');
      refreshAdmin();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;
  adminUser = requireRole('admin');
  if (!adminUser) return;

  refreshAdmin();
  installCreateShipmentForm();
  installEditForm();
  installMessageForm();

  document.querySelectorAll('[data-close-edit-modal]').forEach(btn =>
    btn.addEventListener('click', () => document.getElementById('editModal')?.classList.remove('active')));
  document.getElementById('editModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
  });
});
