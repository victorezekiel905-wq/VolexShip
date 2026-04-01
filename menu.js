/* VeloxShip — Mobile menu interaction fix */
document.addEventListener('DOMContentLoaded', async () => {
  if (window.vsReady) await window.vsReady;
  const menuBtn = document.getElementById('mobileNavToggle');
  const menu = document.getElementById('mobileDrawer');
  const header = document.getElementById('siteHeader');

  if (!menuBtn || !menu || !header) return;
  if (menu.dataset.menuBound === 'true') return;
  menu.dataset.menuBound = 'true';

  const icon = menuBtn.querySelector('i');
  const menuLinks = () => Array.from(menu.querySelectorAll('a, button'));

  const syncMenuState = open => {
    menu.classList.toggle('active', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (icon) icon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
  };

  menuBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    syncMenuState(!menu.classList.contains('active'));
  });

  menu.addEventListener('click', event => {
    event.stopPropagation();
  });

  menuLinks().forEach(link => {
    link.style.pointerEvents = 'auto';
    link.style.cursor = 'pointer';
    link.addEventListener('click', () => {
      syncMenuState(false);
    });
  });

  menu.addEventListener('click', event => {
    const clickedLink = event.target.closest('a, button');
    if (!clickedLink) return;
    syncMenuState(false);
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.site-header')) {
      syncMenuState(false);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') syncMenuState(false);
  });

  syncMenuState(false);
});
