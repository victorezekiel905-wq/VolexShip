/* ============================================================
   VeloxShip — Core Application Logic
   Single source of truth: state, auth, shipments, messages
   ============================================================ */

const VS_STORAGE_KEY   = 'veloxship_state_v5';
const VS_SESSION_KEY   = 'veloxship_session_v5';
const VS_SHIPMENT_KEY  = 'veloxship_shipments_v5';
const ADMIN_EMAIL      = 'amos@gmail.com';
const ADMIN_PASSWORD   = 'Amos@2026';
const SITE_YEAR        = new Date().getFullYear();
const VS_API_BASE      = '/api';

const VS_GALLERY_IMAGES = Array.from({ length: 17 }, (_, i) => i + 1)
  .filter(n => n !== 13)
  .map(n => `premium-gallery-${String(n).padStart(2, '0')}.jpeg`);
window.VS_GALLERY_IMAGES = VS_GALLERY_IMAGES;

window.__veloxshipCache   = { shipments: [], mode: 'loading' };
window.__veloxshipRuntime = {
  dbReady: false,
  browserDbReady: false,
  table: 'shipment',
  supabaseUrl: 'https://udjgrrjnyhaersaiuudj.supabase.co',
  supabaseAnonKey: '',
  wsPath: '/ws'
};

const VS_SUPABASE_URL   = 'https://udjgrrjnyhaersaiuudj.supabase.co';
const VS_SUPABASE_TABLE = 'shipment';
let browserSupabase     = null;

function logDataError(scope, error, details) {
  if (details !== undefined) {
    console.error(`[VeloxShip] ${scope}`, error, details);
    return;
  }
  console.error(`[VeloxShip] ${scope}`, error);
}

function getSupabaseAnonKey() {
  return window.__veloxshipRuntime.supabaseAnonKey
    || window.VELOXSHIP_SUPABASE_ANON_KEY
    || localStorage.getItem('veloxship_supabase_anon_key')
    || '';
}

async function ensureBrowserSupabaseLib() {
  if (window.supabase?.createClient) return window.supabase;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-supabase-browser]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.supabase), { once: true });
      existing.addEventListener('error', () => reject(new Error('Supabase browser SDK failed to load.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.async = true;
    script.dataset.supabaseBrowser = 'true';
    script.onload = () => resolve(window.supabase);
    script.onerror = () => reject(new Error('Supabase browser SDK failed to load.'));
    document.head.appendChild(script);
  });
  if (!window.supabase?.createClient) throw new Error('Supabase browser SDK unavailable after load.');
  return window.supabase;
}

async function ensureBrowserSupabase() {
  if (browserSupabase) return browserSupabase;
  const anonKey = getSupabaseAnonKey();
  if (!anonKey) return null;
  const supabaseLib = await ensureBrowserSupabaseLib();
  browserSupabase = supabaseLib.createClient(VS_SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  window.__veloxshipRuntime.browserDbReady = true;
  return browserSupabase;
}

function parseShipmentMeta(row) {
  if (!row) return {};
  const raw = row.movement_history ?? row.movementHistory ?? null;
  if (!raw || Array.isArray(raw)) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (error) {
    logDataError('Failed to parse shipment movement_history.', error, raw);
    return {};
  }
}

function normalizeStatusValue(status) {
  const raw = String(status || '').trim().toLowerCase();
  if (!raw) return 'processing';
  if (['pending', 'processing'].includes(raw)) return 'processing';
  if (['confirmed', 'departed'].includes(raw)) return 'confirmed';
  if (['in transit', 'in_transit'].includes(raw)) return 'in_transit';
  if (['customs', 'customs review', 'arrived at facility', 'arrived_at_facility'].includes(raw)) return 'customs';
  if (['out for delivery', 'out_for_delivery'].includes(raw)) return 'out_for_delivery';
  if (raw === 'delivered') return 'delivered';
  if (raw === 'paused') return 'paused';
  if (raw === 'deleted') return 'deleted';
  return raw.replace(/\s+/g, '_');
}

function extractShipmentHistory(row, meta) {
  let history = row?.history ?? row?.movement_history ?? meta?.history ?? [];
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch (error) {
      logDataError('Failed to parse shipment history.', error, history);
      history = [];
    }
  }
  if (!Array.isArray(history)) return [];
  return history.map(entry => ({
    ...entry,
    status: normalizeStatusValue(entry.status || entry.statusLabel || entry.title),
    title: entry.title || entry.statusLabel || getStatusMeta(normalizeStatusValue(entry.status)).label,
    detail: entry.detail || entry.note || `Status: ${getStatusMeta(normalizeStatusValue(entry.status)).label}`
  }));
}

function normalizeMovementPlan(rawPlan) {
  let plan = rawPlan;
  if (typeof plan === 'string') {
    try { plan = JSON.parse(plan); } catch (error) {
      logDataError('Failed to parse shipment movement plan.', error, plan);
      plan = [];
    }
  }
  if (!Array.isArray(plan)) return [];
  return plan.map(event => ({
    ...event,
    scheduledAt: event.scheduledAt || event.scheduled_for || null,
    eventType: event.eventType || event.event_type || 'major',
    eventIndex: Number(event.eventIndex ?? event.event_index ?? 0),
    majorStepIndex: Number(event.majorStepIndex ?? event.major_step_index ?? 0),
    progressPercent: Number(event.progressPercent ?? event.progress_percent ?? 0)
  }));
}


/* ── Status stages ── */
const STAGES = [
  { key: 'processing',        label: 'Processing',          progress: 12 },
  { key: 'confirmed',         label: 'Departed',            progress: 25 },
  { key: 'in_transit',        label: 'In Transit',          progress: 55 },
  { key: 'customs',           label: 'Arrived at Facility', progress: 72 },
  { key: 'out_for_delivery',  label: 'Out for Delivery',    progress: 90 },
  { key: 'delivered',         label: 'Delivered',           progress: 100 },
  { key: 'paused',            label: 'Paused',              progress: 55 },
  { key: 'deleted',           label: 'Deleted',             progress: 100 }
];

/* ── Helpers ── */
function vsUid(prefix = 'vs') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
function isAdminEmail(e = '') { return e.trim().toLowerCase() === ADMIN_EMAIL; }

function formatDateTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
function formatDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit'
  });
}
function money(v) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v || 0));
}
function getStatusMeta(status) {
  const stage = STAGES.find(s => s.key === status) || { label: status || 'Unknown', progress: 10 };
  const toneMap = {
    processing: 'info', confirmed: 'info', in_transit: 'warning',
    customs: 'warning', out_for_delivery: 'info', delivered: 'success', paused: 'danger', deleted: 'danger'
  };
  return { ...stage, tone: toneMap[normalizeStatusValue(status)] || 'info' };
}

/* ── State (users, requests, messages) ── */
function seedState() {
  return { users: [], requests: [], messages: [], updatedAt: new Date().toISOString() };
}
function readState() {
  try {
    const raw = localStorage.getItem(VS_STORAGE_KEY);
    if (!raw) { const s = seedState(); saveState(s); return s; }
    const p = JSON.parse(raw);
    p.users    = Array.isArray(p.users)    ? p.users    : [];
    p.requests = Array.isArray(p.requests) ? p.requests : [];
    p.messages = Array.isArray(p.messages) ? p.messages : [];
    return p;
  } catch { const s = seedState(); saveState(s); return s; }
}
function saveState(state) {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(VS_STORAGE_KEY, JSON.stringify(state));
  return state;
}

/* ── Session ── */
function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem(VS_SESSION_KEY));
    if (session) return session;
  } catch {}
  if (localStorage.getItem('role') === 'admin' || localStorage.getItem('isAdmin') === 'true') {
    return {
      id: 'admin_ops',
      email: ADMIN_EMAIL,
      role: 'admin',
      name: 'Operations Admin',
      adminToken: null
    };
  }
  return null;
}
function setSession(user) {
  localStorage.setItem(VS_SESSION_KEY, JSON.stringify({
    id: user.id, email: user.email, role: user.role,
    name: user.name, adminToken: user.adminToken || null
  }));
  if (user?.role === 'admin') {
    localStorage.setItem('role', 'admin');
    localStorage.setItem('isAdmin', 'true');
  } else {
    localStorage.removeItem('role');
    localStorage.removeItem('isAdmin');
  }
}
function clearSession() {
  localStorage.removeItem(VS_SESSION_KEY);
  localStorage.removeItem('role');
  localStorage.removeItem('isAdmin');
}

function getAdminUser() {
  return {
    id: 'admin_ops', name: 'Operations Admin', email: ADMIN_EMAIL,
    role: 'admin', phone: '', company: 'VeloxShip Operations',
    address: 'VeloxShip HQ', createdAt: new Date().toISOString()
  };
}

function getCurrentUser() {
  const s = readSession();
  if (!s) return null;
  if (s.role === 'admin' && isAdminEmail(s.email)) {
    return { ...getAdminUser(), name: s.name || 'Operations Admin', adminToken: s.adminToken };
  }
  return getAllUsers().find(u => u.id === s.id) || null;
}

/* ── Users ── */
function getAllUsers() {
  return [...readState().users].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function getAllRequests() {
  return [...readState().requests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/* ── Messages ── */
function getAllMessages() {
  return [...readState().messages].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function getMessagesForUser(email) {
  if (!email) return [];
  const e = email.toLowerCase();
  return getAllMessages().filter(m => m.to === 'all' || m.to.toLowerCase() === e);
}
function sendMessage({ to, subject, body }) {
  const state = readState();
  const msg = {
    id: vsUid('msg'),
    to: to || 'all',
    subject: subject || '(No subject)',
    body: body || '',
    createdAt: new Date().toISOString(),
    readBy: []
  };
  state.messages.unshift(msg);
  saveState(state);
  return msg;
}
function markMessageRead(msgId, email) {
  const state = readState();
  const msg = state.messages.find(m => m.id === msgId);
  if (msg && !msg.readBy.includes(email.toLowerCase())) {
    msg.readBy.push(email.toLowerCase());
    saveState(state);
  }
}
function countUnreadMessages(email) {
  if (!email) return 0;
  return getMessagesForUser(email).filter(m => !m.readBy.includes(email.toLowerCase())).length;
}

/* ── Shipments (localStorage fallback) ── */
function readLocalShipments() {
  try {
    const raw = localStorage.getItem(VS_SHIPMENT_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}
function saveLocalShipments(shipments) {
  localStorage.setItem(VS_SHIPMENT_KEY, JSON.stringify(shipments));
}
function getAllShipments() {
  return [...(window.__veloxshipCache.shipments || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}
function getUserShipments(user) {
  return getAllShipments().filter(shipment => {
    if (user?.id && shipment.userId) return shipment.userId === user.id;
    return (shipment.customerEmail || '').toLowerCase() === (user?.email || '').toLowerCase();
  });
}

function normalizeShipment(row) {
  if (!row) return null;
  const meta = parseShipmentMeta(row);
  const history = extractShipmentHistory(row, meta);
  const movementPlan = normalizeMovementPlan(row.movementPlan || row.movement_plan || meta.movementPlan || []);
  return {
    id: row.id || meta.id || vsUid('shp'),
    trackingCode: row.trackingCode || row.tracking_code || meta.trackingCode || '',
    userId: row.userId || row.user_id || meta.userId || '',
    customerEmail: row.customerEmail || row.customer_email || row.email || meta.customerEmail || '',
    customerName: row.customerName || row.customer_name || row.full_name || meta.customerName || '',
    phone: row.phone || meta.phone || '',
    address: row.address || meta.address || '',
    productName: row.productName || row.product_name || row.shipment_title || meta.productName || 'Unnamed item',
    productCategory: row.productCategory || row.product_category || meta.productCategory || 'General cargo',
    productDescription: row.productDescription || row.product_description || meta.productDescription || '',
    quantity: Number(row.quantity ?? meta.quantity ?? 1),
    weightKg: Number(row.weightKg ?? row.weight_kg ?? row.weight ?? meta.weightKg ?? 1),
    valueUsd: Number(row.valueUsd ?? row.value_usd ?? meta.valueUsd ?? 0),
    origin: row.origin || meta.origin || '—',
    destination: row.destination || meta.destination || '—',
    currentLocation: row.currentLocation || row.current_location || meta.currentLocation || movementPlan[0]?.location || row.origin || 'Origin hub',
    shippingMode: row.shippingMode || row.shipping_mode || meta.shippingMode || 'Express',
    priority: row.priority || meta.priority || 'Priority',
    status: normalizeStatusValue(row.status || row.Status || meta.status || 'processing'),
    statusControl: row.statusControl || row.status_control || meta.statusControl || 'active',
    pausedReason: row.pausedReason || row.paused_reason || meta.pausedReason || '',
    pausedAt: row.pausedAt || row.pause_started_at || meta.pausedAt || null,
    pausedProgress: row.pausedProgress ?? row.paused_progress ?? meta.pausedProgress ?? null,
    departureTime: row.departureTime || row.departure_time || meta.departureTime || null,
    estimatedArrival: row.estimatedArrival || row.estimated_arrival || row.estimated_delivery || meta.estimatedArrival || null,
    deliveryDeadline: row.deliveryDeadline || row.delivery_deadline || meta.deliveryDeadline || row.estimated_delivery || null,
    createdAt: row.createdAt || row.created_at || meta.createdAt || new Date().toISOString(),
    updatedAt: row.updatedAt || row.updated_at || meta.updatedAt || new Date().toISOString(),
    notes: row.notes || meta.notes || '',
    confirmedByCustomer: Boolean(row.confirmedByCustomer ?? row.confirmed_by_customer ?? meta.confirmedByCustomer),
    deleted: Boolean(row.deleted ?? meta.deleted ?? (normalizeStatusValue(row.status || row.Status || meta.status) === 'deleted')),
    deletedAt: row.deleted_at || meta.deletedAt || null,
    currentStep: Number(row.currentStep ?? row.current_step ?? meta.currentStep ?? 0),
    currentEventIndex: Number(row.currentEventIndex ?? row.current_event_index ?? meta.currentEventIndex ?? (history.length ? history.length - 1 : 0)),
    totalSteps: Number(row.totalSteps ?? row.total_steps ?? meta.totalSteps ?? movementPlan.length ?? 0),
    totalEvents: Number(row.totalEvents ?? row.total_events ?? meta.totalEvents ?? movementPlan.length ?? 0),
    nextMovementAt: row.nextMovementAt || row.next_movement_at || meta.nextMovementAt || null,
    nextSimulationAt: row.nextSimulationAt || row.next_simulation_at || meta.nextSimulationAt || null,
    stepIntervalHours: Number(row.stepIntervalHours ?? row.movement_step_interval_hours ?? meta.stepIntervalHours ?? 0),
    movementPlan,
    history: Array.isArray(history) ? history : []
  };
}


function mergeShipmentIntoCache(shipment) {
  const n = normalizeShipment(shipment);
  if (!n) return null;
  const list = Array.isArray(window.__veloxshipCache.shipments) ? [...window.__veloxshipCache.shipments] : [];
  const idx  = list.findIndex(s => s.id === n.id || s.trackingCode === n.trackingCode);
  if (idx >= 0) list[idx] = n; else list.unshift(n);
  window.__veloxshipCache.shipments = list;
  return n;
}

/* ── Progress ── */
function computeShipmentProgress(shipment) {
  if (!shipment) return 0;
  if (shipment.status === 'delivered' || shipment.status === 'deleted') return 100;

  const plan = Array.isArray(shipment.movementPlan) ? shipment.movementPlan : [];
  const totalSteps = Math.max(plan.length - 1, Number(shipment.totalEvents || shipment.totalSteps || 0) - 1, 1);
  const currentIndex = clamp(Number(shipment.currentEventIndex ?? shipment.currentStep ?? 0), 0, totalSteps);
  const discreteProgress = (currentIndex / totalSteps) * 100;

  if (shipment.status === 'paused' && shipment.pausedProgress != null) {
    return clamp(shipment.pausedProgress, 0, 100);
  }

  return clamp(discreteProgress || getStatusMeta(shipment.status).progress, 0, 100);
}

function isShipmentMotionActive(shipment) {
  return Boolean(
    shipment
    && shipment.statusControl !== 'paused'
    && !['paused', 'delivered', 'deleted'].includes(shipment.status)
  );
}


/* ── ETA countdown ── */
function calcEtaBreakdown(iso) {
  if (!iso) return { text: 'ETA pending', expired: false };
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return { text: 'Arriving now', expired: true };
  const d = Math.floor(diff / 86400000);
  const h = Math.ceil((diff % 86400000) / 3600000);
  return { text: `Arriving in ${d} day${d === 1 ? '' : 's'} ${h} hour${h === 1 ? '' : 's'}`, expired: false };
}
function calcEtaCountdown(iso) { return calcEtaBreakdown(iso).text; }
function getShipmentEtaText(shipment) {
  if (!shipment) return 'ETA pending';
  if (shipment.status === 'delivered') return 'Delivered';
  if (shipment.status === 'out_for_delivery') return 'Out for delivery';
  return calcEtaCountdown(shipment.estimatedArrival);
}

/* ── Badges ── */
function shipmentStatusBadge(status) {
  const m = getStatusMeta(status);
  return `<span class="badge ${m.tone}">${m.label}</span>`;
}

/* ── Shipment visuals ── */
const SHIPMENT_VISUALS = [
  'dashboard-visual.jpeg','customer-delivery.jpeg','cargo-ship.jpeg',
  'scan-shipping.jpeg','trucks-primary.jpeg','trucks-secondary.jpeg',
  'trucks-tertiary.jpeg','worker-containers.jpeg',
  'premium-gallery-05.jpeg','premium-gallery-07.jpeg','premium-gallery-10.jpeg',
  'premium-gallery-12.jpeg','premium-gallery-14.jpeg'
];
function shipmentImage(shipment) {
  if (shipment.status === 'delivered') return 'customer-delivery.jpeg';
  if (shipment.status === 'paused')    return 'premium-gallery-07.jpeg';
  if ((shipment.shippingMode || '').toLowerCase().includes('freight')) return 'cargo-ship.jpeg';
  const seed = [...`${shipment.id}${shipment.productName}`].reduce((s, c) => s + c.charCodeAt(0), 0);
  return SHIPMENT_VISUALS[seed % SHIPMENT_VISUALS.length];
}

/* ── Shipment card markup ── */
function shipmentCardMarkup(shipment, options = {}) {
  const latest   = (shipment.history || [])[0];
  const paused   = shipment.status === 'paused' && shipment.pausedReason;
  const progress = computeShipmentProgress(shipment);
  const actionMarkup = options.showActions || '';
  const dept = shipment.departureTime ? formatDateTime(shipment.departureTime) : '—';
  return `
    <article class="shipment-card">
      <div class="shipment-surface">
        <div class="shipment-thumb">
          <img src="${shipmentImage(shipment)}" alt="${shipment.productName}" loading="lazy">
        </div>
        <div class="shipment-content stack">
          <div class="shipment-top">
            <div class="stack">
              <div class="shipment-head">
                <div>
                  <div class="shipment-title">${shipment.productName}</div>
                  <div class="shipment-meta">
                    <span>${shipment.shippingMode}</span><span>•</span>
                    <span>${shipment.origin} → ${shipment.destination}</span>
                  </div>
                </div>
                ${shipmentStatusBadge(shipment.status)}
              </div>
              <div class="shipment-code"><i class="fa-solid fa-barcode"></i>${shipment.trackingCode}</div>
            </div>
            <div class="stack shipment-top-actions">
              <div class="timer-pill eta-live" data-shipment-eta="${shipment.id}">${getShipmentEtaText(shipment)}</div>
              <button class="btn btn-secondary btn-sm" data-view-shipment="${shipment.id}">Open live view</button>
            </div>
          </div>
          <div class="shipment-progress-wrap">
            <div class="shipment-progress"><span style="width:${progress}%"></span></div>
            <div class="motion-lane" data-progress-shipment="${shipment.id}" style="--progress:${progress}%">
              <span class="route-node start">${shipment.origin}</span>
              <span class="truck-marker"><i class="fa-solid fa-truck-fast"></i></span>
              <span class="route-node end">${shipment.destination}</span>
            </div>
          </div>
          <div class="shipment-meta-grid">
            <div><label>Current location</label><strong>${shipment.currentLocation || '—'}</strong></div>
            <div><label>Takeoff</label><strong>${dept}</strong></div>
            <div><label>ETA</label><strong class="eta-live" data-shipment-eta="${shipment.id}">${getShipmentEtaText(shipment)}</strong></div>
            <div><label>Priority</label><strong>${shipment.priority}</strong></div>
          </div>
          ${shipment.status === 'deleted' ? `<div class="status-banner"><i class="fa-solid fa-trash-can"></i><div><strong>Shipment deleted</strong><p>Shipment has been deleted</p></div></div>` : ''}
          ${paused ? `<div class="status-banner"><i class="fa-solid fa-circle-pause"></i><div><strong>Movement paused</strong><p>${shipment.pausedReason}</p></div></div>` : ''}
          ${latest ? `<div class="timeline compact-timeline"><div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-body"><strong><span>${formatDateTime(latest.time)} — ${latest.location}</span><span>${latest.title}</span></strong><span>Status: ${getStatusMeta(latest.status).label}${latest.note || latest.detail ? ` · Note: ${latest.note || latest.detail}` : ''}</span></div></div></div>` : ''}
          ${actionMarkup}
        </div>
      </div>
    </article>`;
}

/* ── Shipment detail markup (modal) ── */
function shipmentDetailMarkup(shipment) {
  const progress = computeShipmentProgress(shipment);
  const dept     = shipment.departureTime ? formatDateTime(shipment.departureTime) : '—';
  const elapsed  = shipment.departureTime
    ? (() => {
        const diff = Date.now() - new Date(shipment.departureTime).getTime();
        if (diff < 0) return 'Not yet departed';
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        return `${d}d ${h}h ${m}m in transit`;
      })()
    : '—';

  const historyHtml = (shipment.history || []).map(e => `
    <div class="timeline-item">
      <div class="timeline-dot ${e.status === 'delivered' ? 'success' : e.status === 'paused' ? 'danger' : ''}"></div>
      <div class="timeline-body">
        <strong><span>${formatDateTime(e.time)} — ${e.location}</span><span>${getStatusMeta(e.status).label}</span></strong>
        <span>Status: ${getStatusMeta(e.status).label}${e.note || e.detail ? ` · Note: ${e.note || e.detail}` : ''}</span>
      </div>
    </div>`).join('') || '<p class="muted">No movement events yet.</p>';

  return `
    <div class="stack shipment-detail-stack">
      <div class="shipment-code"><i class="fa-solid fa-barcode"></i>${shipment.trackingCode}</div>
      <div class="shipment-progress-wrap detail-progress-wrap">
        <div class="shipment-progress"><span style="width:${progress}%"></span></div>
        <div class="motion-lane large" data-progress-shipment="${shipment.id}" style="--progress:${progress}%">
          <span class="route-node start">${shipment.origin}</span>
          <span class="truck-marker"><i class="fa-solid fa-truck-fast"></i></span>
          <span class="route-node end">${shipment.destination}</span>
        </div>
      </div>
      <div class="detail-flight-strip">
        <div class="flight-node">
          <div class="flight-label">Takeoff</div>
          <div class="flight-value">${dept}</div>
          <div class="flight-place">${shipment.origin}</div>
        </div>
        <div class="flight-middle">
          <div class="flight-elapsed" id="elapsedDisplay">${elapsed}</div>
          <div class="flight-line"><i class="fa-solid fa-plane"></i></div>
        </div>
        <div class="flight-node right">
          <div class="flight-label">Arrival</div>
          <div class="flight-value eta-live" data-shipment-eta="${shipment.id}">${getShipmentEtaText(shipment)}</div>
          <div class="flight-place">${shipment.destination}</div>
        </div>
      </div>
      <div class="shipment-meta-grid detail-meta-grid">
        <div><label>Product</label><strong>${shipment.productName}</strong></div>
        <div><label>Category</label><strong>${shipment.productCategory}</strong></div>
        ${shipment.productDescription ? `<div class="span2"><label>Description</label><strong>${shipment.productDescription}</strong></div>` : ''}
        <div><label>Customer</label><strong>${shipment.customerName || shipment.customerEmail || 'Unassigned'}</strong></div>
        <div><label>Qty / Weight</label><strong>${shipment.quantity} pcs · ${shipment.weightKg} kg</strong></div>
        <div><label>Current status</label><strong>${getStatusMeta(shipment.status).label}</strong></div>
        <div><label>Current location</label><strong>${shipment.currentLocation}</strong></div>
        <div><label>Shipping mode</label><strong>${shipment.shippingMode}</strong></div>
        <div><label>Created</label><strong>${formatDateTime(shipment.createdAt)}</strong></div>
      </div>
      ${shipment.status === 'deleted' ? `<div class="status-banner"><i class="fa-solid fa-trash-can"></i><div><strong>Shipment deleted</strong><p>Shipment has been deleted</p></div></div>` : ''}
      ${shipment.pausedReason ? `<div class="status-banner"><i class="fa-solid fa-triangle-exclamation"></i><div><strong>Delay notice</strong><p>${shipment.pausedReason}</p></div></div>` : ''}
      <div class="stack"><h4 class="timeline-heading"><i class="fa-solid fa-route"></i> Delivery Movement Timeline</h4>
        <div class="timeline">${historyHtml}</div>
      </div>
    </div>`;
}

/* ── Find shipment ── */
function findShipmentByCode(code) {
  return getAllShipments().find(s =>
    s.trackingCode.toUpperCase() === (code || '').trim().toUpperCase()
  ) || null;
}

async function fetchShipmentByCode(code) {
  const c = (code || '').trim().toUpperCase();
  if (!c) throw new Error('Tracking code is required.');
  const cached = findShipmentByCode(c);
  if (cached) return cached;
  if (window.__veloxshipRuntime.dbReady) {
    try {
      const data = await apiFetch(`/shipments/lookup/${encodeURIComponent(c)}`);
      return mergeShipmentIntoCache(data.shipment);
    } catch (error) {
      logDataError('Server tracking lookup failed.', error);
    }
  }
  try {
    const client = await ensureBrowserSupabase();
    if (client) {
      const { data, error } = await client
        .from(VS_SUPABASE_TABLE)
        .select('*')
        .eq('tracking_code', c)
        .maybeSingle();
      if (error) throw error;
      if (data) return mergeShipmentIntoCache(normalizeShipment(data));
    }
  } catch (error) {
    logDataError('Supabase tracking lookup failed.', error);
  }
  throw new Error('Shipment not found. Please check the tracking code and try again.');
}

/* ── Auth ── */
function signupUser({ name, email, password, phone = '', company = '', address = '' }) {
  const state = readState();
  const safe  = email.trim().toLowerCase();
  if (isAdminEmail(safe)) throw new Error('This email is reserved.');
  if (state.users.some(u => u.email === safe)) throw new Error('An account with this email already exists.');
  const user = {
    id: vsUid('usr'), name: name.trim(), email: safe,
    password, phone, company, address, role: 'user',
    createdAt: new Date().toISOString()
  };
  state.users.push(user);
  saveState(state);
  setSession(user);
  return user;
}

async function loginUser(email, password) {
  const safe = email.trim().toLowerCase();
  if (isAdminEmail(safe)) {
    if (window.__veloxshipRuntime.dbReady) {
      try {
        const data = await apiFetch('/auth/admin/login', {
          method: 'POST',
          body: JSON.stringify({ email: safe, password })
        });
        const admin = { ...getAdminUser(), adminToken: data.token || null };
        setSession(admin);
        return admin;
      } catch (error) {
        logDataError('Admin API login failed. Falling back to local admin auth.', error);
      }
    }
    if (password !== ADMIN_PASSWORD) throw new Error('Invalid email or password.');
    const admin = { ...getAdminUser(), adminToken: null };
    setSession(admin);
    return admin;
  }
  const user = readState().users.find(u => u.email === safe && u.password === password);
  if (!user) throw new Error('Invalid email or password.');
  setSession(user);
  return user;
}

function logoutUser() {
  clearSession();
  window.location.href = 'index.html';
}

function requireRole(role) {
  const user = getCurrentUser();
  if (!user) { window.location.href = 'login.html'; return null; }
  if (role === 'admin' && user.role !== 'admin') { window.location.href = 'dashboard.html'; return null; }
  if (role === 'user'  && user.role !== 'user')  { window.location.href = 'admin.html';     return null; }
  return user;
}

/* ── API ── */
function buildAdminHeaders() {
  const u = getCurrentUser();
  if (!u || u.role !== 'admin') return {};
  return {
    ...(u.adminToken ? { Authorization: `Bearer ${u.adminToken}` } : {}),
    'x-admin-email': ADMIN_EMAIL,
    'x-admin-password': ADMIN_PASSWORD
  };
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${VS_API_BASE}${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const error = new Error(data.error || data.message || 'Request failed.');
    logDataError(`API request failed for ${path}.`, error, data);
    throw error;
  }
  return data;
}

async function loadRuntimeConfig() {
  try {
    const d = await apiFetch('/runtime');
    window.__veloxshipRuntime = {
      ...window.__veloxshipRuntime,
      ...d,
      table: d.table || VS_SUPABASE_TABLE,
      supabaseUrl: d.supabaseUrl || VS_SUPABASE_URL,
      supabaseAnonKey: d.supabaseAnonKey || window.__veloxshipRuntime.supabaseAnonKey || ''
    };
    if (window.__veloxshipRuntime.supabaseAnonKey) {
      localStorage.setItem('veloxship_supabase_anon_key', window.__veloxshipRuntime.supabaseAnonKey);
    }
    if (!window.__veloxshipRuntime.dbReady && getSupabaseAnonKey()) {
      await ensureBrowserSupabase();
    }
  } catch (error) {
    logDataError('Runtime configuration request failed.', error);
    if (getSupabaseAnonKey()) {
      try { await ensureBrowserSupabase(); } catch (sdkError) {
        logDataError('Browser Supabase initialization failed.', sdkError);
      }
    }
  }
}

/* ── Shipments CRUD ── */
function generateTrackingCode(existing = []) {
  let code;
  do {
    const chunk = Math.random().toString(36).slice(2, 8).toUpperCase();
    code = `VLX-${SITE_YEAR}-${chunk}`;
  } while (existing.includes(code));
  return code;
}

function appendHistory(shipment, entry) {
  shipment.history = shipment.history || [];
  shipment.history.unshift({ id: vsUid('evt'), time: new Date().toISOString(), ...entry });
}

async function ensureShipmentsLoaded(force = false) {
  const ctx  = getLoadContext();
  const list = window.__veloxshipCache.shipments;
  if (!force && Array.isArray(list) && list.length && ctx !== 'public') return list;

  if (ctx === 'public') {
    window.__veloxshipCache.shipments = [];
    window.__veloxshipCache.mode = 'local';
    return [];
  }

  if (window.__veloxshipRuntime.dbReady) {
    try {
      const u    = getCurrentUser();
      const data = ctx === 'admin'
        ? await apiFetch('/shipments', { headers: buildAdminHeaders() })
        : await apiFetch('/shipments/mine', { headers: { 'x-customer-email': u?.email || '', 'x-customer-user-id': u?.id || '' } });
      const shipments = (data.shipments || []).map(normalizeShipment).filter(Boolean);
      window.__veloxshipCache.shipments = shipments;
      window.__veloxshipCache.mode = 'cloud';
      saveLocalShipments(shipments);
      return shipments;
    } catch (error) {
      logDataError('Server shipment fetch failed.', error);
    }
  }

  try {
    const client = await ensureBrowserSupabase();
    if (client) {
      const user = getCurrentUser();
      let query = client.from(VS_SUPABASE_TABLE).select('*').order('created_at', { ascending: false });
      if (ctx === 'user') {
        query = query.ilike('email', (user?.email || '').trim().toLowerCase());
      }
      const { data, error } = await query;
      if (error) throw error;
      const shipments = (data || []).map(normalizeShipment).filter(Boolean);
      window.__veloxshipCache.shipments = shipments;
      window.__veloxshipCache.mode = 'cloud';
      saveLocalShipments(shipments);
      return shipments;
    }
  } catch (error) {
    logDataError('Browser Supabase shipment fetch failed.', error);
  }

  const local = readLocalShipments().map(normalizeShipment).filter(Boolean);
  window.__veloxshipCache.shipments = local;
  window.__veloxshipCache.mode = 'local';
  return local;
}

function getLoadContext() {
  const page = document.body?.dataset?.page || '';
  const u    = getCurrentUser();
  if (page === 'admin'     && u?.role === 'admin') return 'admin';
  if (page === 'dashboard' && u?.role === 'user')  return 'user';
  return 'public';
}

async function createShipment(payload) {
  await ensureShipmentsLoaded();
  const code     = generateTrackingCode(getAllShipments().map(s => s.trackingCode));
  const shipment = normalizeShipment({
    id: vsUid('shp'),
    trackingCode: code,
    customerEmail: (payload.customerEmail || '').trim().toLowerCase(),
    customerName: payload.customerName || '',
    productName: payload.productName || 'Unnamed item',
    productCategory: payload.productCategory || 'General cargo',
    productDescription: payload.productDescription || '',
    quantity: Number(payload.quantity || 1),
    weightKg: Number(payload.weightKg || 1),
    valueUsd: Number(payload.valueUsd || 0),
    origin: payload.origin || '—',
    destination: payload.destination || '—',
    currentLocation: payload.currentLocation || payload.origin || 'Origin hub',
    shippingMode: payload.shippingMode || 'Express',
    priority: payload.priority || 'Priority',
    status: payload.status || 'processing',
    departureTime: payload.departureTime || null,
    estimatedArrival: payload.estimatedArrival || null,
    createdAt: new Date().toISOString(),
    notes: payload.notes || '',
    confirmedByCustomer: false,
    history: []
  });

  appendHistory(shipment, {
    status: shipment.status,
    title: 'Tracking registered',
    location: shipment.currentLocation,
    detail: `Shipment registered and tracking code ${code} issued.`
  });

  if (shipment.departureTime) {
    appendHistory(shipment, {
      status: 'confirmed',
      title: 'Departure scheduled',
      location: shipment.origin,
      detail: `Scheduled takeoff from ${shipment.origin} at ${formatDateTime(shipment.departureTime)}.`
    });
  }

  if (window.__veloxshipRuntime.dbReady) {
    try {
      const data = await apiFetch('/shipments', {
        method: 'POST', headers: buildAdminHeaders(),
        body: JSON.stringify({
          trackingCode: shipment.trackingCode,
          customerName: shipment.customerName,
          customerEmail: shipment.customerEmail,
          customerUserId: payload.customerUserId || payload.userId || '',
          productName: shipment.productName,
          productCategory: shipment.productCategory,
          productDescription: shipment.productDescription,
          quantity: shipment.quantity,
          weightKg: shipment.weightKg,
          valueUsd: shipment.valueUsd,
          origin: shipment.origin,
          destination: shipment.destination,
          status: shipment.status,
          currentLocation: shipment.currentLocation,
          shippingMode: shipment.shippingMode,
          priority: shipment.priority,
          departureTime: shipment.departureTime,
          estimatedArrival: shipment.estimatedArrival,
          createdAt: shipment.createdAt,
          notes: shipment.notes,
          confirmedByCustomer: shipment.confirmedByCustomer,
          history: shipment.history
        })
      });
      const saved = normalizeShipment(data.shipment || { ...shipment, id: data.shipment?.id || shipment.id });
      window.__veloxshipCache.shipments.unshift(saved);
      saveLocalShipments(window.__veloxshipCache.shipments);
      return saved;
    } catch (error) {
      logDataError('Shipment creation API failed.', error, shipment);
      showToast('Saved locally (DB unavailable).', 'warning');
    }
  }

  window.__veloxshipCache.shipments.unshift(shipment);
  saveLocalShipments(window.__veloxshipCache.shipments);
  return shipment;
}

async function updateShipment(id, updates) {
  await ensureShipmentsLoaded();
  const shipment = getAllShipments().find(s => s.id === id);
  if (!shipment) throw new Error('Shipment not found.');
  const prev     = shipment.status;
  const priorP   = computeShipmentProgress(shipment);
  const next     = JSON.parse(JSON.stringify(shipment));
  Object.assign(next, updates);

  if (updates.status === 'paused') {
    next.pausedProgress = priorP;
    next.pausedReason   = updates.pausedReason || next.pausedReason || 'Movement paused by operations.';
  }
  if (prev === 'paused' && updates.status && updates.status !== 'paused') {
    next.pausedProgress = null;
    if (!updates.pausedReason) next.pausedReason = '';
  }

  if (updates.status && updates.status !== prev) {
    appendHistory(next, {
      status: updates.status,
      title: updates.historyTitle || `Status: ${getStatusMeta(updates.status).label}`,
      location: updates.currentLocation || next.currentLocation,
      detail: updates.historyDetail || (updates.status === 'paused'
        ? next.pausedReason : 'Shipment updated by operations.')
    });
  } else if (updates.historyTitle || updates.historyDetail || updates.currentLocation) {
    appendHistory(next, {
      status: next.status,
      title: updates.historyTitle || 'Location update',
      location: updates.currentLocation || next.currentLocation,
      detail: updates.historyDetail || 'Shipment location refreshed.'
    });
  }

  if (window.__veloxshipRuntime.dbReady) {
    try {
      const data = await apiFetch(`/shipments/${id}`, {
        method: 'PATCH', headers: buildAdminHeaders(),
        body: JSON.stringify({
          status: next.status,
          currentLocation: next.currentLocation,
          estimatedArrival: next.estimatedArrival,
          departureTime: next.departureTime,
          pausedReason: next.pausedReason,
          notes: next.notes,
          history: next.history
        })
      });
      const saved = normalizeShipment(data.shipment || next);
      window.__veloxshipCache.shipments = getAllShipments().map(s => s.id === id ? saved : s);
      saveLocalShipments(window.__veloxshipCache.shipments);
      return saved;
    } catch (error) {
      logDataError('Shipment update API failed.', error, { id, updates: next });
      showToast('Updated locally (DB unavailable).', 'warning');
    }
  }

  window.__veloxshipCache.shipments = getAllShipments().map(s => s.id === id ? next : s);
  saveLocalShipments(window.__veloxshipCache.shipments);
  return next;
}

async function deleteShipment(id) {
  await ensureShipmentsLoaded();
  if (window.__veloxshipRuntime.dbReady) {
    try {
      await apiFetch(`/shipments/${id}`, { method: 'DELETE', headers: buildAdminHeaders() });
    } catch (error) {
      logDataError('Shipment delete API failed.', error, { id });
      showToast('Deleted locally (DB unavailable).', 'warning');
    }
  }
  window.__veloxshipCache.shipments = getAllShipments().filter(s => s.id !== id);
  saveLocalShipments(window.__veloxshipCache.shipments);
}

async function claimTrackingCode(user, code) {
  await ensureShipmentsLoaded();
  let shipment = getAllShipments().find(s =>
    s.trackingCode.toUpperCase() === (code || '').trim().toUpperCase()
  );
  if (!shipment) shipment = await fetchShipmentByCode(code);
  if (!shipment) throw new Error('Tracking code not found.');
  if (shipment.customerEmail && shipment.customerEmail.toLowerCase() !== user.email.toLowerCase())
    throw new Error('This tracking code is already assigned to another account.');

  const next = JSON.parse(JSON.stringify(shipment));
  next.customerEmail = user.email;
  next.customerName  = user.name;
  next.confirmedByCustomer = true;
  appendHistory(next, {
    status: next.status,
    title: 'Customer confirmed tracking',
    location: next.currentLocation,
    detail: `${user.name} linked this shipment to their dashboard.`
  });

  if (window.__veloxshipRuntime.dbReady) {
    try {
      const data = await apiFetch(`/shipments/${next.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          claimTracking: true,
          customerEmail: next.customerEmail,
          customerUserId: user?.id || '',
          customerName: next.customerName,
          confirmedByCustomer: true,
          history: next.history
        })
      });
      const saved = normalizeShipment(data.shipment || next);
      window.__veloxshipCache.shipments = getAllShipments().map(s => s.id === next.id ? saved : s);
      saveLocalShipments(window.__veloxshipCache.shipments);
      return saved;
    } catch (error) {
      logDataError('Claim tracking API failed.', error, { id: next.id, email: next.customerEmail });
      showToast('Linked locally (DB unavailable).', 'warning');
    }
  }

  window.__veloxshipCache.shipments = getAllShipments().map(s => s.id === next.id ? next : s);
  saveLocalShipments(window.__veloxshipCache.shipments);
  return next;
}

/* ── Toast ── */
function showToast(message, tone = 'info') {
  let toast = document.getElementById('vsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'vsToast';
    toast.className = 'vs-toast';
    document.body.appendChild(toast);
  }
  toast.className = `vs-toast ${tone} show`;
  toast.textContent = message;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3000);
}

/* ── Live telemetry ── */
function ensureBlinkAddressMarker(marker) {
  if (!marker) return null;
  marker.style.position = 'absolute';
  marker.style.left = 'calc(var(--progress, 0%) - 10px)';
  marker.style.zIndex = '2';
  marker.style.transition = 'left .8s ease';

  let addressMarker = marker.querySelector('.vs-address-marker');
  if (!addressMarker) {
    addressMarker = document.createElement('span');
    addressMarker.className = 'vs-address-marker';
    addressMarker.setAttribute('aria-hidden', 'true');
    addressMarker.innerHTML = '<i class="fa-solid fa-location-dot"></i>';
    addressMarker.style.position = 'absolute';
    addressMarker.style.left = '50%';
    addressMarker.style.top = '-18px';
    addressMarker.style.transform = 'translateX(-50%)';
    addressMarker.style.fontSize = '0.72rem';
    addressMarker.style.lineHeight = '1';
    addressMarker.style.color = '#ef4444';
    addressMarker.style.pointerEvents = 'none';
    addressMarker.style.transition = 'opacity .2s ease, transform .2s ease';
    marker.appendChild(addressMarker);
  }
  return addressMarker;
}

function syncLaneMotion(lane, shipment) {
  const progress = computeShipmentProgress(shipment);
  lane.style.setProperty('--progress', `${progress}%`);
  const bar = lane.closest('.shipment-progress-wrap')?.querySelector('.shipment-progress > span');
  if (bar) bar.style.width = `${progress}%`;

  const marker = lane.querySelector('.truck-marker');
  if (!marker) return;

  const addressMarker = ensureBlinkAddressMarker(marker);
  const active = isShipmentMotionActive(shipment);
  const phaseOn = Math.floor(Date.now() / 800) % 2 === 0;

  marker.style.opacity = '1';
  marker.style.filter = active ? 'drop-shadow(0 0 8px rgba(37,99,235,.35))' : 'none';
  marker.style.transform = 'translateY(0)';
  marker.title = `${shipment.currentLocation || 'Current location'} · ${getStatusMeta(shipment.status).label}`;
  marker.dataset.location = shipment.currentLocation || '';
  marker.dataset.status = shipment.status || '';

  if (addressMarker) {
    addressMarker.style.opacity = active ? (phaseOn ? '1' : '0.22') : '0';
    addressMarker.style.transform = active
      ? `translateX(-50%) translateY(${phaseOn ? '-1px' : '1px'})`
      : 'translateX(-50%) translateY(0)';
  }
}

function refreshLiveTelemetry(scope = document) {
  scope.querySelectorAll('[data-shipment-eta]').forEach(node => {
    const shipment = getAllShipments().find(item => String(item.id) === String(node.dataset.shipmentEta));
    if (!shipment) return;
    node.textContent = getShipmentEtaText(shipment);
  });

  scope.querySelectorAll('[data-progress-shipment]').forEach(lane => {
    const shipment = getAllShipments().find(item => String(item.id) === String(lane.dataset.progressShipment));
    if (!shipment) return;
    syncLaneMotion(lane, shipment);
  });

  const el = document.getElementById('elapsedDisplay');
  if (el) {
    const shipId = el.closest('[data-shipment-id]')?.dataset?.shipmentId;
    if (!shipId) return;
    const shipment = getAllShipments().find(item => String(item.id) === String(shipId));
    if (!shipment || !shipment.departureTime) return;
    const diff = Date.now() - new Date(shipment.departureTime).getTime();
    if (diff < 0) { el.textContent = 'Not yet departed'; return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    el.textContent = `${d}d ${h}h ${m}m in transit`;
  }
}
function startLiveTelemetry() {
  refreshLiveTelemetry();
  clearInterval(window.__vsTelemetry);
  window.__vsTelemetry = setInterval(refreshLiveTelemetry, 800);
}

function getDataModeLabel() {
  if (window.__veloxshipCache.mode === 'cloud') return 'Database connected';
  if (window.__veloxshipRuntime.browserDbReady) return 'Database connected';
  return 'Local mode';
}

/* ── Request ── */
function createShippingRequest(user, payload) {
  const state = readState();
  const req = {
    id: vsUid('req'),
    customerEmail: payload.customerEmail || user?.email || '',
    customerName: payload.customerName || user?.name || '',
    productName: payload.productName || 'Unspecified',
    productInfo: payload.productInfo || '',
    weightKg: Number(payload.weightKg || 1),
    origin: payload.origin || '—',
    destination: payload.destination || '—',
    createdAt: new Date().toISOString(),
    status: 'new'
  };
  state.requests.unshift(req);
  saveState(state);
  return req;
}
function markRequestStatus(id, status) {
  const state = readState();
  const req   = state.requests.find(r => r.id === id);
  if (!req) throw new Error('Request not found.');
  req.status = status;
  saveState(state);
  return req;
}

/* ── Expose globals ── */
window.getCurrentUser     = getCurrentUser;
window.logoutUser         = logoutUser;
window.signupUser         = signupUser;
window.loginUser          = loginUser;
window.requireRole        = requireRole;
window.getAllUsers         = getAllUsers;
window.getAllShipments     = getAllShipments;
window.getAllRequests      = getAllRequests;
window.getAllMessages      = getAllMessages;
window.getMessagesForUser = getMessagesForUser;
window.sendMessage        = sendMessage;
window.markMessageRead    = markMessageRead;
window.countUnreadMessages = countUnreadMessages;
window.getUserShipments   = getUserShipments;
window.createShipment     = createShipment;
window.updateShipment     = updateShipment;
window.deleteShipment     = deleteShipment;
window.claimTrackingCode  = claimTrackingCode;
window.fetchShipmentByCode = fetchShipmentByCode;
window.findShipmentByCode  = findShipmentByCode;
window.createShippingRequest = createShippingRequest;
window.markRequestStatus  = markRequestStatus;
window.showToast          = showToast;
window.shipmentCardMarkup = shipmentCardMarkup;
window.shipmentDetailMarkup = shipmentDetailMarkup;
window.shipmentStatusBadge  = shipmentStatusBadge;
window.formatDateTime     = formatDateTime;
window.formatDate         = formatDate;
window.money              = money;
window.getStatusMeta      = getStatusMeta;
window.getDataModeLabel   = getDataModeLabel;
window.computeShipmentProgress = computeShipmentProgress;
window.calcEtaCountdown   = calcEtaCountdown;
window.getShipmentEtaText = getShipmentEtaText;
window.refreshLiveTelemetry = refreshLiveTelemetry;
window.vsApiFetch         = apiFetch;
window.buildAdminHeaders  = buildAdminHeaders;

/* ── Boot ── */
function loadSupabaseIntegration() {
  if (window.__veloxshipSupabaseLoader) return window.__veloxshipSupabaseLoader;
  window.__veloxshipSupabaseLoader = new Promise((resolve, reject) => {
    if (document.querySelector('script[data-veloxship-supabase]')) {
      window.addEventListener('veloxship:supabase-ready', () => resolve(), { once: true });
      setTimeout(resolve, 1200);
      return;
    }
    const script = document.createElement('script');
    script.src = 'supabase.js';
    script.async = true;
    script.dataset.veloxshipSupabase = 'true';
    script.onload = () => {
      window.dispatchEvent(new Event('veloxship:supabase-ready'));
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load Supabase integration file.'));
    document.head.appendChild(script);
  });
  return window.__veloxshipSupabaseLoader;
}

let realtimeSocket = null;
let realtimeReconnectTimer = null;
let fallbackRefreshTimer = null;
let realtimeChannel = null;

function dispatchShipmentRefresh() {
  window.dispatchEvent(new CustomEvent('veloxship:shipments-updated'));
}

async function refreshShipmentsLive() {
  const page = document.body?.dataset?.page || '';
  if (!['admin', 'dashboard'].includes(page)) return;
  try {
    await ensureShipmentsLoaded(true);
    dispatchShipmentRefresh();
  } catch (error) {
    logDataError('Live shipment refresh failed.', error);
  }
}

function scheduleRealtimeReconnect() {
  clearTimeout(realtimeReconnectTimer);
  realtimeReconnectTimer = setTimeout(startRealtimeSync, 3000);
}

async function startSupabaseRealtimeSync() {
  const page = document.body?.dataset?.page || '';
  const user = getCurrentUser();
  if (!['admin', 'dashboard'].includes(page) || !user) return;

  try {
    const client = await ensureBrowserSupabase();
    if (!client) return;

    if (realtimeChannel?.unsubscribe) {
      try { await realtimeChannel.unsubscribe(); } catch {}
    }

    realtimeChannel = client
      .channel(`veloxship-live-${user.role}-${user.id || user.email || 'session'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: window.__veloxshipRuntime.table || VS_SUPABASE_TABLE }, refreshShipmentsLive)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movement_history' }, refreshShipmentsLive);

    realtimeChannel.subscribe((status) => {
      if (status === 'SUBSCRIBED') refreshShipmentsLive();
    });
  } catch (error) {
    logDataError('Supabase realtime init failed.', error);
  }
}

function startRealtimeSync() {
  const page = document.body?.dataset?.page || '';
  const user = getCurrentUser();
  if (!['admin', 'dashboard'].includes(page) || !user) return;
  clearInterval(fallbackRefreshTimer);
  fallbackRefreshTimer = setInterval(refreshShipmentsLive, 7000);
  startSupabaseRealtimeSync();
  try {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({
      role: user.role,
      email: user.email || '',
      userId: user.id || '',
      token: user.adminToken || ''
    });
    realtimeSocket?.close();
    realtimeSocket = new WebSocket(`${protocol}://${location.host}${window.__veloxshipRuntime.wsPath || '/ws'}?${query.toString()}`);
    realtimeSocket.addEventListener('message', event => {
      try {
        const payload = JSON.parse(event.data || '{}');
        if (payload.type === 'refresh') refreshShipmentsLive();
      } catch {}
    });
    realtimeSocket.addEventListener('close', scheduleRealtimeReconnect);
    realtimeSocket.addEventListener('error', () => {
      try { realtimeSocket.close(); } catch {}
    });
  } catch (error) {
    logDataError('Realtime sync init failed.', error);
  }
}


window.vsReady = loadSupabaseIntegration()
  .then(() => loadRuntimeConfig())
  .then(() => ensureShipmentsLoaded());

document.addEventListener('DOMContentLoaded', async () => {
  readState();
  await window.vsReady;
  startLiveTelemetry();
  startRealtimeSync();
});
