/* VeloxShip — Admin Panel Logic */
let adminUser = null;
let editingShipmentId = null;

function hasAdminPrivileges() {
  return adminUser?.role === 'admin'
    || localStorage.getItem('role') === 'admin'
    || localStorage.getItem('isAdmin') === 'true';
}

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
  sendMessage({ to: shipment.customerEmail, subject, body });
}

function ensureEditCustomerFields() {
  return null;
}

function renderAdminStats(shipments, users, requests) {
  const visibleShipments = shipments.filter(shipment => shipment.status !== 'deleted' && !shipment.deleted);
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set('adminShipments', visibleShipments.length);
  set('adminCustomers', users.length);
  set('adminPaused', visibleShipments.filter(shipment => shipment.status === 'paused' || shipment.statusControl === 'paused').length);
  set('adminDelivered', visibleShipments.filter(shipment => shipment.status === 'delivered').length);
  set('adminRequests', requests.filter(request => request.status === 'new').length);
  set('adminMessages', getAllMessages().length);
}

function populateCustomerOptions() {
  const select = document.getElementById('customerEmail');
  if (!select) return;
  const users = getAllUsers();
  select.innerHTML = '<option value="">— Select customer account —</option>' +
    users.map(user => `<option value="${user.email}">${user.name} · ${user.email}</option>`).join('');
}

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
          ${shipments.map(shipment => {
            const isPaused = shipment.status === 'paused' || shipment.statusControl === 'paused';
            return `
              <tr>
                <td><code>${shipment.trackingCode}</code></td>
                <td><span>${shipment.customerName || '—'}</span><br><small>${shipment.customerEmail || 'Unassigned'}</small></td>
                <td>${shipment.productName}</td>
                <td>${shipmentStatusBadge(shipment.status)}</td>
                <td>${shipment.currentLocation || '—'}</td>
                <td>${getShipmentEtaText(shipment)}</td>
                <td>
                  <div class="table-actions">
                    <button class="table-btn" data-open-edit="${shipment.id}">Update</button>
                    <button class="table-btn warn" data-toggle-shipment="${shipment.id}">${isPaused ? 'Resume' : 'Pause'}</button>
                    <button class="table-btn warn" data-copy-code="${shipment.trackingCode}">Copy code</button>
                    <button class="table-btn danger" data-delete-shipment="${shipment.id}">Delete</button>
                  </div>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-open-edit]').forEach(button => {
    button.addEventListener('click', () => openEditModal(button.dataset.openEdit));
  });

  host.querySelectorAll('[data-toggle-shipment]').forEach(button => {
    button.addEventListener('click', () => handleToggleShipment(button.dataset.toggleShipment));
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


async function handlePauseShipment(id, presetReason = '') {
  if (!hasAdminPrivileges()) {
    showToast('Admin access required.', 'error');
    return;
  }
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) {
    showToast('Shipment not found.', 'error');
    return;
  }
  const reason = presetReason || window.prompt('Enter pause reason', shipment.pausedReason || '');
  if (reason === null) return;
  const pauseReason = String(reason || '').trim();
  if (!pauseReason) {
    showToast('Pause reason is required.', 'warning');
    return;
  }
  try {
    const result = await window.vsApiFetch(`/shipments/${id}/pause`, {
      method: 'POST',
      headers: buildAdminHeaders(),
      body: JSON.stringify({ reason: pauseReason })
    });
    const updated = result.shipment;
    await ensureShipmentsLoaded(true);
    sendDashboardActionMessage(updated, `Shipment paused: ${pauseReason}`, 'Shipment paused');
    setAdminAlert('Shipment paused successfully.', 'success');
    showToast('Shipment paused.', 'success');
    refreshAdmin();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleResumeShipment(id, presetReason = '') {
  if (!hasAdminPrivileges()) {
    showToast('Admin access required.', 'error');
    return;
  }
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) {
    showToast('Shipment not found.', 'error');
    return;
  }
  const reason = presetReason || window.prompt('Enter resume reason', shipment.resumeReason || '');
  if (reason === null) return;
  const resumeReason = String(reason || '').trim();
  if (!resumeReason) {
    showToast('Resume reason is required.', 'warning');
    return;
  }
  try {
    const result = await window.vsApiFetch(`/shipments/${id}/resume`, {
      method: 'POST',
      headers: buildAdminHeaders(),
      body: JSON.stringify({ reason: resumeReason })
    });
    const updated = result.shipment;
    await ensureShipmentsLoaded(true);
    sendDashboardActionMessage(updated, `Shipment movement resumed: ${resumeReason}`, 'Shipment resumed');
    setAdminAlert('Shipment resumed successfully.', 'success');
    showToast('Shipment resumed.', 'success');
    refreshAdmin();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleToggleShipment(id) {
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) {
    showToast('Shipment not found.', 'error');
    return;
  }
  if (shipment.status === 'paused' || shipment.statusControl === 'paused') {
    return handleResumeShipment(id);
  }
  return handlePauseShipment(id);
}


async function handleDeleteShipment(id) {
  if (!hasAdminPrivileges()) {
    showToast('Admin access required.', 'error');
    return;
  }
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

function installCreateShipmentForm() {
  const form = document.getElementById('createShipmentForm');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!hasAdminPrivileges()) {
      showToast('Admin access required.', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const emailValue = document.getElementById('customerEmail').value;
      const matchedUser = getAllUsers().find(user => user.email === emailValue);
      const shipment = await createShipment({
        customerEmail: emailValue,
        customerUserId: matchedUser?.id || '',
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

async function editCustomerShippingInfo(shipment) {
  const fullName = window.prompt('Customer full name', shipment.customerName || '');
  if (fullName === null) return;
  const email = window.prompt('Customer email', shipment.customerEmail || '');
  if (email === null) return;
  const phone = window.prompt('Customer phone', shipment.phone || '');
  if (phone === null) return;
  const destination = window.prompt('Destination', shipment.destination || '');
  if (destination === null) return;
  const address = window.prompt('Address', shipment.address || '');
  if (address === null) return;
  const statusOverride = window.prompt('Shipment status override (optional)', getStatusMeta(shipment.status).label || '');
  if (statusOverride === null) return;

  await window.vsApiFetch(`/shipments/${shipment.id}/customer`, {
    method: 'PATCH',
    headers: buildAdminHeaders(),
    body: JSON.stringify({
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
      destination: destination.trim(),
      address: address.trim(),
      statusOverride: statusOverride.trim()
    })
  });

  await ensureShipmentsLoaded(true);
  setAdminAlert('Customer shipping info updated.', 'success');
  showToast('Customer details updated.', 'success');
  refreshAdmin();
}

async function manageTrackingHistory(shipment) {
  const mode = (window.prompt('Tracking history action: add, edit, delete', 'add') || '').trim().toLowerCase();
  if (!mode) return;
  const result = await window.vsApiFetch(`/shipments/${shipment.id}/movements?limit=20`, {
    headers: buildAdminHeaders()
  });
  const movements = result.movements || [];
  const summary = movements.length
    ? movements.map(item => `${item.id} | ${formatDateTime(item.time)} | ${item.location} | ${getStatusMeta(item.status).label}`).join('\n')
    : 'No existing tracking updates yet.';

  if (mode === 'add') {
    const location = window.prompt('Tracking location (generic hub only)', shipment.currentLocation || 'Origin Facility');
    if (location === null) return;
    const status = window.prompt('Tracking status', getStatusMeta(shipment.status).label || 'Processing');
    if (status === null) return;
    const note = window.prompt('Optional note', shipment.notes || '');
    if (note === null) return;
    await window.vsApiFetch(`/shipments/${shipment.id}/movements`, {
      method: 'POST',
      headers: buildAdminHeaders(),
      body: JSON.stringify({ location: location.trim(), status: status.trim(), note: note.trim() })
    });
    await ensureShipmentsLoaded(true);
    showToast('Tracking update added.', 'success');
    refreshAdmin();
    return;
  }

  const movementId = window.prompt(`${summary}\n\nEnter tracking update ID`, movements[0]?.id || '');
  if (movementId === null || !movementId.trim()) return;
  const selected = movements.find(item => String(item.id) === String(movementId).trim());
  if (!selected) {
    showToast('Tracking update not found.', 'error');
    return;
  }

  if (mode === 'edit') {
    const location = window.prompt('Edit location', selected.location || '');
    if (location === null) return;
    const status = window.prompt('Edit status', getStatusMeta(selected.status).label || 'Processing');
    if (status === null) return;
    const note = window.prompt('Edit note', selected.note || selected.detail || '');
    if (note === null) return;
    await window.vsApiFetch(`/shipments/${shipment.id}/movements/${selected.id}`, {
      method: 'PATCH',
      headers: buildAdminHeaders(),
      body: JSON.stringify({ location: location.trim(), status: status.trim(), note: note.trim() })
    });
    await ensureShipmentsLoaded(true);
    showToast('Tracking update edited.', 'success');
    refreshAdmin();
    return;
  }

  if (mode === 'delete') {
    if (!window.confirm(`Delete tracking update ${selected.id}?`)) return;
    await window.vsApiFetch(`/shipments/${shipment.id}/movements/${selected.id}`, {
      method: 'DELETE',
      headers: buildAdminHeaders()
    });
    await ensureShipmentsLoaded(true);
    showToast('Tracking update deleted.', 'success');
    refreshAdmin();
    return;
  }

  showToast('Unknown action. Use add, edit, or delete.', 'warning');
}

function openEditModal(id) {
  editingShipmentId = id;
  const shipment = getAllShipments().find(item => String(item.id) === String(id));
  if (!shipment) return;
  const mode = (window.prompt('Choose action: shipment, customer, tracking', 'shipment') || 'shipment').trim().toLowerCase();
  if (!mode || mode === 'shipment') {
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
    set('editHistoryTitle', '');
    set('editHistoryDetail', '');
    document.getElementById('editModal')?.classList.add('active');
    return;
  }
  if (mode === 'customer') {
    editCustomerShippingInfo(shipment).catch(error => showToast(error.message, 'error'));
    return;
  }
  if (mode === 'tracking') {
    manageTrackingHistory(shipment).catch(error => showToast(error.message, 'error'));
    return;
  }
  showToast('Unknown action. Use shipment, customer, or tracking.', 'warning');
}

function installEditForm() {
  const form = document.getElementById('editShipmentForm');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!hasAdminPrivileges()) {
      showToast('Admin access required.', 'error');
      return;
    }
    if (!editingShipmentId) return;
    const shipment = getAllShipments().find(item => String(item.id) === String(editingShipmentId));
    if (!shipment) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const status = document.getElementById('editStatus').value;
      const pauseReason = document.getElementById('editPauseReason').value.trim();

      if (status === 'paused') {
        if (!pauseReason) throw new Error('Pause reason is required when pausing a shipment.');
        await handlePauseShipment(editingShipmentId, pauseReason);
        document.getElementById('editModal')?.classList.remove('active');
        return;
      }

      let resumeReason = '';
      if ((shipment.status === 'paused' || shipment.statusControl === 'paused') && status !== 'paused') {
        const resumeInput = window.prompt('Enter resume reason', shipment.resumeReason || '');
        if (resumeInput === null) return;
        resumeReason = String(resumeInput || '').trim();
        if (!resumeReason) throw new Error('Resume reason is required when resuming a shipment.');
        await window.vsApiFetch(`/shipments/${editingShipmentId}/resume`, {
          method: 'POST',
          headers: buildAdminHeaders(),
          body: JSON.stringify({ reason: resumeReason })
        });
      }

      const payload = {
        status,
        currentLocation: document.getElementById('editLocation').value,
        estimatedArrival: document.getElementById('editEta').value || null,
        departureTime: document.getElementById('editDepartureTime')?.value || null,
        pausedReason: '',
        resumeReason,
        historyTitle: document.getElementById('editHistoryTitle').value || undefined,
        historyDetail: document.getElementById('editHistoryDetail').value || undefined
      };

      if ((shipment.status === 'paused' || shipment.statusControl === 'paused') && status !== 'paused') {
        if (!payload.historyTitle) payload.historyTitle = 'In Transit';
        if (!payload.historyDetail) payload.historyDetail = resumeReason;
      }

      if (status === 'deleted') {
        payload.deleted = true;
        payload.deletedAt = new Date().toISOString();
        if (!payload.historyTitle) payload.historyTitle = 'Shipment has been deleted';
        if (!payload.historyDetail) payload.historyDetail = 'Shipment has been deleted';
      }

      const updated = await updateShipment(editingShipmentId, payload);
      if ((shipment.status === 'paused' || shipment.statusControl === 'paused') && status !== 'paused') {
        sendDashboardActionMessage(updated, `Shipment movement resumed: ${resumeReason}`, 'Shipment resumed');
      }
      if (status === 'deleted') {
        sendDashboardActionMessage(updated, 'Shipment has been deleted', 'Shipment deleted');
      }
      document.getElementById('editModal')?.classList.remove('active');
      showToast('Shipment updated.', 'success');
      setAdminAlert('Shipment updated successfully.', 'success');
      await ensureShipmentsLoaded(true);
      refreshAdmin();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save update';
    }
  });
}


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
    if (!hasAdminPrivileges()) {
      showToast('Admin access required.', 'error');
      return;
    }
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

document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;
  adminUser = requireRole('admin');
  if (!adminUser) return;

  localStorage.setItem('role', 'admin');
  localStorage.setItem('isAdmin', 'true');

  refreshAdmin();
  installCreateShipmentForm();
  installEditForm();
  installMessageForm();
  window.addEventListener('veloxship:shipments-updated', refreshAdmin);

  document.querySelectorAll('[data-close-edit-modal]').forEach(button =>
    button.addEventListener('click', () => document.getElementById('editModal')?.classList.remove('active')));
  document.getElementById('editModal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.classList.remove('active');
  });
});
