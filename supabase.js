/* VeloxShip — Supabase browser integration layer */
(() => {
  const SUPABASE_URL = 'https://udjgrrjnyhaersaiuudj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkamdycmpueWhhZXJzYWl1dWRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NTcxNTIsImV4cCI6MjA5MDUzMzE1Mn0.VVpnC9UPVTmNtPU1lS5HzDEqfi8XXEhJ1kAJsABeAtI';
  const TABLE = 'volex';
  const ADMIN_EMAIL_VALUE = 'amos@gmail.com';
  const ADMIN_PASSWORD_VALUE = 'Amos@2026';

  window.VELOXSHIP_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
  try { localStorage.setItem('veloxship_supabase_anon_key', SUPABASE_ANON_KEY); } catch {}

  function asIso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function toInputDateTime(value) {
    if (!value) return null;
    const iso = asIso(value);
    return iso ? iso.slice(0, 16) : null;
  }

  function normalizeStatusValue(status) {
    const raw = String(status || '').trim();
    const lower = raw.toLowerCase();
    if (!lower) return 'processing';
    if (lower === 'pending') return 'processing';
    if (lower === 'processing') return 'processing';
    if (lower === 'confirmed') return 'confirmed';
    if (lower === 'in transit' || lower === 'in_transit') return 'in_transit';
    if (lower === 'customs review' || lower === 'customs') return 'customs';
    if (lower === 'out for delivery' || lower === 'out_for_delivery') return 'out_for_delivery';
    if (lower === 'delivered') return 'delivered';
    if (lower === 'paused') return 'paused';
    if (lower === 'deleted') return 'deleted';
    return lower.replace(/\s+/g, '_');
  }

  function mapUserRow(row) {
    if (!row) return null;
    return {
      id: row.user_id || String(row.id || vsUid('usr')),
      name: row.full_name || row.email || 'Customer',
      email: (row.email || '').toLowerCase(),
      password: row.password || '',
      phone: row.phone || '',
      company: row.shipment_title || '',
      address: row.address || '',
      role: 'user',
      createdAt: row.created_at || new Date().toISOString()
    };
  }

  function syncUsersIntoState(users) {
    const state = readState();
    const existing = new Map((state.users || []).map(user => [String(user.email || '').toLowerCase(), user]));
    (users || []).forEach(user => {
      if (!user?.email) return;
      existing.set(String(user.email).toLowerCase(), user);
    });
    state.users = Array.from(existing.values()).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    saveState(state);
    return state.users;
  }

  async function getBrowserClient() {
    window.__veloxshipRuntime = {
      ...window.__veloxshipRuntime,
      dbReady: false,
      browserDbReady: false,
      table: TABLE,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY
    };
    return ensureBrowserSupabase();
  }

  function parseMeta(row) {
    const raw = row?.movement_history;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return {}; }
  }

  normalizeShipment = function(row) {
    if (!row) return null;
    const meta = parseMeta(row);
    let history = row.history ?? meta.history ?? [];
    if (typeof history === 'string') {
      try { history = JSON.parse(history); } catch { history = []; }
    }
    const status = normalizeStatusValue(row.status ?? row.Status ?? meta.status);
    return {
      id: row.id || meta.id || vsUid('shp'),
      trackingCode: row.trackingCode || row.tracking_code || meta.trackingCode || '',
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
      currentLocation: row.currentLocation || row.current_location || meta.currentLocation || row.origin || 'Origin hub',
      shippingMode: row.shippingMode || row.shipping_mode || meta.shippingMode || 'Express',
      priority: row.priority || meta.priority || 'Priority',
      status,
      pausedReason: row.pausedReason || row.paused_reason || meta.pausedReason || '',
      pausedProgress: row.pausedProgress ?? row.paused_progress ?? meta.pausedProgress ?? null,
      departureTime: row.departureTime || row.departure_time || meta.departureTime || null,
      estimatedArrival: row.estimatedArrival || row.estimated_arrival || row.estimated_delivery || meta.estimatedArrival || null,
      createdAt: row.createdAt || row.created_at || meta.createdAt || new Date().toISOString(),
      notes: row.notes || meta.notes || '',
      confirmedByCustomer: Boolean(row.confirmedByCustomer ?? row.confirmed_by_customer ?? meta.confirmedByCustomer),
      deleted: Boolean(row.deleted ?? meta.deleted ?? (status === 'deleted')),
      deletedAt: row.deleted_at || meta.deletedAt || null,
      history: Array.isArray(history) ? history : []
    };
  };
  window.normalizeShipment = normalizeShipment;

  async function syncRemoteUsers() {
    try {
      const client = await getBrowserClient();
      if (!client) return getAllUsers();
      const { data, error } = await client
        .from(TABLE)
        .select('id,user_id,full_name,email,phone,address,password,shipment_title,created_at,role,tracking_code')
        .eq('role', 'user')
        .is('tracking_code', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return syncUsersIntoState((data || []).map(mapUserRow).filter(Boolean));
    } catch (error) {
      logDataError('Remote user sync failed.', error);
      return getAllUsers();
    }
  }

  loadRuntimeConfig = async function() {
    window.__veloxshipRuntime = {
      ...window.__veloxshipRuntime,
      dbReady: false,
      browserDbReady: false,
      table: TABLE,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY
    };
    try { localStorage.setItem('veloxship_supabase_anon_key', SUPABASE_ANON_KEY); } catch {}
    try { await ensureBrowserSupabase(); } catch (error) { logDataError('Browser Supabase initialization failed.', error); }
    await syncRemoteUsers();
    return window.__veloxshipRuntime;
  };
  window.loadRuntimeConfig = loadRuntimeConfig;

  signupUser = async function({ name, email, password, phone = '', company = '', address = '' }) {
    const safeEmail = String(email || '').trim().toLowerCase();
    if (!safeEmail) throw new Error('Email is required.');
    if (safeEmail === ADMIN_EMAIL_VALUE) throw new Error('This email is reserved.');
    const client = await getBrowserClient();
    const existingLocal = readState().users.find(user => user.email === safeEmail);
    if (existingLocal) throw new Error('An account with this email already exists.');
    const { data: existingRows, error: checkError } = await client
      .from(TABLE)
      .select('id,email')
      .eq('role', 'user')
      .is('tracking_code', null)
      .ilike('email', safeEmail)
      .limit(1);
    if (checkError) throw checkError;
    if ((existingRows || []).length) throw new Error('An account with this email already exists.');

    const createdAt = new Date().toISOString();
    const userId = vsUid('usr');
    const row = {
      user_id: userId,
      role: 'user',
      full_name: String(name || '').trim(),
      email: safeEmail,
      phone: String(phone || '').trim(),
      address: String(address || '').trim(),
      shipment_title: String(company || '').trim() || null,
      password: String(password || ''),
      created_at: createdAt,
      time: createdAt,
      tracking_code: null,
      shipment_title: String(company || '').trim() || null
    };

    const { data, error } = await client.from(TABLE).insert(row).select().single();
    if (error) throw error;

    const user = mapUserRow(data);
    syncUsersIntoState([user]);
    setSession(user);
    return user;
  };
  window.signupUser = signupUser;

  loginUser = async function(email, password) {
    const safeEmail = String(email || '').trim().toLowerCase();
    const safePassword = String(password || '');
    if (safeEmail === ADMIN_EMAIL_VALUE) {
      if (safePassword !== ADMIN_PASSWORD_VALUE) throw new Error('Invalid email or password.');
      const admin = {
        id: 'admin_ops',
        name: 'Operations Admin',
        email: ADMIN_EMAIL_VALUE,
        role: 'admin',
        phone: '',
        company: 'VeloxShip Operations',
        address: 'VeloxShip HQ',
        createdAt: new Date().toISOString(),
        adminToken: null
      };
      setSession(admin);
      return admin;
    }

    await syncRemoteUsers();
    const localUser = getAllUsers().find(user => user.email === safeEmail && user.password === safePassword);
    if (!localUser) throw new Error('Invalid email or password.');
    setSession(localUser);
    return localUser;
  };
  window.loginUser = loginUser;

  ensureShipmentsLoaded = async function(force = false) {
    const ctx = getLoadContext();
    const list = window.__veloxshipCache.shipments;
    if (!force && Array.isArray(list) && list.length && ctx !== 'public') return list;
    if (ctx === 'public') {
      window.__veloxshipCache.shipments = [];
      window.__veloxshipCache.mode = 'cloud';
      return [];
    }

    try {
      const client = await getBrowserClient();
      const user = getCurrentUser();
      let query = client
        .from(TABLE)
        .select('*')
        .not('tracking_code', 'is', null)
        .order('created_at', { ascending: false });

      if (ctx === 'user') {
        query = query.ilike('email', String(user?.email || '').trim().toLowerCase());
      }

      const { data, error } = await query;
      if (error) throw error;
      const shipments = (data || []).map(normalizeShipment).filter(item => item && item.trackingCode);
      window.__veloxshipCache.shipments = shipments;
      window.__veloxshipCache.mode = 'cloud';
      saveLocalShipments(shipments);
      return shipments;
    } catch (error) {
      logDataError('Browser Supabase shipment fetch failed.', error);
      const local = readLocalShipments().map(normalizeShipment).filter(Boolean);
      window.__veloxshipCache.shipments = local;
      window.__veloxshipCache.mode = 'local';
      return local;
    }
  };
  window.ensureShipmentsLoaded = ensureShipmentsLoaded;

  fetchShipmentByCode = async function(code) {
    const trackingCode = String(code || '').trim().toUpperCase();
    if (!trackingCode) throw new Error('Tracking code is required.');
    const cached = findShipmentByCode(trackingCode);
    if (cached) return cached;

    const client = await getBrowserClient();
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('tracking_code', trackingCode)
      .not('tracking_code', 'is', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Shipment not found. Please check the tracking code and try again.');
    return mergeShipmentIntoCache(normalizeShipment(data));
  };
  window.fetchShipmentByCode = fetchShipmentByCode;

  function buildMovementMessage(shipment, history) {
    if (shipment.status === 'deleted' || shipment.deleted) return 'Shipment has been deleted';
    if (shipment.status === 'paused') return `Shipment paused: ${shipment.pausedReason || 'Movement paused by operations.'}`;
    return history[0]?.detail || history[0]?.title || 'Shipment created';
  }

  function shipmentRowFromPayload(shipment, dbStatus) {
    const history = Array.isArray(shipment.history) ? shipment.history : [];
    return {
      tracking_code: shipment.trackingCode,
      user_id: shipment.customerEmail || shipment.id,
      role: 'admin',
      full_name: shipment.customerName || '',
      email: shipment.customerEmail || '',
      phone: shipment.phone || null,
      address: shipment.address || null,
      shipment_title: shipment.productName || 'Unnamed item',
      weight: Number(shipment.weightKg || 0),
      origin: shipment.origin || null,
      destination: shipment.destination || null,
      status: dbStatus,
      current_location: shipment.currentLocation || shipment.origin || null,
      movement_history: JSON.stringify({
        trackingCode: shipment.trackingCode,
        customerEmail: shipment.customerEmail || '',
        customerName: shipment.customerName || '',
        phone: shipment.phone || '',
        address: shipment.address || '',
        productName: shipment.productName || 'Unnamed item',
        productCategory: shipment.productCategory || 'General cargo',
        productDescription: shipment.productDescription || '',
        quantity: Number(shipment.quantity || 1),
        weightKg: Number(shipment.weightKg || 0),
        valueUsd: Number(shipment.valueUsd || 0),
        origin: shipment.origin || '',
        destination: shipment.destination || '',
        currentLocation: shipment.currentLocation || shipment.origin || '',
        shippingMode: shipment.shippingMode || 'Express',
        priority: shipment.priority || 'Priority',
        status: shipment.status || 'processing',
        pausedReason: shipment.pausedReason || '',
        pausedProgress: shipment.pausedProgress ?? null,
        departureTime: shipment.departureTime || null,
        estimatedArrival: shipment.estimatedArrival || null,
        createdAt: shipment.createdAt || new Date().toISOString(),
        notes: shipment.notes || '',
        confirmedByCustomer: Boolean(shipment.confirmedByCustomer),
        deleted: Boolean(shipment.deleted || shipment.status === 'deleted'),
        deletedAt: shipment.deletedAt || null,
        message: buildMovementMessage(shipment, history),
        history
      }),
      estimated_delivery: shipment.estimatedArrival || null,
      paused_reason: shipment.pausedReason || null,
      created_at: shipment.createdAt || new Date().toISOString(),
      password: null,
      time: new Date().toISOString()
    };
  }

  createShipment = async function(payload) {
    await ensureShipmentsLoaded(true);
    const customerEmail = String(payload.customerEmail || '').trim().toLowerCase();
    const matchedUser = getAllUsers().find(user => user.email === customerEmail) || null;
    const code = generateTrackingCode(getAllShipments().map(item => item.trackingCode));
    const createdAt = new Date().toISOString();

    const shipment = normalizeShipment({
      id: vsUid('shp'),
      trackingCode: code,
      customerEmail,
      customerName: matchedUser?.name || payload.customerName || '',
      productName: payload.productName || payload.shipmentTitle || 'Unnamed item',
      productCategory: payload.productCategory || 'General cargo',
      productDescription: payload.productDescription || '',
      quantity: Number(payload.quantity || 1),
      weightKg: Number(payload.weightKg || 1),
      valueUsd: Number(payload.valueUsd || 0),
      origin: payload.origin || '—',
      destination: payload.destination || '—',
      currentLocation: payload.origin || payload.currentLocation || 'Origin hub',
      shippingMode: payload.shippingMode || 'Express',
      priority: payload.priority || 'Priority',
      status: 'processing',
      departureTime: asIso(payload.departureTime),
      estimatedArrival: asIso(payload.estimatedArrival),
      createdAt,
      notes: payload.notes || '',
      pausedReason: '',
      confirmedByCustomer: false,
      history: []
    });

    appendHistory(shipment, {
      status: shipment.status,
      title: 'Shipment created',
      location: shipment.currentLocation,
      detail: `Tracking code ${shipment.trackingCode} generated for this shipment.`
    });

    const client = await getBrowserClient();
    const dbRow = shipmentRowFromPayload(shipment, 'Pending');
    const { data, error } = await client.from(TABLE).insert(dbRow).select().single();
    if (error) throw error;

    const saved = normalizeShipment(data);
    mergeShipmentIntoCache(saved);
    saveLocalShipments(window.__veloxshipCache.shipments);
    return saved;
  };
  window.createShipment = createShipment;

  updateShipment = async function(id, updates) {
    await ensureShipmentsLoaded(true);
    const shipment = getAllShipments().find(item => String(item.id) === String(id));
    if (!shipment) throw new Error('Shipment not found.');

    const next = JSON.parse(JSON.stringify(shipment));
    Object.assign(next, updates || {});

    const previousStatus = shipment.status;
    const priorProgress = computeShipmentProgress(shipment);
    if (updates.status === 'paused') {
      next.pausedProgress = priorProgress;
      next.pausedReason = updates.pausedReason || next.pausedReason || 'Movement paused by operations.';
    }
    if (updates.status === 'deleted') {
      next.deleted = true;
      next.deletedAt = next.deletedAt || new Date().toISOString();
    }
    if (previousStatus === 'paused' && updates.status && updates.status !== 'paused') {
      next.pausedProgress = null;
      if (!updates.pausedReason) next.pausedReason = '';
    }

    if (updates.estimatedArrival) next.estimatedArrival = asIso(updates.estimatedArrival);
    if (updates.departureTime) next.departureTime = asIso(updates.departureTime);
    if (updates.estimatedArrival === null || updates.estimatedArrival === '') next.estimatedArrival = null;
    if (updates.departureTime === null || updates.departureTime === '') next.departureTime = null;
    if (updates.currentLocation) next.currentLocation = updates.currentLocation;
    if (updates.status) next.status = normalizeStatusValue(updates.status);
    if (next.status !== 'deleted' && updates.status !== 'deleted') {
      next.deleted = Boolean(next.deleted && next.status === 'deleted');
    }

    if (updates.status && normalizeStatusValue(updates.status) !== previousStatus) {
      appendHistory(next, {
        status: next.status,
        title: updates.historyTitle || (next.status === 'deleted' ? 'Shipment has been deleted' : next.status === 'paused' ? 'Shipment paused' : `Status: ${getStatusMeta(next.status).label}`),
        location: next.currentLocation || shipment.currentLocation,
        detail: updates.historyDetail || (next.status === 'deleted'
          ? 'Shipment has been deleted'
          : next.status === 'paused'
            ? `Shipment paused: ${next.pausedReason || 'Movement paused by operations.'}`
            : 'Shipment updated by operations.')
      });
    } else if (updates.historyTitle || updates.historyDetail || updates.currentLocation) {
      appendHistory(next, {
        status: next.status,
        title: updates.historyTitle || 'Location update',
        location: next.currentLocation || shipment.currentLocation,
        detail: updates.historyDetail || 'Shipment location refreshed.'
      });
    }

    const client = await getBrowserClient();
    const dbStatusMap = {
      processing: 'Pending',
      confirmed: 'Confirmed',
      in_transit: 'In transit',
      customs: 'Customs review',
      out_for_delivery: 'Out for delivery',
      delivered: 'Delivered',
      paused: 'Paused'
    };
    const row = shipmentRowFromPayload(next, dbStatusMap[next.status] || next.status || 'Pending');
    const { data, error } = await client.from(TABLE).update(row).eq('id', id).select().single();
    if (error) throw error;

    const saved = normalizeShipment(data);
    window.__veloxshipCache.shipments = getAllShipments().map(item => String(item.id) === String(id) ? saved : item);
    saveLocalShipments(window.__veloxshipCache.shipments);
    return saved;
  };
  window.updateShipment = updateShipment;

  deleteShipment = async function(id) {
    return updateShipment(id, {
      status: 'deleted',
      deleted: true,
      deletedAt: new Date().toISOString(),
      historyTitle: 'Shipment has been deleted',
      historyDetail: 'Shipment has been deleted'
    });
  };
  window.deleteShipment = deleteShipment;

  claimTrackingCode = async function(user, code) {
    const shipment = await fetchShipmentByCode(code);
    if (!shipment) throw new Error('Tracking code not found.');
    if (shipment.customerEmail && shipment.customerEmail.toLowerCase() !== user.email.toLowerCase()) {
      throw new Error('This tracking code is already assigned to another account.');
    }
    throw new Error('Tracking confirmation is disabled by the current database policy. Ask operations to assign the shipment to your email.');
  };
  window.claimTrackingCode = claimTrackingCode;
})();
