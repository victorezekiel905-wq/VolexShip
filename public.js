/* VeloxShip — Public page interactions */

const trackedPublicResults = new Map();

function registerTrackedResult(outputId, code) {
  if (!outputId) return;
  const safeCode = String(code || '').trim().toUpperCase();
  if (!safeCode) return;
  trackedPublicResults.set(outputId, safeCode);
}

function renderTrackedShipment(output, shipment) {
  if (!output || !shipment) return;
  output.innerHTML = shipmentCardMarkup(shipment, {
    showActions: `<div class="form-actions">
      <a class="btn btn-primary btn-sm" href="tracking.html#track-now">Full tracking page</a>
      <a class="btn btn-secondary btn-sm" href="login.html">Sign in</a>
    </div>`
  });
  bindShipmentViewers(output);
  refreshLiveTelemetry(output);

  const modalBody = document.getElementById('shipmentModalBody');
  if (modalBody?.dataset?.shipmentId && String(modalBody.dataset.shipmentId) === String(shipment.id)) {
    modalBody.innerHTML = shipmentDetailMarkup(shipment);
    modalBody.setAttribute('data-shipment-id', shipment.id);
    refreshLiveTelemetry(modalBody);
  }
}

async function refreshTrackedPublicResults() {
  const jobs = Array.from(trackedPublicResults.entries());
  await Promise.all(jobs.map(async ([outputId, code]) => {
    const output = document.getElementById(outputId);
    if (!output || !code) return;
    try {
      const shipment = await fetchShipmentByCode(code, { force: true });
      renderTrackedShipment(output, shipment);
    } catch (error) {
      output.innerHTML = `<div class="alert error"><i class="fa-solid fa-triangle-exclamation"></i> ${error.message}</div>`;
    }
  }));
}

function syncTrackingUrl(code) {
  if ((document.body?.dataset?.page || '') !== 'tracking') return;
  const safeCode = String(code || '').trim().toUpperCase();
  const next = new URL(window.location.href);
  if (safeCode) next.searchParams.set('tracking', safeCode);
  else next.searchParams.delete('tracking');
  history.replaceState({}, '', next.toString());
}

async function installQuickTrack(formId, inputId, outputId) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await window.vsReady;
    const code = (document.getElementById(inputId)?.value || '').trim();
    const output = document.getElementById(outputId);
    if (!code) {
      output.innerHTML = '<div class="alert error">Please enter a tracking code.</div>';
      return;
    }
    output.innerHTML = '<div class="alert info"><i class="fa-solid fa-circle-notch fa-spin"></i> Looking up shipment…</div>';
    try {
      const shipment = await fetchShipmentByCode(code, { force: true });
      registerTrackedResult(outputId, shipment.trackingCode || code);
      syncTrackingUrl(shipment.trackingCode || code);
      renderTrackedShipment(output, shipment);
    } catch (err) {
      output.innerHTML = `<div class="alert error"><i class="fa-solid fa-triangle-exclamation"></i> ${err.message}</div>`;
    }
  });
}

function bindShipmentViewers(scope = document) {
  scope.querySelectorAll('[data-view-shipment]').forEach(btn => {
    btn.removeEventListener('click', btn._vsHandler);
    btn._vsHandler = () => {
      const shipment = getAllShipments().find(s => s.id === btn.dataset.viewShipment);
      if (!shipment) return;
      const modal = document.getElementById('shipmentModal');
      const content = document.getElementById('shipmentModalBody');
      content.setAttribute('data-shipment-id', shipment.id);
      content.innerHTML = shipmentDetailMarkup(shipment);
      modal.classList.add('active');
      refreshLiveTelemetry(content);
    };
    btn.addEventListener('click', btn._vsHandler);
  });
}

function ensureRateCalculatorVisible() {
  const section = document.getElementById('rates');
  const form = document.getElementById('rateCalcForm');
  if (!form) return;
  if (section) section.style.overflow = 'visible';
  form.style.display = 'flex';
  form.style.visibility = 'visible';
  form.style.opacity = '1';
  form.style.position = 'relative';
  form.style.zIndex = '2';
  const result = document.getElementById('calcResult');
  if (result) {
    result.style.display = 'block';
    result.style.minHeight = '32px';
    result.style.position = 'relative';
    result.style.zIndex = '2';
  }
}

function installCalculator() {
  const form = document.getElementById('rateCalcForm');
  if (!form) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const weight = Number(document.getElementById('calcWeight')?.value || 0);
    const mode = document.getElementById('calcMode')?.value || 'express';
    const dist = Number(document.getElementById('calcDistance')?.value || 0);
    const ins = document.getElementById('calcInsurance')?.checked ? 85 : 0;
    const mult = { express: 1.75, freight: 1.28, economy: 1 }[mode] || 1;
    const result = Math.round((120 + weight * 16 + dist * 0.11) * mult + ins);
    const el = document.getElementById('calcResult');
    if (el) el.innerHTML = `<div class="alert success">Estimated: <strong>${money(result)}</strong> · ETA adapts to mode and lane.</div>`;
  });
}

function installFaq() {
  document.querySelectorAll('[data-faq-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const panel = item?.querySelector('.faq-answer');
      item?.classList.toggle('open');
      panel?.classList.toggle('hidden');
    });
  });
}

function installShippingRequest() {
  const form = document.getElementById('shippingRequestForm');
  if (!form) return;
  const u = getCurrentUser();
  if (u?.role === 'user') {
    const em = document.getElementById('requestEmail');
    const nm = document.getElementById('requestName');
    if (em) em.value = u.email;
    if (nm) nm.value = u.name;
  }
  form.addEventListener('submit', e => {
    e.preventDefault();
    createShippingRequest(u, {
      customerName: document.getElementById('requestName')?.value,
      customerEmail: document.getElementById('requestEmail')?.value,
      productName: document.getElementById('requestProduct')?.value,
      productInfo: document.getElementById('requestDetails')?.value,
      weightKg: document.getElementById('requestWeight')?.value,
      origin: document.getElementById('requestOrigin')?.value,
      destination: document.getElementById('requestDestination')?.value
    });
    const alertBox = document.getElementById('shippingRequestAlert');
    if (alertBox) {
      alertBox.className = 'alert success';
      alertBox.textContent = 'Request received. Customer care will contact you shortly.';
    }
    showToast('Shipping request submitted.', 'success');
    form.reset();
  });
}

async function applyTrackingCodeFromUrl() {
  if ((document.body?.dataset?.page || '') !== 'tracking') return;
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('tracking') || params.get('code') || params.get('track') || '').trim();
  if (!code) return;
  const input = document.getElementById('pageTrackInput');
  const form = document.getElementById('pageTrackForm');
  if (!input || !form) return;
  input.value = code;
  form.requestSubmit();
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;
  installQuickTrack('heroTrackForm', 'heroTrackInput', 'heroTrackResult');
  installQuickTrack('pageTrackForm', 'pageTrackInput', 'pageTrackResult');
  installQuickTrack('supportTrackForm', 'supportTrackInput', 'supportTrackResult');
  installQuickTrack('dashboardTrackForm', 'dashboardTrackInput', 'dashboardTrackResult');
  ensureRateCalculatorVisible();
  installCalculator();
  installFaq();
  installShippingRequest();
  bindShipmentViewers(document);
  await applyTrackingCodeFromUrl();
  window.addEventListener('veloxship:shipments-updated', () => {
    refreshTrackedPublicResults().catch(error => console.error('[VeloxShip] Public tracking refresh failed', error));
  });
  document.querySelectorAll('[data-close-shipment-modal]').forEach(btn => {
    btn.addEventListener('click', () => document.getElementById('shipmentModal')?.classList.remove('active'));
  });
  document.getElementById('shipmentModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
  });
});
