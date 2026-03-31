'use strict';

// ── CONFIG ───────────────────────────────────────────────────
const API_BASE = 'http://localhost:3001/api';

// ── SHARED UTILITY ──────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── AUTH HELPERS ─────────────────────────────────────────────
function getToken() {
  return localStorage.getItem('folio_token');
}
function getUser() {
  try { return JSON.parse(localStorage.getItem('folio_user')); } catch { return null; }
}
function setAuthData(token, user) {
  localStorage.setItem('folio_token', token);
  localStorage.setItem('folio_user', JSON.stringify(user));
}
function clearAuthData() {
  localStorage.removeItem('folio_token');
  localStorage.removeItem('folio_user');
}

// ── API HELPERS ──────────────────────────────────────────────
async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const token = getToken();

  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
      ...options.headers
    },
    ...options
  };

  const response = await fetch(url, config);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

// ── FAVOURITES HELPERS ────────────────────────────────────────
let _favsCache = null;
let _favsLoaded = false;

async function loadFavs() {
  if (!getToken()) return;
  _favsCache = await getFavs();
  _favsLoaded = true;
}

function isFav(key) {
  if (!_favsLoaded || !_favsCache) return false;
  return _favsCache.some(f => f.key === key);
}

async function toggleFav(book) {
  const favs = await getFavs();
  const idx = favs.findIndex(f => f.key === book.key);

  try {
    if (idx >= 0) {
      await removeFav(book.key);
      showToast('Removed from favourites');
    } else {
      await saveFav(book);
      showToast('Added to favourites');
    }
    updateFavBadge();
    return idx < 0; // true = now is fav
  } catch (err) {
    showToast('Failed to update favourites');
    return false;
  }
}

async function updateFavBadge() {
  const badge = document.getElementById('navFavBadge');
  if (!badge) return;

  const favs = await getFavs();
  const count = favs.length;
  badge.textContent = count;
  badge.classList.toggle('visible', count > 0);
}

// ── TOAST ─────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  clearTimeout(_toastTimer);
  const t = document.getElementById('toast');
  const m = document.getElementById('toastMsg');
  if (!t || !m) return;
  m.textContent = msg;
  t.classList.add('show');
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── SHARED NAV (index + favorite) ────────────────────────────
async function initAppNav() {
  const user = getUser();
  if (!user) { window.location.href = 'auth.html'; return false; }

  // Load favourites for the session
  await loadFavs();

  const firstName = user.name ? user.name.split(' ')[0] : 'Reader';
  const initials  = user.name ? user.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '?';

  const el = id => document.getElementById(id);
  if (el('navName'))     el('navName').textContent     = firstName;
  if (el('navAvatar'))   el('navAvatar').textContent   = initials;
  if (el('dropdownName'))  el('dropdownName').textContent  = user.name  || 'Reader';
  if (el('dropdownEmail')) el('dropdownEmail').textContent = user.email || '';

  updateFavBadge();

  // Close dropdown on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.nav-user')) {
      document.getElementById('navDropdown')?.classList.remove('open');
    }
  });

  return true;
}

function toggleDropdown() {
  document.getElementById('navDropdown')?.classList.toggle('open');
}

function handleLogout() {
  clearAuthData();
  window.location.href = 'auth.html';
}

// ── SHARED MODAL HELPERS ──────────────────────────────────────
function closeModal() {
  document.getElementById('modal')?.classList.remove('open');
  document.body.style.overflow = '';
  _currentBook = null;
}

async function fetchAndSetDescription(bookKey) {
  const el = document.getElementById('modalDesc');
  if (!el) return;
  if (!bookKey) { el.innerHTML = '<span class="modal-desc-loading">No description available.</span>'; return; }
  try {
    const res = await fetch(`https://openlibrary.org${bookKey}.json`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const raw  = data.description;
    const desc = raw ? (typeof raw === 'string' ? raw : raw.value) : null;
    el.innerHTML = desc
      ? esc(desc.slice(0, 700)) + (desc.length > 700 ? '…' : '')
      : '<span class="modal-desc-loading">No description available for this book.</span>';
  } catch {
    el.innerHTML = '<span class="modal-desc-loading">No description available for this book.</span>';
  }
}

// ── PAGE: INDEX ───────────────────────────────────────────────
let _allResults   = [];
let _currentQuery = '';
let _abortCtrl    = null;
let _currentBook  = null;

async function initIndex() {
  if (!(await initAppNav())) return;

  const user = getUser();
  const firstName = user?.name?.split(' ')[0] || 'Reader';
  const welcomeEl = document.getElementById('welcomeText');
  if (welcomeEl) {
    welcomeEl.innerHTML = `Welcome back, ${firstName}. A reader lives a thousand lives before he dies.<br>Start your next adventure — search for a book above.`;
  }

  document.getElementById('searchBtn')?.addEventListener('click', doSearch);
  document.getElementById('searchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('decadeFilter')?.addEventListener('change', applyFiltersAndSort);
  document.getElementById('sortBy')?.addEventListener('change', applyFiltersAndSort);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function quickSearch(term) {
  const inp = document.getElementById('searchInput');
  if (inp) inp.value = term;
  doSearch();
}

async function doSearch() {
  const inp = document.getElementById('searchInput');
  const q   = inp?.value.trim();
  if (!q) { inp?.focus(); return; }

  _currentQuery = q;
  _showLoader();

  if (_abortCtrl) _abortCtrl.abort();
  _abortCtrl = new AbortController();

  const type = document.getElementById('searchType')?.value || 'q';

  try {
    const params = new URLSearchParams({
      limit: 80,
      fields: 'key,title,author_name,first_publish_year,cover_i,subject,edition_count,number_of_pages_median'
    });
    type === 'q' ? params.set('q', q) : params.set(type, q);

    const data = await apiRequest(`/search?${params}`, { signal: _abortCtrl.signal });
    _allResults = data.docs || [];
    applyFiltersAndSort();
  } catch (err) {
    if (err.name === 'AbortError') return;
    _showError(err.message.includes('Failed to fetch')
      ? 'Network error — check your connection.'
      : `Error: ${err.message}`);
  }
}

function applyFiltersAndSort() {
  if (!_allResults.length && _currentQuery) { _showEmpty(); return; }
  if (!_allResults.length) return;

  let results = [..._allResults];
  const dec  = document.getElementById('decadeFilter')?.value || '';
  const sort = document.getElementById('sortBy')?.value || 'relevance';

  if (dec === 'pre1970') results = results.filter(b => b.first_publish_year && b.first_publish_year < 1970);
  else if (dec) {
    const s = parseInt(dec);
    results = results.filter(b => b.first_publish_year && b.first_publish_year >= s && b.first_publish_year < s + 10);
  }

  if (sort === 'new')        results.sort((a, b) => (b.first_publish_year || 0) - (a.first_publish_year || 0));
  else if (sort === 'old')   results.sort((a, b) => (a.first_publish_year || 9999) - (b.first_publish_year || 9999));
  else if (sort === 'title_asc')  results.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (sort === 'title_desc') results.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
  else if (sort === 'editions')   results.sort((a, b) => (b.edition_count || 0) - (a.edition_count || 0));

  if (!results.length) { _showEmpty(); return; }
  _renderGrid(results);
}

function _renderGrid(books) {
  _hideAll();
  const grid      = document.getElementById('booksGrid');
  const statusBar = document.getElementById('statusBar');
  grid.innerHTML  = '';
  statusBar.classList.add('visible');
  document.getElementById('statusText').textContent  = `${books.length} result${books.length !== 1 ? 's' : ''}`;
  document.getElementById('statusQuery').textContent = `"${_currentQuery}"`;
  books.forEach((book, i) => grid.appendChild(_createCard(book, i)));
}

function _createCard(book, idx) {
  const card    = document.createElement('div');
  card.className = 'book-card';
  card.style.animationDelay = `${Math.min(idx * 0.04, 0.6)}s`;

  const faved   = isFav(book.key);
  const authors = book.author_name ? book.author_name.slice(0, 2).join(', ') : 'Unknown Author';
  const year    = book.first_publish_year || '—';
  const subjects= (book.subject || []).slice(0, 2);

  const coverHTML = book.cover_i
    ? `<img class="book-cover" src="https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg" alt="${esc(book.title)}" loading="lazy" onerror="this.outerHTML='<div class=book-cover-placeholder><span class=spine-icon><i data-lucide=book></i></span></div>'">`
    : `<div class="book-cover-placeholder"><span class="spine-icon"><i data-lucide="book"></i></span><span class="spine-title">${esc(book.title)}</span></div>`;

  card.innerHTML = `
    <button class="card-fav-btn ${faved ? 'active' : ''}" data-key="${esc(book.key || '')}" title="${faved ? 'Remove from favourites' : 'Add to favourites'}"><i data-lucide="heart" class="${faved ? 'fill-red' : ''}"></i></button>
    ${coverHTML}
    <div class="book-meta">
      <div class="book-title">${esc(book.title)}</div>
      <div class="book-author">${esc(authors)}</div>
      ${subjects.length ? `<div class="book-subjects">${subjects.map(s => `<span class="subject-tag">${esc(s.slice(0, 20))}</span>`).join('')}</div>` : ''}
      <div class="book-year">${year}</div>
    </div>`;

  card.querySelector('.card-fav-btn').addEventListener('click', e => {
    e.stopPropagation();
    const btn    = e.currentTarget;
    const icon   = btn.querySelector('i');
    const nowFav = toggleFav(book);
    btn.classList.toggle('active', nowFav);
    icon.classList.toggle('fill-red', nowFav);
    _syncModalFavBtn(book.key, nowFav);
  });

  card.addEventListener('click', () => openBookModal(book));
  return card;
}

async function openBookModal(book) {
  _currentBook   = book;
  const authors  = book.author_name ? book.author_name.join(', ') : 'Unknown Author';
  const year     = book.first_publish_year || 'Unknown';
  const editions = book.edition_count || '—';
  const pages    = book.number_of_pages_median || '—';
  const olKey    = book.key ? `https://openlibrary.org${book.key}` : null;
  const subjects = (book.subject || []).slice(0, 5);
  const faved    = isFav(book.key);

  const coverHTML = book.cover_i
    ? `<img class="modal-cover" src="https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg" alt="${esc(book.title)}" onerror="this.outerHTML='<div class=modal-cover-placeholder><i data-lucide=book></i></div>'">`
    : `<div class="modal-cover-placeholder"><i data-lucide="book"></i></div>`;

  document.getElementById('modalContent').innerHTML = `
    <div class="modal-cover-wrap">${coverHTML}</div>
    <div class="modal-content">
      <div class="modal-eyebrow">Open Library</div>
      <h2 class="modal-title">${esc(book.title)}</h2>
      <div class="modal-author">by ${esc(authors)}</div>
      <div class="modal-desc-label">About this book</div>
      <div class="modal-desc" id="modalDesc"><span class="modal-desc-loading">Fetching description…</span></div>
      <div class="modal-meta-row">
        <div class="modal-meta-item"><span class="label">First Published</span><span class="value">${year}</span></div>
        <div class="modal-meta-item"><span class="label">Editions</span><span class="value">${editions}</span></div>
        <div class="modal-meta-item"><span class="label">Avg Pages</span><span class="value">${pages}</span></div>
      </div>
      ${subjects.length ? `<div class="book-subjects" style="margin-bottom:1rem">${subjects.map(s => `<span class="subject-tag">${esc(s.slice(0, 28))}</span>`).join('')}</div>` : ''}
      <div class="modal-actions">
        ${olKey ? `<a class="modal-link" href="${olKey}" target="_blank" rel="noopener">View on Open Library →</a>` : ''}
        <button class="modal-fav-btn ${faved ? 'active' : ''}" id="modalFavBtn" onclick="handleModalFav()">
          <span class="heart"><i data-lucide="heart" class="${faved ? 'fill-red' : ''}"></i></span>
          <span id="modalFavLabel">${faved ? 'Saved' : 'Save'}</span>
        </button>
      </div>
    </div>`;

  document.getElementById('modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  fetchAndSetDescription(book.key);
}

function handleModalFav() {
  if (!_currentBook) return;
  const nowFav = toggleFav(_currentBook);
  _syncModalFavBtn(_currentBook.key, nowFav);
  const cardBtn = document.querySelector(`.card-fav-btn[data-key="${CSS.escape(_currentBook.key || '')}"]`);
  if (cardBtn) { 
    cardBtn.classList.toggle('active', nowFav); 
    const icon = cardBtn.querySelector('i');
    if (icon) icon.classList.toggle('fill-red', nowFav);
  }
}

function _syncModalFavBtn(key, nowFav) {
  if (!_currentBook || _currentBook.key !== key) return;
  const btn = document.getElementById('modalFavBtn');
  if (!btn) return;
  btn.classList.toggle('active', nowFav);
  const icon = btn.querySelector('.heart i');
  if (icon) icon.classList.toggle('fill-red', nowFav);
  const lbl = document.getElementById('modalFavLabel');
  if (lbl) lbl.textContent = nowFav ? 'Saved' : 'Save';
}

function _showLoader() {
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('loader').classList.add('visible');
  document.getElementById('emptyState').classList.remove('visible');
  document.getElementById('errorState').classList.remove('visible');
  document.getElementById('booksGrid').innerHTML = '';
  document.getElementById('statusBar').classList.remove('visible');
}
function _hideAll() {
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('loader').classList.remove('visible');
  document.getElementById('emptyState').classList.remove('visible');
  document.getElementById('errorState').classList.remove('visible');
}
function _showEmpty() {
  _hideAll();
  document.getElementById('emptyState').classList.add('visible');
  document.getElementById('statusBar').classList.remove('visible');
}
function _showError(msg) {
  _hideAll();
  document.getElementById('errorState').classList.add('visible');
  document.getElementById('errorMsg').textContent = msg;
}

// ── PAGE: FAVORITE ────────────────────────────────────────────
async function initFavorite() {
  if (!(await initAppNav())) return;

  const user = getUser();
  const firstName = user?.name?.split(' ')[0] || 'Reader';
  const tagline = document.getElementById('headerTagline');
  if (tagline) tagline.textContent = `${firstName}'s personal book collection.`;

  // Load and display favourites
  const favs = await getFavs();
  let changed = false;
  favs.forEach(f => { if (!f._savedAt) { f._savedAt = Date.now(); changed = true; } });
  if (changed) saveFavs(favs);

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeConfirm(); } });
  renderFavs();
}

function renderFavs() {
  const all     = getFavs();
  const toolbar = document.getElementById('toolbar');
  const divider = document.getElementById('sectionDivider');
  const empty   = document.getElementById('emptyState');
  const grid    = document.getElementById('favsGrid');
  updateFavBadge();

  if (!all.length) {
    toolbar.style.display = 'none';
    divider.style.display = 'none';
    empty.classList.add('visible');
    grid.innerHTML = '';
    return;
  }

  empty.classList.remove('visible');
  toolbar.style.display = 'flex';
  divider.style.display = 'block';
  document.getElementById('favCount').textContent   = all.length;
  document.getElementById('favPlural').textContent  = all.length === 1 ? '' : 's';

  const sort   = document.getElementById('sortFavs')?.value || 'recent';
  let sorted   = [...all];
  if (sort === 'oldest')     sorted.reverse();
  else if (sort === 'title_asc')  sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (sort === 'title_desc') sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
  else if (sort === 'year_new')   sorted.sort((a, b) => (b.first_publish_year || 0) - (a.first_publish_year || 0));
  else if (sort === 'year_old')   sorted.sort((a, b) => (a.first_publish_year || 9999) - (b.first_publish_year || 9999));

  grid.innerHTML = '';
  sorted.forEach((book, i) => grid.appendChild(_createFavCard(book, i)));
}

function _createFavCard(book, idx) {
  const card    = document.createElement('div');
  card.className = 'book-card';
  card.style.animationDelay = `${Math.min(idx * 0.04, 0.6)}s`;

  const authors   = book.author_name ? book.author_name.slice(0, 2).join(', ') : 'Unknown Author';
  const year      = book.first_publish_year || '—';
  const subjects  = (book.subject || []).slice(0, 2);
  const savedDate = book._savedAt
    ? new Date(book._savedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  const coverHTML = book.cover_i
    ? `<img class="book-cover" src="https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg" alt="${esc(book.title)}" loading="lazy" onerror="this.outerHTML='<div class=book-cover-placeholder><span class=spine-icon><i data-lucide=book></i></span></div>'">`
    : `<div class="book-cover-placeholder"><span class="spine-icon"><i data-lucide="book"></i></span><span class="spine-title">${esc(book.title)}</span></div>`;

  card.innerHTML = `
    <button class="card-remove-btn" title="Remove" onclick="event.stopPropagation(); removeBook('${esc(book.key || '')}')"><i data-lucide="x"></i></button>
    ${coverHTML}
    ${savedDate ? `<div class="card-saved-date">Saved ${savedDate}</div>` : ''}
    <div class="book-meta">
      <div class="book-title">${esc(book.title)}</div>
      <div class="book-author">${esc(authors)}</div>
      ${subjects.length ? `<div class="book-subjects">${subjects.map(s => `<span class="subject-tag">${esc(s.slice(0, 20))}</span>`).join('')}</div>` : ''}
      <div class="book-year">${year}</div>
    </div>`;

  card.addEventListener('click', () => openFavModal(book));
  return card;
}

async function openFavModal(book) {
  _currentBook   = book;
  const authors  = book.author_name ? book.author_name.join(', ') : 'Unknown Author';
  const year     = book.first_publish_year || 'Unknown';
  const editions = book.edition_count || '—';
  const pages    = book.number_of_pages_median || '—';
  const olKey    = book.key ? `https://openlibrary.org${book.key}` : null;
  const subjects = (book.subject || []).slice(0, 5);

  const coverHTML = book.cover_i
    ? `<img class="modal-cover" src="https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg" alt="${esc(book.title)}" onerror="this.outerHTML='<div class=modal-cover-placeholder><i data-lucide=book></i></div>'">`
    : `<div class="modal-cover-placeholder"><i data-lucide="book"></i></div>`;

  document.getElementById('modalContent').innerHTML = `
    <div class="modal-cover-wrap">${coverHTML}</div>
    <div class="modal-content">
      <div class="modal-eyebrow rose"><i data-lucide="heart"></i> In your collection</div>
      <h2 class="modal-title">${esc(book.title)}</h2>
      <div class="modal-author">by ${esc(authors)}</div>
      <div class="modal-desc-label">About this book</div>
      <div class="modal-desc rose" id="modalDesc"><span class="modal-desc-loading">Fetching description…</span></div>
      <div class="modal-meta-row">
        <div class="modal-meta-item"><span class="label">First Published</span><span class="value">${year}</span></div>
        <div class="modal-meta-item"><span class="label">Editions</span><span class="value">${editions}</span></div>
        <div class="modal-meta-item"><span class="label">Avg Pages</span><span class="value">${pages}</span></div>
      </div>
      ${subjects.length ? `<div class="book-subjects" style="margin-bottom:1rem">${subjects.map(s => `<span class="subject-tag">${esc(s.slice(0, 28))}</span>`).join('')}</div>` : ''}
      <div class="modal-actions">
        ${olKey ? `<a class="modal-link" href="${olKey}" target="_blank" rel="noopener">View on Open Library →</a>` : ''}
        <button class="modal-remove-btn" onclick="removeBook('${esc(book.key || '')}')">✕ Remove</button>
      </div>
    </div>`;

  document.getElementById('modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  fetchAndSetDescription(book.key);
}

function removeBook(key) {
  let favs = getFavs();
  const book = favs.find(f => f.key === key);
  favs = favs.filter(f => f.key !== key);
  saveFavs(favs);
  if (book) showToast(`"${book.title.slice(0, 30)}" removed`);
  renderFavs();
  if (_currentBook && _currentBook.key === key) closeModal();
}

function confirmClearAll() {
  document.getElementById('confirmCount').textContent = getFavs().length;
  document.getElementById('confirmOverlay').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirmOverlay')?.classList.remove('open');
}
function clearAll() {
  saveFavs([]);
  closeConfirm();
  showToast('All favourites cleared');
  renderFavs();
  closeModal();
}

// ── PAGE: AUTH ────────────────────────────────────────────────
function initAuth() {
  // Already logged in → go straight to app
  if (getUser()) { window.location.href = 'index.html'; return; }
  // URL param: ?mode=signin
  if (new URLSearchParams(window.location.search).get('mode') === 'signin') switchTab('signin');
}

function switchTab(tab) {
  const isSignin = tab === 'signin';
  document.getElementById('tabSignin').classList.toggle('active',  isSignin);
  document.getElementById('tabSignup').classList.toggle('active', !isSignin);
  document.getElementById('signinForm').classList.toggle('hidden', !isSignin);
  document.getElementById('signupForm').classList.toggle('hidden',  isSignin);
  document.getElementById('formAlert').classList.remove('visible');
  document.getElementById('formTitle').textContent    = isSignin ? 'Sign in to\nyour library.' : 'Create your\nfree account.';
  document.getElementById('formSubtitle').textContent = isSignin ? 'Your books are waiting for you.' : 'Join millions of readers on Folio.';
  _clearAuthErrors();
}

function _clearAuthErrors() {
  document.querySelectorAll('.field-error').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.field input').forEach(el => el.classList.remove('error'));
}

function _showAuthAlert(msg, type = 'error') {
  const el = document.getElementById('formAlert');
  el.textContent = msg;
  el.className = `form-alert visible ${type}`;
}

function _setFieldError(id, errId, show) {
  document.getElementById(id)?.classList.toggle('error', show);
  document.getElementById(errId)?.classList.toggle('visible', show);
  return show;
}

function togglePw(id, btn) {
  const input = document.getElementById(id);
  const isText = input.type === 'text';
  input.type   = isText ? 'password' : 'text';
  btn.textContent = isText ? '👁' : '🙈';
}

function checkStrength(val) {
  const el    = document.getElementById('pw-strength');
  const fill  = document.getElementById('pw-fill');
  const label = document.getElementById('pw-label');
  if (!val) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  let score = 0;
  if (val.length >= 8) score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const levels = [
    { pct: '25%',  color: '#c0392b', lbl: 'Weak'   },
    { pct: '50%',  color: '#e67e22', lbl: 'Fair'   },
    { pct: '75%',  color: '#f1c40f', lbl: 'Good'   },
    { pct: '100%', color: '#27ae60', lbl: 'Strong' }
  ];
  const l = levels[score - 1] || levels[0];
  fill.style.width      = l.pct;
  fill.style.background = l.color;
  label.textContent     = l.lbl;
  label.style.color     = l.color;
}

function handleSignin(e) {
  e.preventDefault();
  _clearAuthErrors();
  document.getElementById('formAlert').classList.remove('visible');

  const email    = document.getElementById('si-email').value.trim();
  const password = document.getElementById('si-password').value;
  let hasError   = false;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    hasError = _setFieldError('si-email', 'si-email-err', true) || hasError;
  if (!password)
    hasError = _setFieldError('si-password', 'si-password-err', true) || hasError;
  if (hasError) return;

  const btn = document.getElementById('signinBtn');
  btn.disabled = true; btn.textContent = 'Signing in…';

  apiRequest('/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  })
  .then(data => {
    setAuthData(data.token, data.user);
    _showAuthSuccess(data.user.name);
  })
  .catch(err => {
    btn.disabled = false; btn.textContent = 'Sign In →';
    _showAuthAlert(err.message || 'Login failed');
  });
}

function handleSignup(e) {
  e.preventDefault();
  _clearAuthErrors();
  document.getElementById('formAlert').classList.remove('visible');

  const name     = document.getElementById('su-name').value.trim();
  const email    = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-password').value;
  const confirm  = document.getElementById('su-confirm').value;
  const terms    = document.getElementById('su-terms').checked;
  let hasError   = false;

  if (!name)  hasError = _setFieldError('su-name', 'su-name-err', true) || hasError;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    hasError = _setFieldError('su-email', 'su-email-err', true) || hasError;
  if (!password || password.length < 8)
    hasError = _setFieldError('su-password', 'su-password-err', true) || hasError;
  if (password !== confirm)
    hasError = _setFieldError('su-confirm', 'su-confirm-err', true) || hasError;
  if (!terms) { document.getElementById('su-terms-err').classList.add('visible'); hasError = true; }
  if (hasError) return;

  const btn = document.getElementById('signupBtn');
  btn.disabled = true; btn.textContent = 'Creating account…';

  apiRequest('/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password })
  })
  .then(data => {
    setAuthData(data.token, data.user);
    _showAuthSuccess(data.user.name);
  })
  .catch(err => {
    btn.disabled = false; btn.textContent = 'Create Account →';
    _showAuthAlert(err.message || 'Registration failed');
  });
}

function handleGoogle() {
  _showAuthAlert('Google Sign-In is not available in demo mode. Please use email & password.');
}

function _showAuthSuccess(name) {
  document.getElementById('signinForm').classList.add('hidden');
  document.getElementById('signupForm').classList.add('hidden');
  document.getElementById('formAlert').classList.remove('visible');
  document.getElementById('successOverlay').classList.add('visible');
  document.getElementById('successTitle').textContent = `Welcome, ${name.split(' ')[0]}!`;
  setTimeout(() => { window.location.href = 'index.html'; }, 2000);
}

// ── PAGE: LANDING ─────────────────────────────────────────────
function initLanding() {
  const navbar = document.getElementById('navbar');
  window.addEventListener('scroll', () => {
    navbar?.classList.toggle('scrolled', window.scrollY > 20);
  });

  const reveals = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => entry.target.classList.add('visible'), i * 80);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  reveals.forEach(el => observer.observe(el));
}

// ── ROUTER ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if      (page === 'index')    initIndex();
  else if (page === 'favorite') initFavorite();
  else if (page === 'auth')     initAuth();
  else if (page === 'landing')  initLanding();
});