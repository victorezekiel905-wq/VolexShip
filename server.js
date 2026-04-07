/* VeloxShip — Node.js / Express server with real-time shipment simulation */
require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const {
  HOURLY_MOVEMENT_MS,
  MICRO_LOCATION_MS,
  normalizeStatus,
  statusLabel,
  buildScheduledMovementPlan,
  getNextEvent,
  getNextEventTime,
  shiftFutureEvents,
  getDeliveryEta,
  getCurrentEvent
} = require('./shipment-engine');

const DEFAULT_SUPABASE_URL = 'https://udjgrrjnyhaersaiuudj.supabase.co';
const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_KEY = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;

const PORT = Number(process.env.PORT || 3000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'amos@gmail.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Amos@2026';
const SECRET = process.env.ADMIN_TOKEN_SECRET || `${ADMIN_EMAIL}:${ADMIN_PASSWORD}:velox`;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const USERS_TABLE = 'volex';
const SHIPMENT_TABLE = 'shipment';
const MOVEMENT_TABLE = 'movement_history';
const ENGINE_POLL_MS = 60 * 1000;
const HISTORY_LIMIT = 500;

let supabase = null;
let majorEngineBusy = false;
let simulationEngineBusy = false;
const wsClients = new Set();

function logDbError(scope, error) {
  console.error(`[VeloxShip] ${scope}:`, error?.message || error, error);
}

try {
  const { createClient } = require('@supabase/supabase-js');
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  } else {
    console.warn('[VeloxShip] Supabase key missing. Set SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY.');
  }
} catch (error) {
  console.warn('[VeloxShip] Supabase client load failed:', error.message);
}

const DB_READY = Boolean(supabase);
const app = express();
const server = http.createServer(app);

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

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function safeIso(value, fallback = new Date()) {
  const date = value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) return new Date(fallback).toISOString();
  return date.toISOString();
}

function mapPlanEvent(event = {}) {
  return {
    ...event,
    scheduledFor: event.scheduledFor || event.scheduled_for || null,
    eventType: event.eventType || event.event_type || 'major',
    eventIndex: Number(event.eventIndex ?? event.event_index ?? 0),
    majorStepIndex: Number(event.majorStepIndex ?? event.major_step_index ?? 0),
    progressPercent: Number(event.progressPercent ?? event.progress_percent ?? 0)
  };
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

function getRowPlan(row) {
  const plan = parseJson(row?.movement_plan, []);
  return Array.isArray(plan) ? plan.map(mapPlanEvent) : [];
}

function getNextPointers(plan, currentEventIndex) {
  return {
    nextMovementAt: getNextEventTime(plan, currentEventIndex, 'major'),
    nextSimulationAt: getNextEventTime(plan, currentEventIndex, 'micro')
  };
}

function getCurrentShipmentEvent(row) {
  const plan = getRowPlan(row);
  return getCurrentEvent(plan, Number(row?.current_event_index || 0));
}

function fromRow(row, historyRows = []) {
  if (!row) return null;
  const legacyMeta = parseJson(row.movement_history, {});
  const plan = getRowPlan(row);
  const history = Array.isArray(historyRows) && historyRows.length
    ? historyRows.map(mapMovementRow)
    : Array.isArray(legacyMeta.history)
      ? legacyMeta.history
      : [];
  return {
    id: row.id,
    trackingCode: row.tracking_code || legacyMeta.trackingCode || '',
    userId: row.user_id || legacyMeta.userId || '',
    customerEmail: (row.email || legacyMeta.customerEmail || '').toLowerCase(),
    customerName: row.full_name || legacyMeta.customerName || '',
    phone: row.phone || legacyMeta.phone || '',
    address: row.address || legacyMeta.address || '',
    productName: row.shipment_title || legacyMeta.productName || 'Unnamed item',
    productCategory: row.product_category || legacyMeta.productCategory || 'General cargo',
    productDescription: row.product_description || legacyMeta.productDescription || '',
    quantity: Number(row.quantity ?? legacyMeta.quantity ?? 1),
    weightKg: Number(row.weight ?? legacyMeta.weightKg ?? 1),
    valueUsd: Number(row.value_usd ?? legacyMeta.valueUsd ?? 0),
    origin: row.origin || legacyMeta.origin || '—',
    destination: row.destination || legacyMeta.destination || '—',
    currentLocation: row.current_location || legacyMeta.currentLocation || plan?.[0]?.location || 'Origin Facility',
    shippingMode: row.shipping_mode || legacyMeta.shippingMode || 'Express',
    priority: row.priority || legacyMeta.priority || 'Priority',
    status: normalizeStatus(row.status || legacyMeta.status || 'processing'),
    statusControl: row.status_control || legacyMeta.statusControl || 'active',
    pausedReason: row.paused_reason || legacyMeta.pausedReason || '',
    departureTime: row.departure_time || legacyMeta.departureTime || null,
    estimatedArrival: row.estimated_delivery || legacyMeta.estimatedArrival || null,
    deliveryDeadline: row.delivery_deadline || legacyMeta.deliveryDeadline || row.estimated_delivery || null,
    createdAt: row.created_at || legacyMeta.createdAt || new Date().toISOString(),
    updatedAt: row.updated_at || legacyMeta.updatedAt || row.created_at || new Date().toISOString(),
    notes: row.notes || legacyMeta.notes || '',
    confirmedByCustomer: Boolean(row.confirmed_by_customer ?? legacyMeta.confirmedByCustomer),
    deleted: normalizeStatus(row.status) === 'deleted',
    deletedAt: row.deleted_at || legacyMeta.deletedAt || null,
    currentStep: Number(row.current_step ?? 0),
    currentEventIndex: Number(row.current_event_index ?? row.current_step ?? 0),
    totalSteps: Array.isArray(plan) ? plan.length : 0,
    totalEvents: Number(row.total_events ?? plan.length ?? 0),
    nextMovementAt: row.next_movement_at || null,
    nextSimulationAt: row.next_simulation_at || null,
    pausedAt: row.pause_started_at || null,
    movementPlan: plan,
    stepIntervalHours: Number(row.movement_step_interval_hours ?? 0),
    history
  };
}

async function fetchUserAssignment(email, fallbackUserId = '') {
  const safeEmail = String(email || '').trim().toLowerCase();
  if (!DB_READY || !safeEmail) {
    return {
      userId: fallbackUserId || null,
      fullName: '',
      email: safeEmail,
      phone: '',
      address: ''
    };
  }
  try {
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .select('user_id,full_name,email,phone,address')
      .eq('role', 'user')
      .is('tracking_code', null)
      .eq('email', safeEmail)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return {
      userId: data?.user_id || fallbackUserId || null,
      fullName: data?.full_name || '',
      email: data?.email || safeEmail,
      phone: data?.phone || '',
      address: data?.address || ''
    };
  } catch (error) {
    logDbError('Resolve customer assignment failed', error);
    return {
      userId: fallbackUserId || null,
      fullName: '',
      email: safeEmail,
      phone: '',
      address: ''
    };
  }
}

async function fetchHistoryMap(shipmentIds, limitPerShipment = HISTORY_LIMIT) {
  const map = new Map();
  if (!shipmentIds?.length) return map;
  const { data, error } = await supabase
    .from(MOVEMENT_TABLE)
    .select('*')
    .in('shipment_id', shipmentIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  for (const row of data || []) {
    const key = String(row.shipment_id);
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (list.length < limitPerShipment) list.push(row);
  }
  return map;
}

async function hydrateShipments(rows) {
  const ids = (rows || []).map(row => row.id).filter(Boolean);
  const historyMap = await fetchHistoryMap(ids);
  return (rows || []).map(row => fromRow(row, historyMap.get(String(row.id)) || []));
}

async function fetchShipmentById(id) {
  const { data, error } = await supabase
    .from(SHIPMENT_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const historyMap = await fetchHistoryMap([data.id]);
  return fromRow(data, historyMap.get(String(data.id)) || []);
}

async function insertMovementRow({ shipmentId, location, status, note, createdAt = null, movementType = 'manual', simulated = false }) {
  const payload = {
    shipment_id: shipmentId,
    location: String(location || 'Logistics Hub').trim() || 'Logistics Hub',
    status: normalizeStatus(status),
    note: String(note || '').trim() || null,
    movement_type: movementType,
    is_simulated: Boolean(simulated)
  };
  if (createdAt) payload.created_at = createdAt;
  const { data, error } = await supabase
    .from(MOVEMENT_TABLE)
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

function createShipmentPayload(body = {}, assignment = null) {
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
  const firstEvent = plan[0];

  return {
    tracking_code: String(body.trackingCode || body.tracking_code || '').trim().toUpperCase(),
    user_id: assignment?.userId || String(body.customerUserId || body.user_id || '').trim() || null,
    full_name: assignment?.fullName || String(body.customerName || body.full_name || '').trim() || '',
    email: (assignment?.email || body.customerEmail || body.email || '').trim().toLowerCase(),
    phone: assignment?.phone || String(body.phone || '').trim() || '',
    address: assignment?.address || String(body.address || '').trim() || '',
    shipment_title: String(body.productName || body.shipment_title || 'Unnamed item').trim(),
    product_category: String(body.productCategory || body.product_category || 'General cargo').trim(),
    product_description: String(body.productDescription || body.product_description || '').trim(),
    quantity: Number(body.quantity || 1),
    weight: Number(body.weightKg || body.weight || 1),
    value_usd: Number(body.valueUsd || body.value_usd || 0),
    origin: String(body.origin || '—').trim() || '—',
    destination: String(body.destination || '—').trim() || '—',
    status: normalizeStatus(firstEvent?.status || 'processing'),
    status_control: 'active',
    current_location: firstEvent?.location || 'Origin Facility',
    estimated_delivery: built.deliveryDeadline,
    delivery_deadline: built.deliveryDeadline,
    departure_time: startAt,
    paused_reason: '',
    pause_started_at: null,
    notes: String(body.notes || '').trim(),
    shipping_mode: String(body.shippingMode || body.shipping_mode || 'Express').trim(),
    priority: String(body.priority || 'Priority').trim(),
    confirmed_by_customer: false,
    current_step: Number(firstEvent?.major_step_index || 0),
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
    const userMatches = audience
      ? (Boolean(audience.userId) && audience.userId === client?.meta?.userId)
        || (Boolean(audience.email) && audience.email === client?.meta?.email)
      : true;
    if (client.readyState === 1 && (isAdminClient || userMatches)) {
      try { client.send(message); } catch {}
    }
  }
}

function broadcastRefresh(reason = 'shipments:refresh', shipmentId = null) {
  const message = JSON.stringify({ type: 'refresh', reason, shipmentId, at: new Date().toISOString() });
  if (!shipmentId || !DB_READY) {
    sendRefreshMessage(message, null);
    return;
  }
  supabase
    .from(SHIPMENT_TABLE)
    .select('email,user_id')
    .eq('id', shipmentId)
    .maybeSingle()
    .then(({ data }) => {
      sendRefreshMessage(message, {
        email: String(data?.email || '').trim().toLowerCase(),
        userId: String(data?.user_id || '').trim()
      });
    })
    .catch(() => sendRefreshMessage(message, null));
}

async function updateShipmentPointersAndState(row, plan, nextIndexOverride = null) {
  const currentIndex = nextIndexOverride == null ? Number(row.current_event_index || 0) : Number(nextIndexOverride);
  const currentEvent = getCurrentEvent(plan, currentIndex);
  const nextPointers = getNextPointers(plan, currentIndex);
  const delivered = currentIndex >= Math.max(plan.length - 1, 0) || normalizeStatus(currentEvent?.status || row.status) === 'delivered';
  const payload = {
    current_event_index: currentIndex,
    current_step: Number(currentEvent?.major_step_index || row.current_step || 0),
    current_location: currentEvent?.location || row.current_location,
    status: delivered ? 'delivered' : normalizeStatus(currentEvent?.status || row.status),
    estimated_delivery: getDeliveryEta(plan) || row.estimated_delivery,
    delivery_deadline: getDeliveryEta(plan) || row.delivery_deadline || row.estimated_delivery,
    next_movement_at: delivered ? null : nextPointers.nextMovementAt,
    next_simulation_at: delivered ? null : nextPointers.nextSimulationAt,
    total_events: plan.length,
    movement_plan: JSON.stringify(plan),
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from(SHIPMENT_TABLE).update(payload).eq('id', row.id).select('*').single();
  if (error) throw error;
  return data;
}

async function processDueEventsForShipment(row, eventType) {
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

    await insertMovementRow({
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

  await updateShipmentPointersAndState(row, plan, currentIndex);
  broadcastRefresh(eventType === 'major' ? 'movement-engine' : 'simulation-engine', row.id);
  return true;
}

async function runMajorMovementEngine() {
  if (!DB_READY || majorEngineBusy) return;
  majorEngineBusy = true;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from(SHIPMENT_TABLE)
      .select('*')
      .eq('status_control', 'active')
      .not('next_movement_at', 'is', null)
      .lte('next_movement_at', nowIso)
      .neq('status', 'deleted')
      .neq('status', 'delivered')
      .order('next_movement_at', { ascending: true })
      .limit(100);
    if (error) throw error;
    for (const row of data || []) {
      await processDueEventsForShipment(row, 'major');
    }
  } catch (error) {
    logDbError('Hourly movement engine tick failed', error);
  } finally {
    majorEngineBusy = false;
  }
}

async function runSimulationEngine() {
  if (!DB_READY || simulationEngineBusy) return;
  simulationEngineBusy = true;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from(SHIPMENT_TABLE)
      .select('*')
      .eq('status_control', 'active')
      .not('next_simulation_at', 'is', null)
      .lte('next_simulation_at', nowIso)
      .neq('status', 'deleted')
      .neq('status', 'delivered')
      .order('next_simulation_at', { ascending: true })
      .limit(100);
    if (error) throw error;
    for (const row of data || []) {
      await processDueEventsForShipment(row, 'micro');
    }
  } catch (error) {
    logDbError('4-hour simulation engine tick failed', error);
  } finally {
    simulationEngineBusy = false;
  }
}

async function pauseShipment(shipmentId, reason = '') {
  const { data: existing, error: fetchError } = await supabase
    .from(SHIPMENT_TABLE)
    .select('*')
    .eq('id', shipmentId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!existing) throw new Error('Shipment not found.');

  if (existing.status_control === 'paused') return fetchShipmentById(shipmentId);

  const nowIso = new Date().toISOString();
  const pauseReason = String(reason || 'Shipment temporarily paused').trim() || 'Shipment temporarily paused';
  const payload = {
    status: 'paused',
    status_control: 'paused',
    paused_reason: pauseReason,
    pause_started_at: nowIso,
    updated_at: nowIso
  };

  const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(payload).eq('id', shipmentId);
  if (updateError) throw updateError;

  await insertMovementRow({
    shipmentId,
    location: existing.current_location || getCurrentShipmentEvent(existing)?.location || 'Logistics Hub',
    status: 'paused',
    note: 'Shipment temporarily paused',
    movementType: 'control',
    simulated: false
  });

  broadcastRefresh('shipment-paused', shipmentId);
  return fetchShipmentById(shipmentId);
}

async function resumeShipment(shipmentId) {
  const { data: existing, error: fetchError } = await supabase
    .from(SHIPMENT_TABLE)
    .select('*')
    .eq('id', shipmentId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!existing) throw new Error('Shipment not found.');

  const now = new Date();
  const pausedAt = existing.pause_started_at ? new Date(existing.pause_started_at) : null;
  const pausedForMs = pausedAt && !Number.isNaN(pausedAt.getTime()) ? Math.max(now.getTime() - pausedAt.getTime(), 0) : 0;
  const plan = shiftFutureEvents(getRowPlan(existing), Number(existing.current_event_index || 0), pausedForMs);
  const nextPointers = getNextPointers(plan, Number(existing.current_event_index || 0));
  const currentEvent = getCurrentEvent(plan, Number(existing.current_event_index || 0));
  const resumedStatus = normalizeStatus(currentEvent?.status || 'in_transit') === 'processing' ? 'in_transit' : normalizeStatus(currentEvent?.status || 'in_transit');

  const payload = {
    status: resumedStatus === 'paused' ? 'in_transit' : resumedStatus,
    status_control: 'active',
    paused_reason: '',
    pause_started_at: null,
    estimated_delivery: getDeliveryEta(plan) || existing.estimated_delivery,
    delivery_deadline: getDeliveryEta(plan) || existing.delivery_deadline || existing.estimated_delivery,
    movement_plan: JSON.stringify(plan),
    total_events: plan.length,
    next_movement_at: nextPointers.nextMovementAt,
    next_simulation_at: nextPointers.nextSimulationAt,
    updated_at: now.toISOString()
  };

  const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(payload).eq('id', shipmentId);
  if (updateError) throw updateError;

  await insertMovementRow({
    shipmentId,
    location: existing.current_location || currentEvent?.location || 'Logistics Hub',
    status: 'in_transit',
    note: 'Shipment movement resumed',
    movementType: 'control',
    simulated: false
  });

  broadcastRefresh('shipment-resumed', shipmentId);
  return fetchShipmentById(shipmentId);
}

async function refreshShipmentFromLatestMovement(shipmentId, fallbackRow = null) {
  const source = fallbackRow || (await supabase.from(SHIPMENT_TABLE).select('*').eq('id', shipmentId).maybeSingle()).data;
  if (!source) return null;
  const plan = getRowPlan(source);
  const { data: latestRows, error } = await supabase
    .from(MOVEMENT_TABLE)
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const latest = latestRows?.[0] || null;
  const currentIndex = Number(source.current_event_index || 0);
  const nextPointers = getNextPointers(plan, currentIndex);
  const payload = {
    status: normalizeStatus(latest?.status || source.status || 'processing'),
    current_location: latest?.location || source.current_location,
    next_movement_at: source.status_control === 'paused' ? source.next_movement_at : nextPointers.nextMovementAt,
    next_simulation_at: source.status_control === 'paused' ? source.next_simulation_at : nextPointers.nextSimulationAt,
    updated_at: new Date().toISOString()
  };
  const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(payload).eq('id', shipmentId);
  if (updateError) throw updateError;
  return fetchShipmentById(shipmentId);
}

app.get('/api/runtime', (req, res) => res.json({
  ok: true,
  dbReady: DB_READY,
  table: SHIPMENT_TABLE,
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY,
  wsPath: '/ws'
}));

app.get('/api/health', async (req, res) => {
  if (!DB_READY) return res.json({ ok: false, dbReady: false, error: 'Database not configured.' });
  try {
    const { data, error } = await supabase.from(SHIPMENT_TABLE).select('id,tracking_code').limit(1);
    if (error) throw error;
    return res.json({ ok: true, dbReady: true, sample: data?.[0]?.id ?? null });
  } catch (error) {
    logDbError('Health check failed', error);
    return res.json({ ok: false, dbReady: false, error: error.message });
  }
});

app.post('/api/auth/admin/login', (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const pass = req.body?.password || '';
  if (email !== ADMIN_EMAIL || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  return res.json({ ok: true, token: createToken(email), admin: { email: ADMIN_EMAIL } });
});

app.get('/api/shipments', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { data, error } = await supabase
      .from(SHIPMENT_TABLE)
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const shipments = await hydrateShipments(data || []);
    res.json({ shipments, mode: 'cloud' });
  } catch (error) {
    logDbError('List shipments failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shipments/mine', async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const email = getCustomerEmail(req);
  const userId = getCustomerUserId(req);
  if (!email && !userId) return res.status(400).json({ error: 'Customer identity required.' });
  try {
    let query = supabase.from(SHIPMENT_TABLE).select('*').order('created_at', { ascending: false });
    if (userId) {
      query = query.eq('user_id', userId);
    } else {
      query = query.eq('email', email);
    }
    let { data, error } = await query;
    if (error) throw error;
    if (userId && email && (!data || !data.length)) {
      const fallback = await supabase.from(SHIPMENT_TABLE).select('*').eq('email', email).order('created_at', { ascending: false });
      if (fallback.error) throw fallback.error;
      data = fallback.data || [];
    }
    const shipments = await hydrateShipments(data || []);
    res.json({ shipments, mode: 'cloud' });
  } catch (error) {
    logDbError('List customer shipments failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shipments/lookup/:code', async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const code = (req.params.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Tracking code required.' });
  try {
    const { data, error } = await supabase
      .from(SHIPMENT_TABLE)
      .select('*')
      .eq('tracking_code', code)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Shipment not found.' });
    const shipment = await fetchShipmentById(data.id);
    res.json({ shipment: { ...shipment, customerEmail: '', customerName: '', phone: '', address: '' }, mode: 'cloud' });
  } catch (error) {
    logDbError('Lookup shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const trackingCode = String(req.body?.trackingCode || req.body?.tracking_code || '').trim().toUpperCase();
    if (!trackingCode) return res.status(400).json({ error: 'Tracking code required.' });
    const assignment = await fetchUserAssignment(req.body?.customerEmail || req.body?.email, req.body?.customerUserId || req.body?.user_id || '');
    const payload = createShipmentPayload({ ...req.body, trackingCode }, assignment);
    const { data, error } = await supabase.from(SHIPMENT_TABLE).insert(payload).select('*').single();
    if (error) throw error;

    const plan = getRowPlan(data);
    const firstEvent = plan[0];
    await insertMovementRow({
      shipmentId: data.id,
      location: firstEvent?.location,
      status: firstEvent?.status,
      note: firstEvent?.note,
      createdAt: data.created_at,
      movementType: 'major',
      simulated: false
    });

    const shipment = await fetchShipmentById(data.id);
    broadcastRefresh('shipment-created', data.id);
    res.json({ shipment });
  } catch (error) {
    logDbError('Create shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments/:id/pause', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const shipment = await pauseShipment(Number(req.params.id), req.body?.reason || req.body?.pausedReason || req.body?.paused_reason || '');
    res.json({ shipment });
  } catch (error) {
    logDbError('Pause shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments/:id/resume', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const shipment = await resumeShipment(Number(req.params.id));
    res.json({ shipment });
  } catch (error) {
    logDbError('Resume shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/shipments/:id', async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { data: existing, error: fetchError } = await supabase
      .from(SHIPMENT_TABLE)
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) throw fetchError;
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
      const payload = {
        email,
        user_id: userId || existing.user_id || null,
        full_name: customerName || existing.full_name || '',
        confirmed_by_customer: true,
        updated_at: new Date().toISOString()
      };
      const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(payload).eq('id', req.params.id);
      if (updateError) throw updateError;
      const shipment = await fetchShipmentById(req.params.id);
      broadcastRefresh('shipment-claimed', req.params.id);
      return res.json({ shipment });
    }

    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin required.' });

    const nextStatus = req.body?.status ? normalizeStatus(req.body.status) : normalizeStatus(existing.status);
    if (nextStatus === 'paused') {
      const shipment = await pauseShipment(Number(req.params.id), req.body?.pausedReason || req.body?.paused_reason || 'Shipment temporarily paused');
      return res.json({ shipment });
    }
    if (existing.status_control === 'paused' && nextStatus !== 'paused') {
      await resumeShipment(Number(req.params.id));
    }

    let plan = getRowPlan(existing);
    if (req.body?.estimatedArrival || req.body?.estimated_arrival || req.body?.estimated_delivery) {
      const newDeadline = safeIso(req.body.estimatedArrival || req.body.estimated_arrival || req.body.estimated_delivery);
      const currentEta = getDeliveryEta(plan) || existing.estimated_delivery;
      const deltaMs = new Date(newDeadline).getTime() - new Date(currentEta).getTime();
      plan = shiftFutureEvents(plan, Number(existing.current_event_index || 0), deltaMs);
    }

    const nextPointers = getNextPointers(plan, Number(existing.current_event_index || 0));
    const nowIso = new Date().toISOString();
    const updatePayload = {
      status: nextStatus,
      status_control: nextStatus === 'deleted' ? 'active' : (existing.status_control === 'paused' ? 'active' : existing.status_control || 'active'),
      current_location: String(req.body?.currentLocation || req.body?.current_location || existing.current_location || '').trim() || existing.current_location,
      estimated_delivery: nextStatus === 'delivered' ? nowIso : (getDeliveryEta(plan) || existing.estimated_delivery),
      delivery_deadline: getDeliveryEta(plan) || existing.delivery_deadline || existing.estimated_delivery,
      departure_time: req.body?.departureTime || req.body?.departure_time || existing.departure_time || existing.created_at,
      paused_reason: req.body?.pausedReason ?? req.body?.paused_reason ?? (nextStatus === 'paused' ? 'Shipment temporarily on hold' : ''),
      pause_started_at: null,
      notes: req.body?.notes ?? existing.notes ?? '',
      current_step: Number(existing.current_step || 0),
      current_event_index: Number(existing.current_event_index || 0),
      total_events: plan.length,
      movement_plan: JSON.stringify(plan),
      next_movement_at: ['delivered', 'deleted'].includes(nextStatus) ? null : nextPointers.nextMovementAt,
      next_simulation_at: ['delivered', 'deleted'].includes(nextStatus) ? null : nextPointers.nextSimulationAt,
      updated_at: nowIso
    };

    const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(updatePayload).eq('id', req.params.id);
    if (updateError) throw updateError;

    const shouldWriteMovement = Boolean(req.body?.historyTitle || req.body?.historyDetail || req.body?.currentLocation || req.body?.status);
    if (shouldWriteMovement) {
      await insertMovementRow({
        shipmentId: Number(req.params.id),
        location: updatePayload.current_location,
        status: nextStatus,
        note: String(req.body?.historyDetail || req.body?.notes || statusLabel(nextStatus)).trim(),
        movementType: 'manual',
        simulated: false
      });
    }

    const shipment = await fetchShipmentById(req.params.id);
    broadcastRefresh('shipment-updated', req.params.id);
    res.json({ shipment });
  } catch (error) {
    logDbError('Update shipment failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/shipments/:id/customer', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { data: existing, error: fetchError } = await supabase.from(SHIPMENT_TABLE).select('*').eq('id', req.params.id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'Shipment not found.' });

    const statusOverride = req.body?.statusOverride ? normalizeStatus(req.body.statusOverride) : null;
    const payload = {
      full_name: String(req.body?.fullName ?? req.body?.full_name ?? existing.full_name ?? '').trim(),
      email: String(req.body?.email ?? existing.email ?? '').trim().toLowerCase(),
      phone: String(req.body?.phone ?? existing.phone ?? '').trim(),
      destination: String(req.body?.destination ?? existing.destination ?? '').trim(),
      address: String(req.body?.address ?? existing.address ?? '').trim(),
      status: statusOverride || existing.status,
      updated_at: new Date().toISOString()
    };

    const assignment = await fetchUserAssignment(payload.email, existing.user_id || '');
    payload.user_id = assignment.userId || existing.user_id || null;
    if (!payload.full_name) payload.full_name = assignment.fullName || '';
    if (!payload.phone) payload.phone = assignment.phone || '';
    if (!payload.address) payload.address = assignment.address || payload.address;

    const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(payload).eq('id', req.params.id);
    if (updateError) throw updateError;

    if (statusOverride) {
      await insertMovementRow({
        shipmentId: Number(req.params.id),
        location: existing.current_location || 'Logistics Hub',
        status: statusOverride,
        note: `Admin status override applied: ${statusLabel(statusOverride)}.`,
        movementType: 'manual',
        simulated: false
      });
    }

    const shipment = await fetchShipmentById(req.params.id);
    broadcastRefresh('customer-updated', req.params.id);
    res.json({ shipment });
  } catch (error) {
    logDbError('Update customer shipping info failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shipments/:id/movements', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const limit = Math.min(Number(req.query.limit || HISTORY_LIMIT), 200);
    const { data, error } = await supabase
      .from(MOVEMENT_TABLE)
      .select('*')
      .eq('shipment_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ movements: (data || []).map(mapMovementRow) });
  } catch (error) {
    logDbError('List movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments/:id/movements', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { data: shipment, error: shipmentError } = await supabase.from(SHIPMENT_TABLE).select('*').eq('id', req.params.id).maybeSingle();
    if (shipmentError) throw shipmentError;
    if (!shipment) return res.status(404).json({ error: 'Shipment not found.' });

    const status = normalizeStatus(req.body?.status || shipment.status);
    const location = String(req.body?.location || shipment.current_location || 'Logistics Hub').trim() || 'Logistics Hub';
    const note = String(req.body?.note || req.body?.detail || '').trim();
    await insertMovementRow({
      shipmentId: Number(req.params.id),
      location,
      status,
      note: note || `Manual tracking update: ${statusLabel(status)}.`,
      movementType: 'manual',
      simulated: false
    });

    const updatePayload = {
      status,
      current_location: location,
      updated_at: new Date().toISOString()
    };
    const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(updatePayload).eq('id', req.params.id);
    if (updateError) throw updateError;

    const updatedShipment = await fetchShipmentById(req.params.id);
    broadcastRefresh('movement-created', req.params.id);
    res.json({ shipment: updatedShipment });
  } catch (error) {
    logDbError('Create movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/shipments/:id/movements/:movementId', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { data: movement, error: fetchError } = await supabase.from(MOVEMENT_TABLE).select('*').eq('id', req.params.movementId).eq('shipment_id', req.params.id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!movement) return res.status(404).json({ error: 'Tracking update not found.' });

    const payload = {
      location: String(req.body?.location || movement.location || 'Logistics Hub').trim() || 'Logistics Hub',
      status: normalizeStatus(req.body?.status || movement.status),
      note: String(req.body?.note ?? movement.note ?? '').trim() || null
    };

    const { error: updateError } = await supabase.from(MOVEMENT_TABLE).update(payload).eq('id', req.params.movementId);
    if (updateError) throw updateError;

    const shipment = await refreshShipmentFromLatestMovement(Number(req.params.id));
    broadcastRefresh('movement-updated', req.params.id);
    res.json({ shipment });
  } catch (error) {
    logDbError('Edit movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/shipments/:id/movements/:movementId', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { error } = await supabase.from(MOVEMENT_TABLE).delete().eq('id', req.params.movementId).eq('shipment_id', req.params.id);
    if (error) throw error;
    const shipment = await refreshShipmentFromLatestMovement(Number(req.params.id));
    broadcastRefresh('movement-deleted', req.params.id);
    res.json({ ok: true, shipment });
  } catch (error) {
    logDbError('Delete movement history failed', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/shipments/:id', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { error } = await supabase.from(SHIPMENT_TABLE).delete().eq('id', req.params.id);
    if (error) throw error;
    broadcastRefresh('shipment-deleted', req.params.id);
    res.json({ ok: true });
  } catch (error) {
    logDbError('Delete shipment failed', error);
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

server.listen(PORT, async () => {
  console.log(`VeloxShip running → http://localhost:${PORT}`);
  if (!DB_READY) {
    console.warn('[VeloxShip] No database configured — running in local mode.');
    return;
  }
  try {
    const { error } = await supabase.from(SHIPMENT_TABLE).select('id').limit(1);
    if (error) throw error;
    console.log('[VeloxShip] Database connection verified.');
    await runSimulationEngine();
    await runMajorMovementEngine();
    setInterval(runSimulationEngine, ENGINE_POLL_MS);
    setInterval(runMajorMovementEngine, ENGINE_POLL_MS);
  } catch (error) {
    logDbError('DB check failed', error);
  }
});
