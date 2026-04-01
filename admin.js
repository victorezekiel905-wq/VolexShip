/* VeloxShip — Admin Panel Logic */
let adminUser = null;
let editingShipmentId = null;

function getAdminVisibleShipments() {
  return getAllShipments().filter(shipment => shipment.status !== 'deleted' && !shipment.deleted);
}

function setAdminAlert(message, tone = 'info') {
  const alert = document.getElementById('adminAlert');
  if (!alert) return;
  alert.className = `alert ${tone}`;
  alert.textContent = message;
}

function sendDashboardActionMessage(shipment, body, subject = 'Shipment update') {
  if (!shipment?.customerEmail) return;
  sendMessage({
    to: shipment.customerEmail,
    subject,
    body
  });
}

function ensureEditCustomerFields() {
  const form = document.getElementById('editShipmentForm');
  if (!form || form.querySelector('[data-customer-fields]')) return;
  const historyGrid = form.querySelector('.form-grid:last-of-type');
  if (!historyGrid) return;
  historyGrid.insertAdjacentHTML('beforebegin', `
    <div class="form-grid" data-customer-fields>
      <div>
        <label for="editCustomerName">Customer name</label>
        <input id="editCustomerName" placeholder="Customer full name">
      </div>
      <div>
        <label for="editCustomerEmail">Customer email</label>
        <input id="editCustomerEmail" type="email" placeholder="customer@example.com">
      </div>
    </div>
    <div class="form-grid" data-customer-fields>
      <div>
        <label for="editCustomerPhone">Customer phone</label>
        <input id="editCustomerPhone" placeholder="Customer phone number">
      </div>
      <div>
        <label for="editCustomerAddress">Customer address</label>
        <input id="editCustomerAddress" placeholder="Customer delivery address">
      </div>
    </div>
  `);
}

/* ── Stats ── */
function renderAdminStats(shipments, users, requests) {
  const visibleShipments = shipments.filter(shipment => shipment.status !== 'deleted' && !shipment.deleted);
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set('adminShipments', visibleShipments.length);
  set('adminCustomers', users.length);
  set('adminPaused', visibleShipments.filter(shipment => shipment.status === 'paused').length);
  set('adminDelivered', visibleShipments.filter(shipment => shipment.status === 'delivered').length);
  set('adminRequests', requests.filter(request => request.status === 'new').length);
  set('adminMessages', getAllMessages().length);
}

/* ── Customer dropdown ── */
function populateCustomerOptions() {
  const select = document.getElementById('customerEmail');
  if (!select) return;
  const users = getAllUsers();
  select.innerHTML = '<option value="">— Select customer account —</option>' +
    users.map(user => `<option value="${user.email}">${user.name} · ${user.email}</option>`).join('');
}

/* ── Shipments table ── */
function renderShipmentTable() {
  const host = document.getElementById('shipmentTableHost');
  if (!host) return;
  const shipments = getAdminVisibleShipments();
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
          ${shipments.map(shipment => `
            <tr>
              <td><code>${shipment.trackingCode}</code></td>
              <td><span>${shipment.customerName || '—'}</span><br><small>${shipment.customerEmail || 'Unassigned'}</small></td>
              <td>${shipment.productName}</td>
              <td>${shipmentStatusBadge(shipment.status)}</td>
              <td>${shipment.currentLocation || '—'}</td>
              <td>${formatDateTime(shipment.estimatedArrival)}</td>
              <td>
                <div class="table-actions">
                  <button class="table-btn" data-open-edit="${shipment.id}">Update</button>
                  <button class="table-btn warn" data-pause-shipment="${shipment.id}">Pause</button>
                  <button class="table-btn warn" data-copy-code="${shipment.trackingCode}">Copy code</button>
                  <button class="table-btn danger" data-delete-shipment="${shipment.id}">Delete</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-open-edit]').forEach(button => {
    button.addEventListener('click', () => openEditModal(button.dataset.openEdit));
  });

  host.querySelectorAll('[data-pause-shipment]').forEach(button => {
    button.addEventListener('click', () => handlePauseShipment(button.dataset.pauseShipment));
  });

  host.querySelectorAll('[data-copy-code]').forEach(button => {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copyCode).catch(() => {});
      showToast(`Copied: ${button.dataset.copyCode}`, 'success');
    });
  });

  host.querySelectorAll('[data-delete-shipment]').forEach(button => {
    button.addEventListener('click', () => handleDeleteShipment(button.dataset.deleteShipment));
  });
}

async function handlePauseShipment(id) {
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) {
    showToast('Shipment not found.', 'error');
    return;
  }
  const reason = window.prompt('Enter pause reason', shipment.pausedReason || '');
  if (reason === null) return;
  const pauseReason = reason.trim();
  if (!pauseReason) {
    showToast('Pause reason is required.', 'warning');
    return;
  }
  try {
    const updated = await updateShipment(id, {
      status: 'paused',
      pausedReason: pauseReason,
      historyTitle: 'Shipment paused',
      historyDetail: `Shipment paused: ${pauseReason}`
    });
    sendDashboardActionMessage(updated, `Shipment paused: ${pauseReason}`, 'Shipment paused');
    setAdminAlert('Shipment paused successfully.', 'success');
    showToast('Shipment paused.', 'success');
    refreshAdmin();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleDeleteShipment(id) {
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) {
    showToast('Shipment not found.', 'error');
    return;
  }
  if (!window.confirm('Delete this shipment?')) return;
  try {
    const updated = await updateShipment(id, {
      status: 'deleted',
      deleted: true,
      deletedAt: new Date().toISOString(),
      historyTitle: 'Shipment has been deleted',
      historyDetail: 'Shipment has been deleted'
    });
    sendDashboardActionMessage(updated, 'Shipment has been deleted', 'Shipment deleted');
    setAdminAlert('Shipment deleted successfully.', 'success');
    showToast('Shipment deleted.', 'info');
    refreshAdmin();
  } catch (error) {
    showToast(error.message, 'error');
  }
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
          ${users.map(user => {
            const count = getAdminVisibleShipments().filter(shipment => shipment.customerEmail === user.email).length;
            return `<tr>
              <td>${user.name}</td>
              <td>${user.email}</td>
              <td>${user.phone || '—'}</td>
              <td>${user.address || '—'}</td>
              <td>${formatDate(user.createdAt)}</td>
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
          ${requests.map(request => `
            <tr>
              <td>${request.customerName || '—'}<br><small>${request.customerEmail || ''}</small></td>
              <td>${request.productName}<br><small>${request.productInfo || ''}</small></td>
              <td>${request.weightKg} kg</td>
              <td>${request.origin} → ${request.destination}</td>
              <td>${shipmentStatusBadge(request.status === 'new' ? 'processing' : 'confirmed')}</td>
              <td>
                <div class="table-actions">
                  <button class="table-btn" data-use-request="${request.id}">Use</button>
                  <button class="table-btn warn" data-mark-request="${request.id}">Mark contacted</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-use-request]').forEach(button =>
    button.addEventListener('click', () => useRequestInForm(button.dataset.useRequest)));
  host.querySelectorAll('[data-mark-request]').forEach(button =>
    button.addEventListener('click', () => {
      markRequestStatus(button.dataset.markRequest, 'contacted');
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
          ${messages.map(message => `
            <tr>
              <td>${message.to === 'all' ? '<span class="badge info">All users</span>' : message.to}</td>
              <td>${message.subject}</td>
              <td>${formatDateTime(message.createdAt)}</td>
              <td>${message.readBy.length} user(s)</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ── Use request in form ── */
function useRequestInForm(requestId) {
  const request = getAllRequests().find(item => item.id === requestId);
  if (!request) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  };
  set('customerEmail', request.customerEmail);
  set('customerNameFallback', request.customerName);
  set('productName', request.productName);
  set('productCategory', 'Customer requested shipment');
  set('weightKg', request.weightKg);
  set('origin', request.origin);
  set('destination', request.destination);
  set('adminNotes', request.productInfo);
  document.getElementById('createShipmentSection')?.scrollIntoView({ behavior: 'smooth' });
  showToast('Request details loaded into shipment creator.', 'info');
}

/* ── Main refresh ── */
function refreshAdmin() {
  const users = getAllUsers();
  const shipments = getAllShipments();
  const requests = getAllRequests();
  const greeting = document.getElementById('adminGreeting');
  if (greeting) greeting.textContent = 'Operations Workspace';
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
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const emailValue = document.getElementById('customerEmail').value;
      const matchedUser = getAllUsers().find(user => user.email === emailValue);
      const shipment = await createShipment({
        customerEmail: emailValue,
        customerName: matchedUser?.name || document.getElementById('customerNameFallback').value,
        productName: document.getElementById('productName').value,
        productCategory: document.getElementById('productCategory').value,
        productDescription: document.getElementById('productDescription').value,
        quantity: document.getElementById('quantity').value,
        weightKg: document.getElementById('weightKg').value,
        valueUsd: document.getElementById('valueUsd').value,
        origin: document.getElementById('origin').value,
        destination: document.getElementById('destination').value,
        currentLocation: document.getElementById('currentLocation').value,
        shippingMode: document.getElementById('shippingMode').value,
        priority: document.getElementById('priority').value,
        departureTime: document.getElementById('departureTime').value || null,
        estimatedArrival: document.getElementById('estimatedArrival').value,
        status: document.getElementById('status').value,
        notes: document.getElementById('adminNotes').value
      });
      setAdminAlert(`Shipment created successfully. Tracking code: ${shipment.trackingCode}`, 'success');
      form.reset();
      showToast(`Tracking code: ${shipment.trackingCode}`, 'success');
      refreshAdmin();
    } catch (error) {
      setAdminAlert(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Generate tracking code & create shipment';
    }
  });
}

/* ── Edit modal ── */
function openEditModal(id) {
  editingShipmentId = id;
  ensureEditCustomerFields();
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) return;
  const set = (elId, value) => {
    const el = document.getElementById(elId);
    if (el) el.value = value || '';
  };
  const codeEl = document.getElementById('editShipmentCode');
  if (codeEl) codeEl.textContent = shipment.trackingCode;
  set('editStatus', shipment.status);
  set('editLocation', shipment.currentLocation);
  set('editEta', shipment.estimatedArrival ? shipment.estimatedArrival.slice(0, 16) : '');
  set('editDepartureTime', shipment.departureTime ? shipment.departureTime.slice(0, 16) : '');
  set('editPauseReason', shipment.pausedReason);
  set('editCustomerName', shipment.customerName);
  set('editCustomerEmail', shipment.customerEmail);
  set('editCustomerPhone', shipment.phone);
  set('editCustomerAddress', shipment.address);
  set('editHistoryTitle', '');
  set('editHistoryDetail', '');
  document.getElementById('editModal')?.classList.add('active');
}

function installEditForm() {
  const form = document.getElementById('editShipmentForm');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!editingShipmentId) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const status = document.getElementById('editStatus').value;
      const pauseReason = document.getElementById('editPauseReason').value.trim();
      const payload = {
        status,
        currentLocation: document.getElementById('editLocation').value,
        estimatedArrival: document.getElementById('editEta').value || null,
        departureTime: document.getElementById('editDepartureTime')?.value || null,
        pausedReason: pauseReason,
        customerName: document.getElementById('editCustomerName')?.value.trim() || '',
        customerEmail: document.getElementById('editCustomerEmail')?.value.trim().toLowerCase() || '',
        phone: document.getElementById('editCustomerPhone')?.value.trim() || '',
        address: document.getElementById('editCustomerAddress')?.value.trim() || '',
        historyTitle: document.getElementById('editHistoryTitle').value || undefined,
        historyDetail: document.getElementById('editHistoryDetail').value || undefined
      };

      if (status === 'paused') {
        if (!pauseReason) throw new Error('Pause reason is required when pausing a shipment.');
        if (!payload.historyTitle) payload.historyTitle = 'Shipment paused';
        if (!payload.historyDetail) payload.historyDetail = `Shipment paused: ${pauseReason}`;
      }
      if (status === 'deleted') {
        payload.deleted = true;
        payload.deletedAt = new Date().toISOString();
        if (!payload.historyTitle) payload.historyTitle = 'Shipment has been deleted';
        if (!payload.historyDetail) payload.historyDetail = 'Shipment has been deleted';
      }

      const updated = await updateShipment(editingShipmentId, payload);
      if (status === 'paused') {
        sendDashboardActionMessage(updated, `Shipment paused: ${pauseReason}`, 'Shipment paused');
      }
      if (status === 'deleted') {
        sendDashboardActionMessage(updated, 'Shipment has been deleted', 'Shipment deleted');
      }
      document.getElementById('editModal')?.classList.remove('active');
      showToast('Shipment updated.', 'success');
      setAdminAlert('Shipment updated successfully.', 'success');
      refreshAdmin();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save update';
    }
  });
}

/* ── Send message form ── */
function installMessageForm() {
  const form = document.getElementById('sendMessageForm');
  if (!form) return;
  const recipientSelect = document.getElementById('msgRecipient');
  if (recipientSelect) {
    const users = getAllUsers();
    recipientSelect.innerHTML = '<option value="all">📢 All registered users</option>' +
      users.map(user => `<option value="${user.email}">${user.name} · ${user.email}</option>`).join('');
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      sendMessage({
        to: document.getElementById('msgRecipient').value,
        subject: document.getElementById('msgSubject').value,
        body: document.getElementById('msgBody').value
      });
      showToast('Message sent.', 'success');
      form.reset();
      const users = getAllUsers();
      const select = document.getElementById('msgRecipient');
      if (select) {
        select.innerHTML = '<option value="all">📢 All registered users</option>' +
          users.map(user => `<option value="${user.email}">${user.name} · ${user.email}</option>`).join('');
      }
      refreshAdmin();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;
  adminUser = requireRole('admin');
  if (!adminUser) return;

  localStorage.setItem('role', 'admin');
  localStorage.setItem('isAdmin', 'true');

  ensureEditCustomerFields();
  refreshAdmin();
  installCreateShipmentForm();
  installEditForm();
  installMessageForm();

  document.querySelectorAll('[data-close-edit-modal]').forEach(button =>
    button.addEventListener('click', () => document.getElementById('editModal')?.classList.remove('active')));
  document.getElementById('editModal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.classList.remove('active');
  });
});
