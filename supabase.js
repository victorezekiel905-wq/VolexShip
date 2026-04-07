/* VeloxShip — Supabase browser integration layer (users + runtime sync) */
(() => {
  const SUPABASE_URL = 'https://udjgrrjnyhaersaiuudj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkamdycmpueWhhZXJzYWl1dWRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NTcxNTIsImV4cCI6MjA5MDUzMzE1Mn0.VVpnC9UPVTmNtPU1lS5HzDEqfi8XXEhJ1kAJsABeAtI';
  const USER_TABLE = 'volex';
  const ADMIN_EMAIL_VALUE = 'amos@gmail.com';
  const ADMIN_PASSWORD_VALUE = 'Amos@2026';
  const baseLoadRuntimeConfig = typeof loadRuntimeConfig === 'function'
    ? loadRuntimeConfig
    : async () => (window.__veloxshipRuntime || {});

  let browserClient = null;

  window.VELOXSHIP_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
  try { localStorage.setItem('veloxship_supabase_anon_key', SUPABASE_ANON_KEY); } catch {}

  function mapUserRow(row) {
    if (!row) return null;
    return {
      id: row.user_id || String(row.id || vsUid('usr')),
      name: row.full_name || row.email || 'Customer',
      email: String(row.email || '').trim().toLowerCase(),
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
    state.users = Array.from(existing.values())
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    saveState(state);
    return state.users;
  }

  async function getBrowserClient() {
    if (browserClient) return browserClient;
    const client = await ensureBrowserSupabase();
    browserClient = client;
    return browserClient;
  }

  async function syncRemoteUsers() {
    try {
      const client = await getBrowserClient();
      if (!client) return getAllUsers();
      const { data, error } = await client
        .from(USER_TABLE)
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
    const runtime = await baseLoadRuntimeConfig();
    window.__veloxshipRuntime = {
      ...window.__veloxshipRuntime,
      ...runtime,
      browserDbReady: false,
      supabaseUrl: runtime?.supabaseUrl || SUPABASE_URL,
      supabaseAnonKey: runtime?.supabaseAnonKey || SUPABASE_ANON_KEY
    };
    try { localStorage.setItem('veloxship_supabase_anon_key', window.__veloxshipRuntime.supabaseAnonKey || SUPABASE_ANON_KEY); } catch {}
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
      .from(USER_TABLE)
      .select('id,email')
      .eq('role', 'user')
      .is('tracking_code', null)
      .eq('email', safeEmail)
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
      tracking_code: null
    };

    const { data, error } = await client.from(USER_TABLE).insert(row).select().single();
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
    const user = getAllUsers().find(item => item.email === safeEmail && item.password === safePassword);
    if (!user) throw new Error('Invalid email or password.');
    setSession(user);
    return user;
  };
  window.loginUser = loginUser;
})();
