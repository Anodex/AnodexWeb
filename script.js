import { PRODUCTS, PLATFORMS, assetsForPlatform, assetDescription, fetchLatestRelease } from './releases.js';
import { startNebula } from './nebula.js';

const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* The fluid nebula becomes the page background wherever the browser can run it. When it
   cannot, nothing is swapped in and the hero keeps the starfield below. */
const nebula = startNebula(document.querySelector('.nebula'));
if (nebula) document.documentElement.classList.add('nebula-active');

document.querySelector('#year').textContent = new Date().getFullYear();

const menuButton = document.querySelector('.menu-toggle');
const mobileNav = document.querySelector('#mobile-nav');
menuButton.hidden = false;
function closeMenu() {
  mobileNav.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open navigation');
}
menuButton.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  mobileNav.hidden = !isOpen;
});
mobileNav.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !mobileNav.hidden) { closeMenu(); menuButton.focus(); }
});
matchMedia('(min-width: 601px)').addEventListener('change', (event) => { if (event.matches) closeMenu(); });

/* The actual brand artwork is never sampled, recolored, or redrawn.
   Only the surrounding light field moves; hover adds a slight perspective tilt. */
function startHeroVisual() {
  const hero = document.querySelector('.hero');
  const stage = document.querySelector('.hero-brand');
  const canvas = document.querySelector('.hero-canvas');
  const motionToggle = document.querySelector('.motion-toggle');
  const context = canvas?.getContext('2d');
  if (!hero || !stage || !context) return;

  let width = 0;
  let height = 0;
  let frame = 0;
  let visible = true;
  let paused = stillMotion.matches;
  let sceneTime = 0;
  let lastTime = 0;
  const pointer = { x: 0, y: 0 };
  const stars = Array.from({ length: 45 }, (_, i) => ({
    x: ((i * 137.508) % 1000) / 1000,
    y: ((i * 97.73) % 1000) / 1000,
    size: .5 + (i % 4) * .24,
    depth: .35 + (i % 7) * .08,
    phase: i * 1.73,
  }));

  function render() {
    context.clearRect(0, 0, width, height);
    if (nebula) return;
    const mobile = width <= 600;
    for (const star of stars) {
      const x = star.x * width * (mobile ? 1 : .48) + pointer.x * star.depth * 6;
      const y = ((star.y + sceneTime * .000004 * star.depth) % 1) * height + pointer.y * 3;
      const opacity = (.15 + .12 * Math.sin(sceneTime * .0005 + star.phase)) * (mobile ? .35 : 1);
      context.fillStyle = `rgba(${star.x < .45 ? '172,121,251' : '104,112,255'},${opacity})`;
      context.beginPath();
      context.arc(x, y, star.size, 0, Math.PI * 2);
      context.fill();
    }
  }
  function layout() {
    const rect = hero.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    render();
  }
  function tick(now) {
    if (lastTime) sceneTime += Math.min(now - lastTime, 64);
    lastTime = now;
    render();
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }
  function play() {
    if (nebula || frame || paused || !visible || document.hidden) return;
    frame = requestAnimationFrame(tick);
  }
  function updateMotion() {
    motionToggle.hidden = stillMotion.matches;
    motionToggle.textContent = paused ? 'Play motion' : 'Pause motion';
    motionToggle.setAttribute('aria-pressed', String(paused));
    hero.classList.toggle('motion-paused', paused);
    nebula?.setPaused(paused);
    stage.style.removeProperty('--tilt-x');
    stage.style.removeProperty('--tilt-y');
    pointer.x = 0;
    pointer.y = 0;
    if (paused) { stop(); render(); } else play();
  }
  motionToggle.addEventListener('click', () => { paused = !paused; updateMotion(); });
  stillMotion.addEventListener('change', () => { paused = stillMotion.matches; updateMotion(); });
  hero.addEventListener('pointermove', (event) => {
    if (paused || event.pointerType === 'touch' || width <= 600) return;
    const rect = hero.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / width * 2 - 1;
    pointer.y = (event.clientY - rect.top) / height * 2 - 1;
    stage.style.setProperty('--tilt-x', `${-pointer.y * 3}deg`);
    stage.style.setProperty('--tilt-y', `${pointer.x * 4}deg`);
  });
  hero.addEventListener('pointerleave', () => {
    pointer.x = 0;
    pointer.y = 0;
    stage.style.removeProperty('--tilt-x');
    stage.style.removeProperty('--tilt-y');
  });
  if ('IntersectionObserver' in window) new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) play(); else stop();
  }).observe(hero);
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(hero);
  else window.addEventListener('resize', layout);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else play(); });
  layout();
  updateMotion();
}
startHeroVisual();

/* Landings. Each marked section fades and settles into place as it arrives and
   recedes as it leaves, so the travel gaps between them open onto bare nebula.
   Presence is derived from how much of a section overlaps the viewport, which
   makes it symmetric - it fades on the way back up too, unlike a one-shot
   reveal. */
const landings = [...document.querySelectorAll('[data-vantage]')];
if (landings.length && !stillMotion.matches) {
  document.documentElement.classList.add('landing-ready');
  const held = new Set();
  let queued = false;

  function updateLandings() {
    queued = false;
    const viewport = window.innerHeight;
    for (const section of landings) {
      const rect = section.getBoundingClientRect();
      /* Measured against whichever is smaller, the section or the viewport, so a
         section taller than the screen can still reach full presence. */
      const span = Math.min(rect.height, viewport);
      const overlap = Math.min(rect.bottom, viewport) - Math.max(rect.top, 0);
      let presence = span > 0 ? (overlap / span - .12) / .5 : 0;
      presence = Math.min(Math.max(presence, 0), 1);
      presence = presence * presence * (3 - 2 * presence);
      if (held.has(section)) presence = 1;
      const offset = ((rect.top + rect.bottom) / 2 - viewport / 2) / viewport;
      section.style.setProperty('--presence', presence.toFixed(3));
      section.style.setProperty('--presence-y', `${(offset * 44 * (1 - presence)).toFixed(1)}px`);
    }
  }
  function scheduleLandings() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(updateLandings);
  }

  window.addEventListener('scroll', scheduleLandings, { passive: true });
  window.addEventListener('resize', scheduleLandings, { passive: true });
  /* Keyboard focus must never come to rest on something faded out. */
  document.addEventListener('focusin', (event) => {
    held.clear();
    const section = event.target.closest?.('[data-vantage]');
    if (section) held.add(section);
    updateLandings();
  });
  updateLandings();
}

/* Section reveals and the cursor spotlight on cards. */
const revealables = document.querySelectorAll('[data-reveal]');
if (!stillMotion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('reveal-ready');
  const revealObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  revealables.forEach((element) => revealObserver.observe(element));
}
document.querySelectorAll('[data-spotlight]').forEach((card) => {
  card.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  });
});

/* Workflow switcher. Describes capabilities in words and highlights the schematic;
   it does not imitate the product's interface. */
const workflows = {
  build: {
    title: 'From an idea to a working project.',
    description: 'Work directly with your files, code, and project conventions. Let Anodex help make changes, run checks, and bring the results back for review.',
    points: ['Reads your files, structure, and project instructions', 'Runs commands and checks inside a scope you set', 'Keeps changes visible through diffs and checkpoints'],
    note: 'Scoped tools. Reviewable changes. You stay in control.',
    nodes: ['n-files', 'n-tools', 'n-model'],
  },
  research: {
    title: 'Get to a well-grounded answer.',
    description: 'Work through a question with a visible plan. Anodex gathers sources, compares them, and keeps the evidence trail attached to the answer.',
    points: ['Breaks a question into a plan you can steer', 'Reads and compares sources, then cites them', 'Says where the evidence runs out'],
    note: 'Web research reaches external sources and services you choose.',
    nodes: ['n-web', 'n-files', 'n-model'],
  },
  automate: {
    title: 'Put recurring work on the calendar.',
    description: 'Hand off the checks you keep repeating. Anodex runs them on a schedule you set and keeps a record of every run.',
    points: ['Scope a task once, then set its schedule', 'Each run keeps a reviewable history', 'Stop, edit, or rerun a task at any time'],
    note: 'Scheduled work runs while Anodex is open on your desktop.',
    nodes: ['n-sched', 'n-tools', 'n-model'],
  },
};
const tabs = [...document.querySelectorAll('[data-workflow]')];
const schematicNodes = [...document.querySelectorAll('.workspace-map .map-node[id]')];
const pointItems = [...document.querySelectorAll('#wf-points li > span')];
function selectWorkflow(tab) {
  const workflow = workflows[tab.dataset.workflow];
  tabs.forEach((item) => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
  document.querySelector('#workflow-panel').setAttribute('aria-labelledby', tab.id);
  document.querySelector('#wf-title').textContent = workflow.title;
  document.querySelector('#wf-description').textContent = workflow.description;
  pointItems.forEach((item, index) => { item.textContent = workflow.points[index]; });
  document.querySelector('#wf-note').textContent = workflow.note;
  schematicNodes.forEach((node) => node.classList.toggle('is-active', workflow.nodes.includes(node.id)));
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectWorkflow(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectWorkflow(tabs[next]); tabs[next].focus(); }
  });
});
if (tabs.length) selectWorkflow(tabs[0]);

// Preserve working release-page links for no-JS, network failures, and rate limits.
const fallbackMarkup = Object.fromEntries(Object.keys(PRODUCTS).map((key) => [key, document.querySelector(`#${key}-assets`).innerHTML]));
const detectedPlatform = /android/i.test(navigator.userAgent) ? 'android' : /windows/i.test(navigator.userAgent) ? 'windows' : /macintosh|mac os x/i.test(navigator.userAgent) && !/iphone|ipad/i.test(navigator.userAgent) ? 'mac' : /linux/i.test(navigator.userAgent) ? 'linux' : null;

function renderRelease(key, release) {
  const container = document.querySelector(`#${key}-assets`);
  const fragment = document.createDocumentFragment();
  for (const platform of PRODUCTS[key].platforms) {
    const assets = assetsForPlatform(release, platform);
    // Missing platforms link to this release. Never reuse an older installer.
    for (const asset of assets.length ? assets : [null]) {
      const link = document.createElement('a');
      link.className = `platform-link${!asset ? ' unavailable' : detectedPlatform === platform ? ' recommended' : ''}`;
      link.dataset.platform = platform;
      link.href = asset?.url || release.url;
      const label = document.createElement('span');
      label.className = 'platform-name';
      label.append(PLATFORMS[platform].name);
      const detail = document.createElement('small');
      detail.textContent = asset ? assetDescription(asset, platform) : 'No installer in this release · View release';
      label.append(detail);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('icon');
      icon.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', asset ? '#i-download' : '#i-external');
      icon.append(use);
      link.append(label, icon);
      link.setAttribute('aria-label', asset ? `Download Anodex${key === 'mobile' ? ' Mobile' : ''} ${release.tag} for ${PLATFORMS[platform].name}: ${assetDescription(asset, platform)}` : `View release: no ${PLATFORMS[platform].name} installer available`);
      fragment.append(link);
    }
  }
  container.replaceChildren(fragment);
  const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(release.publishedAt));
  document.querySelector(`[data-release-meta="${key}"]`).textContent = `${release.tag} · ${date}`;
  document.querySelector(`[data-release-channel="${key}"]`).textContent = release.preview ? 'Latest preview' : 'Latest release';
  document.querySelector(`[data-release-notes="${key}"]`).href = release.url;
  if (key === 'desktop') document.querySelector('#hero-release-label').textContent = `${release.tag} ${release.preview ? 'preview' : 'available now'}`;
}

function restoreFallback(key) {
  document.querySelector(`#${key}-assets`).innerHTML = fallbackMarkup[key];
  document.querySelector(`[data-release-meta="${key}"]`).textContent = 'See the current version on GitHub';
  document.querySelector(`[data-release-channel="${key}"]`).textContent = key === 'desktop' ? 'Desktop' : 'Android companion';
  document.querySelector(`[data-release-notes="${key}"]`).href = `https://github.com/${PRODUCTS[key].repo}/releases`;
  if (key === 'desktop') document.querySelector('#hero-release-label').textContent = 'Anodex desktop + Mobile';
}

let refreshing = false;
let lastChecked = 0;
async function refreshReleases() {
  if (refreshing) return;
  refreshing = true;
  const keys = Object.keys(PRODUCTS);
  try {
    const results = await Promise.allSettled(keys.map((key) => fetchLatestRelease(PRODUCTS[key].repo)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') renderRelease(keys[index], result.value);
      else restoreFallback(keys[index]);
    });
    const liveCount = results.filter((result) => result.status === 'fulfilled').length;
    const status = document.querySelector('#release-status');
    status.dataset.state = liveCount === keys.length ? 'live' : 'fallback';
    status.textContent = liveCount === keys.length
      ? 'Up to date with GitHub. Release links refresh automatically.'
      : liveCount ? 'Some release details are unavailable. Those buttons open GitHub to find the latest download.'
        : 'Release details are temporarily unavailable. Open GitHub using the buttons above for the latest downloads.';
  } finally { refreshing = false; lastChecked = Date.now(); }
}
refreshReleases();
setInterval(() => { if (!document.hidden) refreshReleases(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastChecked > 60 * 1000) refreshReleases();
});
