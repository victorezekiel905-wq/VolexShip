/* VeloxShip — Node.js / Express server */
require('dotenv').config();
const path   = require('path');
const crypto = require('crypto');
const express = require('express');

const DEFAULT_SUPABASE_URL = 'https://lwrhnnfcmqvdodlsmwif.supabase.co';
const SUPABASE_URL         = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_KEY         = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;

let supabase = null;

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
} catch (e) { console.warn('[VeloxShip] Supabase client load failed:', e.message); }

const app            = express();
const PORT           = process.env.PORT || 3000;
const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL || 'amos@gmail.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Amos@2026';
const SECRET         = process.env.ADMIN_TOKEN_SECRET || `${ADMIN_EMAIL}:${ADMIN_PASSWORD}:velox`;
const TABLE          = 'Shipment';
const ORIGIN         = process.env.ALLOWED_ORIGIN || '*';
const DB_READY       = Boolean(supabase);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-email, x-admin-password, x-customer-email');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'ignore' }));

/* ── Token helpers ── */
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
  } catch { return false; }
}
function isAdmin(req) {
  const auth = req.header('authorization') || '';
  if (auth.startsWith('Bearer ')) return verifyToken(auth.slice(7).trim());
  return (req.header('x-admin-email') || '').toLowerCase() === ADMIN_EMAIL &&
         (req.header('x-admin-password') || '') === ADMIN_PASSWORD;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin authorization required.' });
  next();
}
function getCustomerEmail(req) {
  return (req.header('x-customer-email') || req.query.email || '').trim().toLowerCase();
}

/* ── DB helpers ── */
function fromRow(row) {
  if (!row) return null;
  let meta = {};
  try { meta = typeof row.movement_history === 'string' ? JSON.parse(row.movement_history) : (row.movement_history || {}); } catch {}
  return {
    id: row.id,
    trackingCode: row.tracking_code || meta.trackingCode || '',
    customerEmail: row.email || meta.customerEmail || '',
    customerName: row.full_name || meta.customerName || '',
    productName: row.shipment_title || meta.productName || 'Unnamed item',
    productCategory: meta.productCategory || 'General cargo',
    productDescription: meta.productDescription || '',
    quantity: Number(meta.quantity || 1),
    weightKg: Number(row.weight ?? meta.weightKg ?? 1),
    valueUsd: Number(meta.valueUsd || 0),
    origin: row.origin || meta.origin || '—',
    destination: row.destination || meta.destination || '—',
    currentLocation: row.current_location || meta.currentLocation || row.origin || 'Origin hub',
    shippingMode: meta.shippingMode || 'Express',
    priority: meta.priority || 'Priority',
    status: row.Status || row.status || meta.status || 'processing',
    pausedReason: row.paused_reason || meta.pausedReason || '',
    pausedProgress: meta.pausedProgress ?? null,
    departureTime: meta.departureTime || null,
    estimatedArrival: row.estimated_delivery || meta.estimatedArrival || null,
    createdAt: row.created_at || meta.createdAt || new Date().toISOString(),
    notes: meta.notes || '',
    confirmedByCustomer: Boolean(meta.confirmedByCustomer),
    history: Array.isArray(meta.history) ? meta.history : []
  };
}
function toRow(body, cur = null) {
  const c = cur ? fromRow(cur) : {};
  const m = { ...(c || {}), ...body };
  const history = Array.isArray(body.history) ? body.history : (c.history || []);
  return {
    tracking_code: body.tracking_code ?? body.trackingCode ?? c.trackingCode ?? '',
    full_name:     body.full_name ?? body.customerName ?? c.customerName ?? '',
    email:         body.email     ?? body.customerEmail ?? c.customerEmail ?? '',
    shipment_title: body.shipment_title ?? body.productName ?? c.productName ?? 'Unnamed item',
    weight:        body.weight ?? body.weightKg ?? c.weightKg ?? 1,
    origin:        body.origin   ?? c.origin    ?? '—',
    destination:   body.destination ?? c.destination ?? '—',
    Status:        body.Status   ?? body.status  ?? c.status ?? 'processing',
    current_location: body.current_location ?? body.currentLocation ?? c.currentLocation ?? 'Origin hub',
    estimated_delivery: body.estimated_delivery ?? body.estimatedArrival ?? c.estimatedArrival ?? null,
    paused_reason: body.paused_reason ?? body.pausedReason ?? c.pausedReason ?? '',
    movement_history: JSON.stringify({
      trackingCode: body.tracking_code ?? body.trackingCode ?? c.trackingCode ?? '',
      customerEmail: body.email ?? body.customerEmail ?? c.customerEmail ?? '',
      customerName: body.full_name ?? body.customerName ?? c.customerName ?? '',
      productName: body.shipment_title ?? body.productName ?? c.productName ?? '',
      productCategory: body.productCategory ?? c.productCategory ?? 'General cargo',
      productDescription: body.productDescription ?? c.productDescription ?? '',
      quantity: Number(body.quantity ?? c.quantity ?? 1),
      weightKg: Number(body.weight ?? body.weightKg ?? c.weightKg ?? 1),
      valueUsd: Number(body.valueUsd ?? c.valueUsd ?? 0),
      origin: body.origin ?? c.origin ?? '—',
      destination: body.destination ?? c.destination ?? '—',
      currentLocation: body.current_location ?? body.currentLocation ?? c.currentLocation ?? 'Origin hub',
      shippingMode: body.shippingMode ?? c.shippingMode ?? 'Express',
      priority: body.priority ?? c.priority ?? 'Priority',
      status: body.Status ?? body.status ?? c.status ?? 'processing',
      pausedReason: body.paused_reason ?? body.pausedReason ?? c.pausedReason ?? '',
      pausedProgress: body.pausedProgress ?? c.pausedProgress ?? null,
      departureTime: body.departureTime ?? c.departureTime ?? null,
      estimatedArrival: body.estimated_delivery ?? body.estimatedArrival ?? c.estimatedArrival ?? null,
      createdAt: body.created_at ?? body.createdAt ?? c.createdAt ?? new Date().toISOString(),
      notes: body.notes ?? c.notes ?? '',
      confirmedByCustomer: Boolean(body.confirmed_by_customer ?? body.confirmedByCustomer ?? c.confirmedByCustomer),
      history
    }),
    created_at: body.created_at ?? body.createdAt ?? c.createdAt ?? new Date().toISOString(),
    time: new Date().toISOString()
  };
}

async function lookupShipmentByTrackingCode(code) {
  if (!DB_READY) {
    const error = new Error('Database not configured.');
    error.status = 503;
    throw error;
  }

  const trackingCode = (code || '').trim().toUpperCase();
  if (!trackingCode) {
    const error = new Error('Tracking code required.');
    error.status = 400;
    throw error;
  }

  const { data, error } = await supabase.from(TABLE).select('*').eq('tracking_code', trackingCode).maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error('Shipment not found.');
    notFound.status = 404;
    throw notFound;
  }
  return fromRow(data);
}

/* ── Routes ── */
app.get('/api/runtime', (req, res) => res.json({
  ok: true,
  dbReady: DB_READY,
  table: TABLE,
  supabaseUrl: SUPABASE_URL,
  supabaseAnonKey: SUPABASE_ANON_KEY
}));

app.get('/api/health', async (req, res) => {
  if (!DB_READY) return res.json({ ok: false, dbReady: false, error: 'Database not configured.' });
  try {
    const { data, error } = await supabase.from(TABLE).select('id,tracking_code').limit(1);
    if (error) throw error;
    return res.json({ ok: true, dbReady: true, sample: data?.[0]?.id ?? null });
  } catch (e) {
    logDbError('Health check failed', e);
    return res.json({ ok: false, dbReady: false, error: e.message });
  }
});

app.post('/api/auth/admin/login', (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const pass  = req.body?.password || '';
  if (email !== ADMIN_EMAIL || pass !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid email or password.' });
  return res.json({ ok: true, token: createToken(email), admin: { email: ADMIN_EMAIL } });
});

app.get('/api/shipments', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: false });
  if (error) { logDbError('List shipments failed', error); return res.status(500).json({ error: error.message }); }
  res.json({ shipments: (data || []).map(fromRow), mode: 'cloud' });
});

app.get('/api/shipments/mine', async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const email = getCustomerEmail(req);
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const { data, error } = await supabase.from(TABLE).select('*').ilike('email', email).order('created_at', { ascending: false });
  if (error) { logDbError('List customer shipments failed', error); return res.status(500).json({ error: error.message }); }
  res.json({ shipments: (data || []).map(fromRow), mode: 'cloud' });
});

app.get('/api/shipments/lookup/:code', async (req, res) => {
  try {
    const shipment = await lookupShipmentByTrackingCode(req.params.code);
    res.json({ shipment, mode: 'cloud' });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    if (error.status === 400) return res.status(400).json({ error: error.message });
    if (error.status === 503) return res.status(503).json({ error: error.message });
    logDbError('Lookup shipment failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/track/:trackingId', async (req, res) => {
  try {
    const shipment = await lookupShipmentByTrackingCode(req.params.trackingId);
    res.json({ shipment, mode: 'cloud' });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: error.message });
    if (error.status === 400) return res.status(400).json({ error: error.message });
    if (error.status === 503) return res.status(503).json({ error: error.message });
    logDbError('Public track lookup failed', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/shipments', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const row = toRow(req.body || {});
  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (error) { logDbError('Create shipment failed', error); return res.status(500).json({ error: error.message }); }
  res.json({ shipment: fromRow(data) });
});

app.patch('/api/shipments/:id', async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const { data: existing, error: fetchErr } = await supabase.from(TABLE).select('*').eq('id', req.params.id).maybeSingle();
  if (fetchErr) {
    logDbError('Fetch shipment before update failed', fetchErr);
    return res.status(500).json({ error: fetchErr.message });
  }
  if (!existing) return res.status(404).json({ error: 'Shipment not found.' });

  if (req.body?.claimTracking) {
    const email = (req.body.customer_email || req.body.customerEmail || req.body.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required.' });
    const curEmail = (existing.email || '').toLowerCase();
    if (curEmail && curEmail !== email) return res.status(409).json({ error: 'Already assigned to another account.' });
    const row = toRow({ ...req.body, email, confirmed_by_customer: true, confirmedByCustomer: true }, existing);
    const { data, error } = await supabase.from(TABLE).update(row).eq('id', req.params.id).select().single();
    if (error) { logDbError('Claim tracking update failed', error); return res.status(500).json({ error: error.message }); }
    return res.json({ shipment: fromRow(data) });
  }

  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin required.' });
  const row = toRow(req.body || {}, existing);
  const { data, error } = await supabase.from(TABLE).update(row).eq('id', req.params.id).select().single();
  if (error) { logDbError('Update shipment failed', error); return res.status(500).json({ error: error.message }); }
  res.json({ shipment: fromRow(data) });
});

app.delete('/api/shipments/:id', requireAdmin, async (req, res) => {
  if (!DB_READY) return res.status(503).json({ error: 'Database not configured.' });
  const { error } = await supabase.from(TABLE).delete().eq('id', req.params.id);
  if (error) { logDbError('Delete shipment failed', error); return res.status(500).json({ error: error.message }); }
  res.json({ ok: true });
});

app.get('/track/:trackingId', (req, res) => {
  const trackingId = encodeURIComponent((req.params.trackingId || '').trim().toUpperCase());
  return res.redirect(`/tracking.html?tracking=${trackingId}#track-now`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, async () => {
  console.log(`VeloxShip running → http://localhost:${PORT}`);
  if (!DB_READY) {
    console.warn('[VeloxShip] No database configured — running in local mode.');
  } else {
    try {
      const { data, error } = await supabase.from(TABLE).select('id').limit(1);
      if (error) throw error;
      console.log('[VeloxShip] Database connection verified.');
    } catch (e) { logDbError('DB check failed', e); }
  }
});
