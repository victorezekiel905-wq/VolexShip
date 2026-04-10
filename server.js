/* VeloxShip — self-contained Node.js / Express server with realtime shipment simulation */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const {
  normalizeStatus,
  statusLabel,
  buildScheduledMovementPlan,
  getNextEventTime,
  shiftFutureEvents,
  getDeliveryEta,
  getCurrentEvent
} = require('./shipment-engine');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'amos@gmail.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Amos@2026';
const SECRET = process.env.ADMIN_TOKEN_SECRET || `${ADMIN_EMAIL}:${ADMIN_PASSWORD}:velox`;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ENGINE_POLL_MS = Number(process.env.ENGINE_POLL_MS || 60 * 1000);
const HISTORY_LIMIT = 500;
const DATA_FILE = path.join(__dirname, 'veloxship-data.json');
const DEFAULT_SUPABASE_URL = 'https://udjgrrjnyhaersaiuudj.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkamdycmpueWhhZXJzYWl1dWRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NTcxNTIsImV4cCI6MjA5MDUzMzE1Mn0.VVpnC9UPVTmNtPU1lS5HzDEqfi8XXEhJ1kAJsABeAtI';

const app = express();
const server = http.createServer(app);
const wsClients = new Set();
let majorEngineBusy = false;
let simulationEngineBusy = false;

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-email, x-admin-password, x-customer-email, x-customer-user-id');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'ignore' }));

function logError(scope, error) {
  console.error(`[VeloxShip] ${scope}:`, error?.message || error, error);
}

function createToken(email) {
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const payload = `${email}|${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

function verifyToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [email, exp, sig] = decoded.split('|');
    if (email !== ADMIN_EMAIL) return false;
    if (Number(exp) < Date.now()) return false;
    const expected = crypto.createHmac('sha256', SECRET).update(`${email}|${exp}`).digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function isAdmin(req) {
  const auth = req.header('authorization') || '';
  if (auth.startsWith('Bearer ')) return verifyToken(auth.slice(7).trim());
  return (req.header('x-admin-email') || '').trim().toLowerCase() === ADMIN_EMAIL
    && (req.header('x-admin-password') || '') === ADMIN_PASSWORD;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin authorization required.' });
  next();
}

function getCustomerEmail(req) {
  return (req.header('x-customer-email') || req.query.email || '').trim().toLowerCase();
}

function getCustomerUserId(req) {
  return (req.header('x-customer-user-id') || req.query.user_id || '').trim();
}

function safeIso(value, fallback = new Date()) {
  const date = value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) return new Date(fallback).toISOString();
  return date.toISOString();
}

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function ensureStoreShape(store) {
  const safe = store && typeof store === 'object' ? store : {};
  return {
    meta: {
      nextShipmentId: Math.max(Number(safe?.meta?.nextShipmentId || 1), 1),
      nextMovementId: Math.max(Number(safe?.meta?.nextMovementId || 1), 1)
    },
    shipments: Array.isArray(safe?.shipments) ? safe.shipments : [],
    movements: Array.isArray(safe?.movements) ? safe.movements : []
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const seed = ensureStoreShape();
      fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
      return seed;
    }
    return ensureStoreShape(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (error) {
    logError('Load local data store failed', error);
    return ensureStoreShape();
  }
}

function saveStore(store) {
  const safe = ensureStoreShape(store);
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(safe, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
  return safe;
}

function readShipments() {
  return loadStore().shipments;
}

function findShipmentRowById(id) {
  return loadStore().shipments.find(row => String(row.id) === String(id)) || null;
}

function findShipmentRowByCode(code) {
  const safeCode = String(code || '').trim().toUpperCase();
  return loadStore().shipments.find(row => String(row.tracking_code || '').trim().toUpperCase() === safeCode) || null;
}

function getMovementRowsForShipment(shipmentId, limit = HISTORY_LIMIT) {
  return loadStore().movements
    .filter(row => String(row.shipment_id) === String(shipmentId))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(0, limit);
}

function mapPlanEvent(event = {}) {
  return {
    ...event,
    scheduledFor: event.scheduledFor || event.scheduled_for || null,
    scheduled_for: event.scheduled_for || event.scheduledFor || null,
    eventType: event.eventType || event.event_type || 'major',
    event_type: event.event_type || event.eventType || 'major',
    eventIndex: Number(event.eventIndex ?? event.event_index ?? 0),
    event_index: Number(event.event_index ?? event.eventIndex ?? 0),
    majorStepIndex: Number(event.majorStepIndex ?? event.major_step_index ?? 0),
    major_step_index: Number(event.major_step_index ?? event.majorStepIndex ?? 0),
    progressPercent: Number(event.progressPercent ?? event.progress_percent ?? 0),
    progress_percent: Number(event.progress_percent ?? event.progressPercent ?? 0)
  };
}

function getRowPlan(row) {
  const plan = parseMaybeJson(row?.movement_plan, []);
  return Array.isArray(plan) ? plan.map(mapPlanEvent) : [];
}

function mapMovementRow(row) {
  const normalized = normalizeStatus(row?.status);
  const label = statusLabel(normalized);
  const note = row?.note || '';
  return {
    id: row.id,
    time: row.created_at || new Date().toISOString(),
    location: row.location || 'Logistics Hub',
    status: normalized,
    title: label,
    detail: note || `Status: ${label}`,
    note,
    statusLabel: label,
    movementType: row.movement_type || 'manual',
    simulated: Boolean(row.is_simulated)
  };
}

function getNextPointers(plan, currentEventIndex) {
  return {
    nextMovementAt: getNextEventTime(plan, currentEventIndex, 'major'),
    nextSimulationAt: getNextEventTime(plan, currentEventIndex, 'micro')
  };
}

function fromRow(row, historyRows = []) {
  if (!row) return null;
  const plan = getRowPlan(row);
  const history = (historyRows || []).map(mapMovementRow);
  return {
    id: row.id,
    trackingCode: row.tracking_code || '',
    userId: row.user_id || '',
    customerEmail: (row.email || '').toLowerCase(),
    customerName: row.full_name || '',
    phone: row.phone || '',
    address: row.address || '',
    productName: row.shipment_title || 'Unnamed item',
    productCategory: row.product_category || 'General cargo',
    productDescription: row.product_description || '',
    quantity: Number(row.quantity ?? 1),
    weightKg: Number(row.weight ?? 1),
    valueUsd: Number(row.value_usd ?? 0),
    origin: row.origin || '—',
    destination: row.destination || '—',
    currentLocation: row.current_location || plan?.[0]?.location || 'Origin Facility',
    shippingMode: row.shipping_mode || 'Express',
    priority: row.priority || 'Priority',
    status: normalizeStatus(row.status || 'processing'),
    statusControl: row.status_control || 'active',
    pausedReason: row.paused_reason || '',
    resumeReason: row.resume_reason || '',
    pauseState: (row.status_control || 'active') === 'paused' || normalizeStatus(row.status || '') === 'paused',
    departureTime: row.departure_time || null,
    estimatedArrival: row.estimated_delivery || null,
    deliveryDeadline: row.delivery_deadline || row.estimated_delivery || null,
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || row.created_at || new Date().toISOString(),
    notes: row.notes || '',
    confirmedByCustomer: Boolean(row.confirmed_by_customer),
    deleted: normalizeStatus(row.status) === 'deleted',
    deletedAt: row.deleted_at || null,
    currentStep: Number(row.current_step ?? 0),
    currentEventIndex: Number(row.current_event_index ?? row.current_step ?? 0),
    totalSteps: Array.isArray(plan) ? plan.length : 0,
    totalEvents: Number(row.total_events ?? plan.length ?? 0),
    nextMovementAt: row.next_movement_at || null,
    nextSimulationAt: row.next_simulation_at || null,
    pausedAt: row.pause_started_at || null,
    movementPlan: plan,
    stepIntervalHours: Number(row.movement_step_interval_hours ?? 1),
    history
  };
}

function hydrateShipments(rows) {
  return (rows || []).map(row => fromRow(row, getMovementRowsForShipment(row.id)));
}

function fetchShipmentById(id) {
  const row = findShipmentRowById(id);
  if (!row) return null;
  return fromRow(row, getMovementRowsForShipment(row.id));
}

function nextId(key) {
  const store = loadStore();
  const value = Number(store.meta[key] || 1);
  store.meta[key] = value + 1;
  saveStore(store);
  return value;
}

function insertMovementRow({ shipmentId, location, status, note, createdAt = null, movementType = 'manual', simulated = false }) {
  const store = loadStore();
  const movement = {
    id: Number(store.meta.nextMovementId || 1),
    shipment_id: Number(shipmentId),
    location: String(location || 'Logistics Hub').trim() || 'Logistics Hub',
    status: normalizeStatus(status),
    note: String(note || '').trim() || null,
    movement_type: movementType,
    is_simulated: Boolean(simulated),
    created_at: createdAt ? safeIso(createdAt) : new Date().toISOString()
  };
  store.meta.nextMovementId = movement.id + 1;
  store.movements.push(movement);
  saveStore(store);
  return movement;
}

function updateShipmentRow(id, updater) {
  const store = loadStore();
  const index = store.shipments.findIndex(row => String(row.id) === String(id));
  if (index < 0) return null;
  const source = JSON.parse(JSON.stringify(store.shipments[index]));
  const updated = updater(source) || source;
  store.shipments[index] = updated;
  saveStore(store);
  return updated;
}

function createShipmentPayload(body = {}) {
  const createdAt = safeIso(body.createdAt || new Date().toISOString());
  const startAt = safeIso(body.departureTime || body.departure_time || createdAt, createdAt);
  const deliveryDeadline = body.expectedDeliveryDate
    || body.expected_delivery_date
    || body.estimatedArrival
    || body.estimated_arrival
    || body.estimated_delivery;

  if (!deliveryDeadline) {
    throw new Error('Expected delivery date is required to generate the shipment movement plan.');
  }

  const built = buildScheduledMovementPlan({
    origin: body.origin,
    destination: body.destination,
    startAt,
    deliveryDeadline
  });

  const plan = built.plan;
  const firstEvent = plan[0] || {};

  return {
    tracking_code: String(body.trackingCode || body.tracking_code || '').trim().toUpperCase(),
    user_id: String(body.customerUserId || body.user_id || '').trim() || null,
    full_name: String(body.customerName || body.full_name || '').trim(),
    email: String(body.customerEmail || body.email || '').trim().toLowerCase(),
    phone: String(body.phone || '').trim(),
    address: String(body.address || '').trim(),
    shipment_title: String(body.productName || body.shipment_title || 'Unnamed item').trim(),
    product_category: String(body.productCategory || body.product_category || 'General cargo').trim(),
    product_description: String(body.productDescription || body.product_description || '').trim(),
    quantity: Number(body.quantity || 1),
    weight: Number(body.weightKg || body.weight || 1),
    value_usd: Number(body.valueUsd || body.value_usd || 0),
    origin: String(body.origin || '—').trim() || '—',
    destination: String(body.destination || '—').trim() || '—',
    status: normalizeStatus(firstEvent.status || body.status || 'processing'),
    status_control: 'active',
    current_location: String(body.currentLocation || firstEvent.location || body.origin || 'Origin Facility').trim(),
    estimated_delivery: built.deliveryDeadline,
    delivery_deadline: built.deliveryDeadline,
    departure_time: startAt,
    paused_reason: '',
    resume_reason: '',
    pause_started_at: null,
    notes: String(body.notes || '').trim(),
    shipping_mode: String(body.shippingMode || body.shipping_mode || 'Express').trim(),
    priority: String(body.priority || 'Priority').trim(),
    confirmed_by_customer: Boolean(body.confirmedByCustomer),
    current_step: Number(firstEvent.major_step_index || 0),
    current_event_index: 0,
    total_events: built.totalEvents,
    movement_plan: JSON.stringify(plan),
    next_movement_at: built.nextMovementAt,
    next_simulation_at: built.nextSimulationAt,
    movement_step_interval_hours: built.stepIntervalHours,
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: null
  };
}

function sendRefreshMessage(message, audience = null) {
  for (const client of wsClients) {
    const isAdminClient = client?.meta?.role === 'admin';
    const isPublicClient = client?.meta?.role === 'public';
    const userMatches = audience
      ? (Boolean(audience.userId) && audience.userId === client?.meta?.userId)
        || (Boolean(audience.email) && audience.email === client?.meta?.email)
      : true;
    if (client.readyState === 1 && (isAdminClient || isPublicClient || userMatches)) {
      try { client.send(message); } catch {}
    }
  }
}

function broadcastRefresh(reason = 'shipments:refresh', shipmentId = null) {
  const row = shipmentId ? findShipmentRowById(shipmentId) : null;
  const message = JSON.stringify({ type: 'refresh', reason, shipmentId, at: new Date().toISOString() });
  sendRefreshMessage(message, row ? {
    email: String(row.email || '').trim().toLowerCase(),
    userId: String(row.user_id || '').trim()
  } : null);
}

function updateShipmentPointersAndState(row, plan, nextIndexOverride = null) {
  const currentIndex = nextIndexOverride == null ? Number(row.current_event_index || 0) : Number(nextIndexOverride);
  const currentEvent = getCurrentEvent(plan, currentIndex);
  const nextPointers = getNextPointers(plan, currentIndex);
  const delivered = currentIndex >= Math.max(plan.length - 1, 0) || normalizeStatus(currentEvent?.status || row.status) === 'delivered';

  return updateShipmentRow(row.id, current => ({
    ...current,
    current_event_index: currentIndex,
    current_step: Number(currentEvent?.major_step_index || current.current_step || 0),
    current_location: currentEvent?.location || current.current_location,
    status: delivered ? 'delivered' : normalizeStatus(currentEvent?.status || current.status),
    estimated_delivery: getDeliveryEta(plan) || current.estimated_delivery,
    delivery_deadline: getDeliveryEta(plan) || current.delivery_deadline || current.estimated_delivery,
    next_movement_at: delivered ? null : nextPointers.nextMovementAt,
    next_simulation_at: delivered ? null : nextPointers.nextSimulationAt,
    total_events: plan.length,
    movement_plan: JSON.stringify(plan),
    updated_at: new Date().toISOString()
  }));
}

function processDueEventsForShipment(row, eventType) {
  const plan = getRowPlan(row);
  if (!plan.length) return false;

  let currentIndex = Number(row.current_event_index || 0);
  let changed = false;
  const nowMs = Date.now();

  while (currentIndex + 1 < plan.length) {
    const nextEvent = plan[currentIndex + 1];
    const dueAtMs = new Date(nextEvent.scheduledFor || nextEvent.scheduled_for).getTime();
    if (Number.isNaN(dueAtMs) || dueAtMs > nowMs) break;
    if ((nextEvent.eventType || nextEvent.event_type) !== eventType) break;

    insertMovementRow({
      shipmentId: row.id,
      location: nextEvent.location,
      status: nextEvent.status,
      note: nextEvent.note,
      createdAt: nextEvent.scheduledFor || nextEvent.scheduled_for,
      movementType: eventType,
      simulated: eventType === 'micro'
    });

    currentIndex += 1;
    changed = true;
  }

  if (!changed) return false;
  updateShipmentPointersAndState(row, plan, currentIndex);
  broadcastRefresh(eventType === 'major' ? 'movement-engine' : 'simulation-engine', row.id);
  return true;
}

function runMajorMovementEngine() {
  if (majorEngineBusy) return;
  majorEngineBusy = true;
  try {
    const nowMs = Date.now();
    const rows = readShipments()
      .filter(row => row.status_control === 'active'
        && row.next_movement_at
        && !['deleted', 'delivered'].includes(normalizeStatus(row.status))
        && new Date(row.next_movement_at).getTime() <= nowMs)
      .sort((a, b) => new Date(a.next_movement_at) - new Date(b.next_movement_at))
      .slice(0, 100);
    rows.forEach(row => processDueEventsForShipment(row, 'major'));
  } catch (error) {
    logError('Hourly movement engine tick failed', error);
  } finally {
    majorEngineBusy = false;
  }
}

function runSimulationEngine() {
  if (simulationEngineBusy) return;
  simulationEngineBusy = true;
  try {
    const nowMs = Date.now();
    const rows = readShipments()
      .filter(row => row.status_control === 'active'
        && row.next_simulation_at
        && !['deleted', 'delivered'].includes(normalizeStatus(row.status))
        && new Date(row.next_simulation_at).getTime() <= nowMs)
      .sort((a, b) => new Date(a.next_simulation_at) - new Date(b.next_simulation_at))
      .slice(0, 100);
    rows.forEach(row => processDueEventsForShipment(row, 'micro'));
  } catch (error) {
    logError('Simulation engine tick failed', error);
  } finally {
    simulationEngineBusy = false;
  }
}

function pauseShipment(shipmentId, reason = '') {
  const existing = findShipmentRowById(shipmentId);
  if (!existing) throw new Error('Shipment not found.');
  if (existing.status_control === 'paused') return fetchShipmentById(shipmentId);

  const nowIso = new Date().toISOString();
  const pauseReason = String(reason || 'Shipment temporarily paused').trim() || 'Shipment temporarily paused';
  updateShipmentRow(shipmentId, current => ({
    ...current,
    status: 'paused',
    status_control: 'paused',
    paused_reason: pauseReason,
    resume_reason: '',
    pause_started_at: nowIso,
    updated_at: nowIso
  }));

  insertMovementRow({
    shipmentId,
    location: existing.current_location || 'Logistics Hub',
    status: 'paused',
    note: pauseReason,
    movementType: 'control',
    simulated: false
  });

  broadcastRefresh('shipment-paused', shipmentId);
  return fetchShipmentById(shipmentId);
}

function resumeShipment(shipmentId, reason = '') {
  const existing = findShipmentRowById(shipmentId);
  if (!existing) throw new Error('Shipment not found.');

  const resumeReason = String(reason || '').trim();
  if (!resumeReason) throw new Error('Resume reason is required.');

  const now = new Date();
  const pausedAt = existing.pause_started_at ? new Date(existing.pause_started_at) : null;
  const pausedForMs = pausedAt && !Number.isNaN(pausedAt.getTime()) ? Math.max(now.getTime() - pausedAt.getTime(), 0) : 0;
  const plan = shiftFutureEvents(getRowPlan(existing), Number(existing.current_event_index || 0), pausedForMs);
  const nextPointers = getNextPointers(plan, Number(existing.current_event_index || 0));
  const currentEvent = getCurrentEvent(plan, Number(existing.current_event_index || 0));
  const resumedStatus = normalizeStatus(currentEvent?.status || 'in_transit') === 'processing'
    ? 'in_transit'
    : normalizeStatus(currentEvent?.status || 'in_transit');

  updateShipmentRow(shipmentId, current => ({
    ...current,
    status: resumedStatus === 'paused' ? 'in_transit' : resumedStatus,
    status_control: 'active',
    paused_reason: '',
    resume_reason: resumeReason,
    pause_started_at: null,
    estimated_delivery: getDeliveryEta(plan) || current.estimated_delivery,
    delivery_deadline: getDeliveryEta(plan) || current.delivery_deadline || current.estimated_delivery,
    movement_plan: JSON.stringify(plan),
    total_events: plan.length,
    next_movement_at: nextPointers.nextMovementAt,
    next_simulation_at: nextPointers.nextSimulationAt,
    updated_at: now.toISOString()
  }));

  insertMovementRow({
    shipmentId,
    location: existing.current_location || currentEvent?.location || 'Logistics Hub',
    status: 'in_transit',
    note: resumeReason,
    movementType: 'control',
    simulated: false
  });

  broadcastRefresh('shipment-resumed', shipmentId);
  return fetchShipmentById(shipmentId);
}

function refreshShipmentFromLatestMovement(shipmentId) {
  const latest = getMovementRowsForShipment(shipmentId).slice(-1)[0] || null;
  const source = findShipmentRowById(shipmentId);
  if (!source) return null;
  const plan = getRowPlan(source);
  const currentIndex = Number(source.current_event_index || 0);
  const nextPointers = getNextPointers(plan, currentIndex);

  updateShipmentRow(shipmentId, current => ({
    ...current,
    status: normalizeStatus(latest?.status || current.status || 'processing'),
    current_location: latest?.location || current.current_location,
    next_movement_at: current.status_control === 'paused' ? current.next_movement_at : nextPointers.nextMovementAt,
    next_simulation_at: current.status_control === 'paused' ? current.next_simulation_at : nextPointers.nextSimulationAt,
    updated_at: new Date().toISOString()
  }));

  return fetchShipmentById(shipmentId);
}

app.get('/api/runtime', (req, res) => res.json({
  ok: true,
  dbReady: true,
  storageMode: 'local',
  table: 'shipment',
  supabaseUrl: process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
  wsPath: '/ws'
}));

app.get('/api/health', (req, res) => {
  const store = loadStore();
  res.json({
    ok: true,
    dbReady: true,
    storageMode: 'local',
    shipments: store.shipments.length,
    movements: store.movements.length
  });
});

app.post('/api/auth/admin/login', (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const pass = req.body?.password || '';
  if (email !== ADMIN_EMAIL || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  return res.json({ ok: true, token: createToken(email), admin: { email: ADMIN_EMAIL } });
});

app.get('/api/shipments', requireAdmin, (req, res) => {
  try {
    const shipments = hydrateShipments(readShipments().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    res.json({ shipments, mode: 'local' });
  } catch (error) {
    logError('List shipments failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shipments/mine', (req, res) => {
  const email = getCustomerEmail(req);
  const userId = getCustomerUserId(req);
  if (!email && !userId) return res.status(400).json({ error: 'Customer identity required.' });
  try {
    let rows = readShipments().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (userId) {
      rows = rows.filter(row => String(row.user_id || '') === userId);
      if (!rows.length && email) rows = readShipments().filter(row => String(row.email || '').toLowerCase() === email);
    } else {
      rows = rows.filter(row => String(row.email || '').toLowerCase() === email);
    }
    res.json({ shipments: hydrateShipments(rows), mode: 'local' });
  } catch (error) {
    logError('List customer shipments failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shipments/lookup/:code', (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Tracking code required.' });
  try {
    const row = findShipmentRowByCode(code);
    if (!row) return res.status(404).json({ error: 'Shipment not found.' });
    const shipment = fetchShipmentById(row.id);
    res.json({ shipment: { ...shipment, customerEmail: '', customerName: '', phone: '', address: '' }, mode: 'local' });
  } catch (error) {
    logError('Lookup shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments', requireAdmin, (req, res) => {
  try {
    const trackingCode = String(req.body?.trackingCode || req.body?.tracking_code || '').trim().toUpperCase();
    if (!trackingCode) return res.status(400).json({ error: 'Tracking code required.' });
    if (findShipmentRowByCode(trackingCode)) return res.status(409).json({ error: 'Tracking code already exists.' });

    const store = loadStore();
    const payload = createShipmentPayload({ ...req.body, trackingCode });
    const row = {
      id: Number(store.meta.nextShipmentId || 1),
      ...payload
    };
    store.meta.nextShipmentId = row.id + 1;
    store.shipments.push(row);
    saveStore(store);

    const plan = getRowPlan(row);
    const firstEvent = plan[0];
    insertMovementRow({
      shipmentId: row.id,
      location: firstEvent?.location || row.current_location,
      status: firstEvent?.status || row.status,
      note: firstEvent?.note || `Shipment registered and queued for dispatch from ${row.current_location}.`,
      createdAt: row.created_at,
      movementType: 'major',
      simulated: false
    });

    const shipment = fetchShipmentById(row.id);
    broadcastRefresh('shipment-created', row.id);
    res.json({ shipment });
  } catch (error) {
    logError('Create shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments/:id/pause', requireAdmin, (req, res) => {
  try {
    const shipment = pauseShipment(Number(req.params.id), req.body?.reason || req.body?.pausedReason || req.body?.paused_reason || '');
    res.json({ shipment });
  } catch (error) {
    logError('Pause shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments/:id/resume', requireAdmin, (req, res) => {
  try {
    const shipment = resumeShipment(Number(req.params.id), req.body?.reason || req.body?.resumeReason || req.body?.resume_reason || '');
    res.json({ shipment });
  } catch (error) {
    logError('Resume shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/shipments/:id', (req, res) => {
  try {
    const existing = findShipmentRowById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Shipment not found.' });

    if (req.body?.claimTracking) {
      const email = (req.body.customerEmail || req.body.customer_email || req.body.email || '').trim().toLowerCase();
      const userId = String(req.body.customerUserId || req.body.user_id || '').trim() || null;
      const customerName = String(req.body.customerName || req.body.full_name || '').trim();
      if (!email) return res.status(400).json({ error: 'Email required.' });
      const currentEmail = (existing.email || '').trim().toLowerCase();
      if (currentEmail && currentEmail !== email) {
        return res.status(409).json({ error: 'Already assigned to another account.' });
      }
      updateShipmentRow(req.params.id, current => ({
        ...current,
        email,
        user_id: userId || current.user_id || null,
        full_name: customerName || current.full_name || '',
        confirmed_by_customer: true,
        updated_at: new Date().toISOString()
      }));
      insertMovementRow({
        shipmentId: Number(req.params.id),
        location: existing.current_location || 'Logistics Hub',
        status: existing.status,
        note: `${customerName || email} linked this shipment to their dashboard.`,
        movementType: 'manual',
        simulated: false
      });
      const shipment = fetchShipmentById(req.params.id);
      broadcastRefresh('shipment-claimed', req.params.id);
      return res.json({ shipment });
    }

    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin required.' });

    const requestedStatus = req.body?.status ? normalizeStatus(req.body.status) : normalizeStatus(existing.status);
    if (requestedStatus === 'paused') {
      const shipment = pauseShipment(Number(req.params.id), req.body?.pausedReason || req.body?.paused_reason || 'Shipment temporarily paused');
      return res.json({ shipment });
    }
    if (existing.status_control === 'paused' && requestedStatus !== 'paused') {
      resumeShipment(Number(req.params.id), req.body?.resumeReason || req.body?.resume_reason || '');
    }

    const latestRow = findShipmentRowById(req.params.id);
    let plan = getRowPlan(latestRow);
    if (req.body?.estimatedArrival || req.body?.estimated_arrival || req.body?.estimated_delivery) {
      const newDeadline = safeIso(req.body.estimatedArrival || req.body.estimated_arrival || req.body.estimated_delivery);
      const currentEta = getDeliveryEta(plan) || latestRow.estimated_delivery;
      const deltaMs = Math.max(new Date(newDeadline).getTime() - new Date(currentEta).getTime(), 0);
      plan = shiftFutureEvents(plan, Number(latestRow.current_event_index || 0), deltaMs);
    }

    const nextPointers = getNextPointers(plan, Number(latestRow.current_event_index || 0));
    const nowIso = new Date().toISOString();
    updateShipmentRow(req.params.id, current => ({
      ...current,
      status: requestedStatus,
      status_control: requestedStatus === 'deleted' ? 'active' : (current.status_control === 'paused' ? 'active' : current.status_control || 'active'),
      current_location: String(req.body?.currentLocation || req.body?.current_location || current.current_location || '').trim() || current.current_location,
      estimated_delivery: requestedStatus === 'delivered' ? nowIso : (getDeliveryEta(plan) || current.estimated_delivery),
      delivery_deadline: getDeliveryEta(plan) || current.delivery_deadline || current.estimated_delivery,
      departure_time: req.body?.departureTime || req.body?.departure_time || current.departure_time || current.created_at,
      paused_reason: req.body?.pausedReason ?? req.body?.paused_reason ?? (requestedStatus === 'paused' ? 'Shipment temporarily on hold' : ''),
      resume_reason: req.body?.resumeReason ?? req.body?.resume_reason ?? (requestedStatus === 'paused' ? '' : (current.resume_reason || '')),
      pause_started_at: null,
      notes: req.body?.notes ?? current.notes ?? '',
      total_events: plan.length,
      movement_plan: JSON.stringify(plan),
      next_movement_at: ['delivered', 'deleted'].includes(requestedStatus) ? null : nextPointers.nextMovementAt,
      next_simulation_at: ['delivered', 'deleted'].includes(requestedStatus) ? null : nextPointers.nextSimulationAt,
      deleted_at: requestedStatus === 'deleted' ? nowIso : current.deleted_at,
      updated_at: nowIso
    }));

    const shouldWriteMovement = Boolean(req.body?.historyTitle || req.body?.historyDetail || req.body?.currentLocation || req.body?.status);
    if (shouldWriteMovement) {
      const updatedRow = findShipmentRowById(req.params.id);
      insertMovementRow({
        shipmentId: Number(req.params.id),
        location: updatedRow.current_location,
        status: requestedStatus,
        note: String(req.body?.historyDetail || req.body?.notes || statusLabel(requestedStatus)).trim(),
        movementType: 'manual',
        simulated: false
      });
    }

    const shipment = fetchShipmentById(req.params.id);
    broadcastRefresh('shipment-updated', req.params.id);
    res.json({ shipment });
  } catch (error) {
    logError('Update shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/shipments/:id/customer', requireAdmin, (req, res) => {
  try {
    const existing = findShipmentRowById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Shipment not found.' });

    const statusOverride = req.body?.statusOverride ? normalizeStatus(req.body.statusOverride) : null;
    updateShipmentRow(req.params.id, current => ({
      ...current,
      full_name: String(req.body?.fullName ?? req.body?.full_name ?? current.full_name ?? '').trim(),
      email: String(req.body?.email ?? current.email ?? '').trim().toLowerCase(),
      phone: String(req.body?.phone ?? current.phone ?? '').trim(),
      destination: String(req.body?.destination ?? current.destination ?? '').trim(),
      address: String(req.body?.address ?? current.address ?? '').trim(),
      status: statusOverride || current.status,
      updated_at: new Date().toISOString()
    }));

    if (statusOverride) {
      insertMovementRow({
        shipmentId: Number(req.params.id),
        location: existing.current_location || 'Logistics Hub',
        status: statusOverride,
        note: `Admin status override applied: ${statusLabel(statusOverride)}.`,
        movementType: 'manual',
        simulated: false
      });
    }

    const shipment = fetchShipmentById(req.params.id);
    broadcastRefresh('customer-updated', req.params.id);
    res.json({ shipment });
  } catch (error) {
    logError('Update customer shipping info failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shipments/:id/movements', requireAdmin, (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || HISTORY_LIMIT), 200);
    const movements = getMovementRowsForShipment(req.params.id, limit).reverse().map(mapMovementRow);
    res.json({ movements });
  } catch (error) {
    logError('List movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments/:id/movements', requireAdmin, (req, res) => {
  try {
    const shipment = findShipmentRowById(req.params.id);
    if (!shipment) return res.status(404).json({ error: 'Shipment not found.' });

    const status = normalizeStatus(req.body?.status || shipment.status);
    const location = String(req.body?.location || shipment.current_location || 'Logistics Hub').trim() || 'Logistics Hub';
    const note = String(req.body?.note || req.body?.detail || '').trim();
    insertMovementRow({
      shipmentId: Number(req.params.id),
      location,
      status,
      note: note || `Manual tracking update: ${statusLabel(status)}.`,
      movementType: 'manual',
      simulated: false
    });

    updateShipmentRow(req.params.id, current => ({
      ...current,
      status,
      current_location: location,
      updated_at: new Date().toISOString()
    }));

    const updatedShipment = fetchShipmentById(req.params.id);
    broadcastRefresh('movement-created', req.params.id);
    res.json({ shipment: updatedShipment });
  } catch (error) {
    logError('Create movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/shipments/:id/movements/:movementId', requireAdmin, (req, res) => {
  try {
    const store = loadStore();
    const movementIndex = store.movements.findIndex(row => String(row.id) === String(req.params.movementId) && String(row.shipment_id) === String(req.params.id));
    if (movementIndex < 0) return res.status(404).json({ error: 'Tracking update not found.' });

    store.movements[movementIndex] = {
      ...store.movements[movementIndex],
      location: String(req.body?.location || store.movements[movementIndex].location || 'Logistics Hub').trim() || 'Logistics Hub',
      status: normalizeStatus(req.body?.status || store.movements[movementIndex].status),
      note: String(req.body?.note ?? store.movements[movementIndex].note ?? '').trim() || null
    };
    saveStore(store);

    const shipment = refreshShipmentFromLatestMovement(Number(req.params.id));
    broadcastRefresh('movement-updated', req.params.id);
    res.json({ shipment });
  } catch (error) {
    logError('Edit movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/shipments/:id/movements/:movementId', requireAdmin, (req, res) => {
  try {
    const store = loadStore();
    store.movements = store.movements.filter(row => !(String(row.id) === String(req.params.movementId) && String(row.shipment_id) === String(req.params.id)));
    saveStore(store);
    const shipment = refreshShipmentFromLatestMovement(Number(req.params.id));
    broadcastRefresh('movement-deleted', req.params.id);
    res.json({ ok: true, shipment });
  } catch (error) {
    logError('Delete movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/shipments/:id', requireAdmin, (req, res) => {
  try {
    const store = loadStore();
    store.shipments = store.shipments.filter(row => String(row.id) !== String(req.params.id));
    store.movements = store.movements.filter(row => String(row.shipment_id) !== String(req.params.id));
    saveStore(store);
    broadcastRefresh('shipment-deleted', req.params.id);
    res.json({ ok: true });
  } catch (error) {
    logError('Delete shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, request) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const role = (url.searchParams.get('role') || 'public').trim();
    const token = url.searchParams.get('token') || '';
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const userId = (url.searchParams.get('userId') || '').trim();
    if (role === 'admin' && !verifyToken(token)) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    socket.meta = { role, email, userId };
    wsClients.add(socket);
    socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  } catch {
    try { socket.close(1008, 'Invalid connection'); } catch {}
  }
});

server.listen(PORT, () => {
  loadStore();
  console.log(`VeloxShip running → http://localhost:${PORT}`);
  console.log(`[VeloxShip] Local shipment store → ${DATA_FILE}`);
  runSimulationEngine();
  runMajorMovementEngine();
  setInterval(runSimulationEngine, ENGINE_POLL_MS);
  setInterval(runMajorMovementEngine, ENGINE_POLL_MS);
});
