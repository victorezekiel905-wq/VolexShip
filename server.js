/* VeloxShip — Node.js / Express server with tracking history + real-time movement engine */
require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const DEFAULT_SUPABASE_URL = 'https://lwrhnnfcmqvdodlsmwif.supabase.co';
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
const TRACKING_STEP_MS = 60 * 60 * 1000;
const ENGINE_TICK_MS = 60 * 1000;
const HISTORY_LIMIT = 50;

let supabase = null;
let engineBusy = false;
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

function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'processing';
  if (['processing', 'pending'].includes(raw)) return 'processing';
  if (['departed', 'confirmed'].includes(raw)) return 'confirmed';
  if (['in transit', 'in_transit'].includes(raw)) return 'in_transit';
  if (['arrived at facility', 'arrived_at_facility', 'customs', 'customs review'].includes(raw)) return 'customs';
  if (['out for delivery', 'out_for_delivery'].includes(raw)) return 'out_for_delivery';
  if (raw === 'delivered') return 'delivered';
  if (raw === 'paused') return 'paused';
  if (raw === 'deleted') return 'deleted';
  return raw.replace(/\s+/g, '_');
}

function statusLabel(status) {
  const normalized = normalizeStatus(status);
  const labels = {
    processing: 'Processing',
    confirmed: 'Departed',
    in_transit: 'In Transit',
    customs: 'Arrived at Facility',
    out_for_delivery: 'Out for Delivery',
    delivered: 'Delivered',
    paused: 'Paused',
    deleted: 'Deleted'
  };
  return labels[normalized] || String(status || 'Processing');
}

function statusStepIndex(status) {
  const normalized = normalizeStatus(status);
  const map = {
    processing: 0,
    confirmed: 1,
    in_transit: 2,
    customs: 3,
    out_for_delivery: 4,
    delivered: 5
  };
  return map[normalized] ?? 0;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function buildMovementPlan() {
  return [
    { location: 'Origin Facility', status: 'processing', note: 'Shipment received and registered at the origin facility.' },
    { location: 'Regional Sorting Center', status: 'confirmed', note: 'Shipment departed the origin facility for regional sorting.' },
    { location: 'International Transit Hub', status: 'in_transit', note: 'Shipment is moving through the main transit network.' },
    { location: 'Logistics Processing Facility', status: 'customs', note: 'Shipment arrived at a logistics processing facility.' },
    { location: 'Distribution Center', status: 'out_for_delivery', note: 'Shipment left the distribution center for final handoff.' },
    { location: 'Final Delivery Hub', status: 'delivered', note: 'Shipment delivered successfully.' }
  ];
}

function computeEstimatedDelivery(currentStep, movementPlan, baseDate = new Date()) {
  const remainingSteps = Math.max((movementPlan?.length || 0) - 1 - Number(currentStep || 0), 0);
  return new Date(baseDate.getTime() + remainingSteps * TRACKING_STEP_MS).toISOString();
}

function nextMovementAt(currentStep, movementPlan, baseDate = new Date()) {
  const isFinal = Number(currentStep || 0) >= (movementPlan?.length || 1) - 1;
  return isFinal ? null : new Date(baseDate.getTime() + TRACKING_STEP_MS).toISOString();
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
    statusLabel: label
  };
}

function fromRow(row, historyRows = []) {
  if (!row) return null;
  const legacyMeta = parseJson(row.movement_history, {});
  const plan = parseJson(row.movement_plan, buildMovementPlan());
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
    pausedReason: row.paused_reason || legacyMeta.pausedReason || '',
    pausedProgress: legacyMeta.pausedProgress ?? null,
    departureTime: row.departure_time || legacyMeta.departureTime || null,
    estimatedArrival: row.estimated_delivery || legacyMeta.estimatedArrival || null,
    createdAt: row.created_at || legacyMeta.createdAt || new Date().toISOString(),
    notes: row.notes || legacyMeta.notes || '',
    confirmedByCustomer: Boolean(row.confirmed_by_customer ?? legacyMeta.confirmedByCustomer),
    deleted: normalizeStatus(row.status) === 'deleted',
    deletedAt: row.deleted_at || legacyMeta.deletedAt || null,
    currentStep: Number(row.current_step || 0),
    totalSteps: Array.isArray(plan) ? plan.length : 0,
    movementPlan: Array.isArray(plan) ? plan : buildMovementPlan(),
    history
  };
}

function createShipmentPayload(body = {}, assignment = null) {
  const now = new Date();
  const movementPlan = buildMovementPlan();
  const createdAt = now.toISOString();
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
    status: 'processing',
    current_location: movementPlan[0].location,
    estimated_delivery: computeEstimatedDelivery(0, movementPlan, now),
    departure_time: body.departureTime || body.departure_time || createdAt,
    paused_reason: '',
    notes: String(body.notes || '').trim(),
    shipping_mode: String(body.shippingMode || body.shipping_mode || 'Express').trim(),
    priority: String(body.priority || 'Priority').trim(),
    confirmed_by_customer: false,
    current_step: 0,
    movement_plan: JSON.stringify(movementPlan),
    next_movement_at: nextMovementAt(0, movementPlan, now),
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: null
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

async function insertMovementRow({ shipmentId, location, status, note, createdAt = null }) {
  const payload = {
    shipment_id: shipmentId,
    location: String(location || 'Logistics Hub').trim() || 'Logistics Hub',
    status: statusLabel(status),
    note: String(note || '').trim() || null
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

async function refreshShipmentFromLatestMovement(shipmentId, fallbackRow = null) {
  const source = fallbackRow || (await supabase.from(SHIPMENT_TABLE).select('*').eq('id', shipmentId).maybeSingle()).data;
  if (!source) return null;
  const movementPlan = parseJson(source.movement_plan, buildMovementPlan());
  const { data: latestRows, error } = await supabase
    .from(MOVEMENT_TABLE)
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const latest = latestRows?.[0] || null;
  const normalized = normalizeStatus(latest?.status || source.status || 'processing');
  const step = latest ? Math.max(statusStepIndex(normalized), Number(source.current_step || 0)) : Number(source.current_step || 0);
  const baseDate = new Date();
  const updatePayload = {
    status: normalized,
    current_location: latest?.location || source.current_location,
    current_step: step,
    estimated_delivery: normalized === 'delivered' ? baseDate.toISOString() : computeEstimatedDelivery(step, movementPlan, baseDate),
    next_movement_at: ['delivered', 'deleted', 'paused'].includes(normalized) ? null : nextMovementAt(step, movementPlan, baseDate),
    updated_at: baseDate.toISOString()
  };
  const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(updatePayload).eq('id', shipmentId);
  if (updateError) throw updateError;
  return fetchShipmentById(shipmentId);
}

function broadcastRefresh(reason = 'shipments:refresh', shipmentId = null) {
  const message = JSON.stringify({ type: 'refresh', reason, shipmentId, at: new Date().toISOString() });
  for (const client of wsClients) {
    if (client.readyState === 1) {
      try { client.send(message); } catch {}
    }
  }
}

async function progressShipmentRow(row) {
  const movementPlan = parseJson(row.movement_plan, buildMovementPlan());
  let currentStep = Number(row.current_step || 0);
  let cursor = row.next_movement_at ? new Date(row.next_movement_at) : null;
  let lastRow = row;
  const now = new Date();
  if (!cursor) return false;
  let changed = false;

  while (cursor && cursor.getTime() <= now.getTime() && currentStep < movementPlan.length - 1) {
    const nextStep = currentStep + 1;
    const step = movementPlan[nextStep];
    await insertMovementRow({
      shipmentId: row.id,
      location: step.location,
      status: step.status,
      note: step.note,
      createdAt: cursor.toISOString()
    });

    const delivered = normalizeStatus(step.status) === 'delivered';
    const updatePayload = {
      status: normalizeStatus(step.status),
      current_location: step.location,
      current_step: nextStep,
      estimated_delivery: delivered ? cursor.toISOString() : computeEstimatedDelivery(nextStep, movementPlan, cursor),
      next_movement_at: delivered ? null : new Date(cursor.getTime() + TRACKING_STEP_MS).toISOString(),
      updated_at: now.toISOString()
    };

    const { data, error } = await supabase
      .from(SHIPMENT_TABLE)
      .update(updatePayload)
      .eq('id', row.id)
      .select('*')
      .single();
    if (error) throw error;
    lastRow = data;
    currentStep = nextStep;
    cursor = updatePayload.next_movement_at ? new Date(updatePayload.next_movement_at) : null;
    changed = true;
  }

  if (changed) {
    broadcastRefresh('movement-engine', row.id);
  }
  return changed;
}

async function runMovementEngine() {
  if (!DB_READY || engineBusy) return;
  engineBusy = true;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from(SHIPMENT_TABLE)
      .select('*')
      .not('next_movement_at', 'is', null)
      .lte('next_movement_at', nowIso)
      .neq('status', 'delivered')
      .neq('status', 'deleted')
      .neq('status', 'paused')
      .order('next_movement_at', { ascending: true })
      .limit(100);
    if (error) throw error;
    for (const row of data || []) {
      await progressShipmentRow(row);
    }
  } catch (error) {
    logDbError('Movement engine tick failed', error);
  } finally {
    engineBusy = false;
  }
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

    const plan = parseJson(data.movement_plan, buildMovementPlan());
    await insertMovementRow({
      shipmentId: data.id,
      location: plan[0].location,
      status: plan[0].status,
      note: plan[0].note,
      createdAt: data.created_at
    });

    const shipment = await fetchShipmentById(data.id);
    broadcastRefresh('shipment-created', data.id);
    res.json({ shipment });
  } catch (error) {
    logDbError('Create shipment failed', error);
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

    const movementPlan = parseJson(existing.movement_plan, buildMovementPlan());
    const nextStatus = req.body?.status ? normalizeStatus(req.body.status) : normalizeStatus(existing.status);
    const nextStep = req.body?.status ? Math.max(statusStepIndex(nextStatus), Number(existing.current_step || 0)) : Number(existing.current_step || 0);
    const now = new Date();
    const updatePayload = {
      status: nextStatus,
      current_location: String(req.body?.currentLocation || req.body?.current_location || existing.current_location || '').trim() || existing.current_location,
      estimated_delivery: nextStatus === 'delivered'
        ? now.toISOString()
        : (req.body?.estimatedArrival || req.body?.estimated_delivery || computeEstimatedDelivery(nextStep, movementPlan, now)),
      departure_time: req.body?.departureTime || req.body?.departure_time || existing.departure_time || now.toISOString(),
      paused_reason: req.body?.pausedReason ?? req.body?.paused_reason ?? existing.paused_reason ?? '',
      notes: req.body?.notes ?? existing.notes ?? '',
      current_step: nextStep,
      next_movement_at: ['delivered', 'deleted', 'paused'].includes(nextStatus) ? null : nextMovementAt(nextStep, movementPlan, now),
      updated_at: now.toISOString()
    };

    const { error: updateError } = await supabase.from(SHIPMENT_TABLE).update(updatePayload).eq('id', req.params.id);
    if (updateError) throw updateError;

    const shouldWriteMovement = Boolean(req.body?.historyTitle || req.body?.historyDetail || req.body?.currentLocation || req.body?.status);
    if (shouldWriteMovement) {
      await insertMovementRow({
        shipmentId: Number(req.params.id),
        location: updatePayload.current_location,
        status: nextStatus,
        note: String(req.body?.historyDetail || req.body?.notes || statusLabel(nextStatus)).trim()
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
    const nextStep = statusOverride ? Math.max(statusStepIndex(statusOverride), Number(existing.current_step || 0)) : Number(existing.current_step || 0);
    const movementPlan = parseJson(existing.movement_plan, buildMovementPlan());
    const now = new Date();

    const payload = {
      full_name: String(req.body?.fullName ?? req.body?.full_name ?? existing.full_name ?? '').trim(),
      email: String(req.body?.email ?? existing.email ?? '').trim().toLowerCase(),
      phone: String(req.body?.phone ?? existing.phone ?? '').trim(),
      destination: String(req.body?.destination ?? existing.destination ?? '').trim(),
      address: String(req.body?.address ?? existing.address ?? '').trim(),
      status: statusOverride || existing.status,
      current_step: nextStep,
      estimated_delivery: statusOverride && statusOverride !== 'delivered'
        ? computeEstimatedDelivery(nextStep, movementPlan, now)
        : (statusOverride === 'delivered' ? now.toISOString() : existing.estimated_delivery),
      next_movement_at: statusOverride ? (['delivered', 'deleted', 'paused'].includes(statusOverride) ? null : nextMovementAt(nextStep, movementPlan, now)) : existing.next_movement_at,
      updated_at: now.toISOString()
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
        note: `Admin status override applied: ${statusLabel(statusOverride)}.`
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
    await insertMovementRow({ shipmentId: Number(req.params.id), location, status, note: note || `Manual tracking update: ${statusLabel(status)}.` });

    const movementPlan = parseJson(shipment.movement_plan, buildMovementPlan());
    const nextStep = Math.max(statusStepIndex(status), Number(shipment.current_step || 0));
    const baseDate = new Date();
    const updatePayload = {
      status,
      current_location: location,
      current_step: nextStep,
      estimated_delivery: status === 'delivered' ? baseDate.toISOString() : computeEstimatedDelivery(nextStep, movementPlan, baseDate),
      next_movement_at: ['delivered', 'deleted', 'paused'].includes(status) ? null : nextMovementAt(nextStep, movementPlan, baseDate),
      updated_at: baseDate.toISOString()
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
      status: statusLabel(req.body?.status || movement.status),
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
    await runMovementEngine();
    setInterval(runMovementEngine, ENGINE_TICK_MS);
  } catch (error) {
    logDbError('DB check failed', error);
  }
});
