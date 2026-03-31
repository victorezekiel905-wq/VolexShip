/* VeloxShip — Auth page logic */
document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;

  const session = getCurrentUser();
  const onAuth  = location.pathname.endsWith('login.html') || location.pathname.endsWith('signup.html');
  if (session && onAuth) {
    window.location.href = session.role === 'admin' ? 'admin.html' : 'dashboard.html';
    return;
  }

  /* ── Login ── */
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const alert = document.getElementById('authAlert');
      const btn   = loginForm.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        const user = await loginUser(
          document.getElementById('loginEmail').value,
          document.getElementById('loginPassword').value
        );
        alert.className = 'alert success';
        alert.textContent = user.role === 'admin'
          ? 'Access verified. Redirecting…'
          : 'Welcome back! Redirecting to your dashboard…';
        setTimeout(() => {
          window.location.href = user.role === 'admin' ? 'admin.html' : 'dashboard.html';
        }, 600);
      } catch (err) {
        alert.className   = 'alert error';
        alert.textContent = err.message;
        btn.disabled      = false;
        btn.textContent   = 'Sign in';
      }
    });
  }

  /* ── Sign up ── */
  const signupForm = document.getElementById('signupForm');
  if (signupForm) {
    signupForm.addEventListener('submit', async e => {
      e.preventDefault();
      const alert = document.getElementById('authAlert');
      const btn   = signupForm.querySelector('button[type="submit"]');
      const pwd   = document.getElementById('signupPassword').value;
      const conf  = document.getElementById('signupConfirm').value;
      if (pwd !== conf) {
        alert.className = 'alert error';
        alert.textContent = 'Passwords do not match.';
        return;
      }
      btn.disabled = true; btn.textContent = 'Creating account…';
      try {
        signupUser({
          name:    document.getElementById('signupName').value,
          email:   document.getElementById('signupEmail').value,
          password: pwd,
          phone:   document.getElementById('signupPhone').value,
          company: document.getElementById('signupCompany').value,
          address: document.getElementById('signupAddress').value
        });
        alert.className   = 'alert success';
        alert.textContent = 'Account created! Redirecting to your dashboard…';
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 600);
      } catch (err) {
        alert.className   = 'alert error';
        alert.textContent = err.message;
        btn.disabled      = false;
        btn.textContent   = 'Create account';
      }
    });
  }
});
