/**
 * script.js — Calendar task tracker (ES module)
 *
 * localStorage keys: tasks-YYYY-MM-DD
 * Each task: { id, text, done, updatedAt }
 *
 * Sync hooks are injected via schedulePush() from sync.js.
 * Auth state is managed via onAuthChange() from auth.js.
 */

import { firebaseReady }          from './firebase.js';
import { signIn, signUp, signOut, onAuthChange } from './auth.js';
import { initSync, schedulePush, mergeAndPull, setSyncStatus } from './sync.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'tasks-';
const THEME_KEY      = 'theme';
const USERNAME_KEY   = 'username';

const QUOTES = [
  'Ship small, ship often.',
  'One task at a time beats a perfect plan.',
  'Done is better than perfect.',
  'Focus is saying no to a thousand things.',
  'Small progress is still progress.',
  'Your future self will thank you for today\'s checkbox.',
  'Clarity comes from doing, not overthinking.',
  'Consistency beats intensity.',
  'Start where you are. Use what you have.',
  'The calendar does not judge — it only remembers.',
];

const SHORT_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ─── Task helpers ─────────────────────────────────────────────────────────────

/** @typedef {{ id: string, text: string, done: boolean, updatedAt: number }} Task */

function dateKey(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseKey(keyStr) {
  const [y, m, d] = keyStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** @param {string} key @returns {Task[]} */
function loadTasksForKey(key) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map((t) => ({
      id:        String(t.id),
      text:      String(t.text ?? ''),
      done:      Boolean(t.done),
      updatedAt: Number(t.updatedAt ?? 0),   // <-- updatedAt carried through
    }));
  } catch {
    return [];
  }
}

/** @param {string} key @param {Task[]} tasks */
function saveTasksForKey(key, tasks) {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(tasks));
}

function countCompletedForKey(key) {
  return loadTasksForKey(key).filter((t) => t.done).length;
}

function allTaskKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(STORAGE_PREFIX) && /^tasks-\d{4}-\d{2}-\d{2}$/.test(k)) {
      keys.push(k.slice(STORAGE_PREFIX.length));
    }
  }
  return keys;
}

// ─── Date / week helpers ──────────────────────────────────────────────────────

function startOfWeekMonday(d) {
  const x   = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfWeekSunday(d) {
  const start = startOfWeekMonday(d);
  const end   = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function currentWeekKeys() {
  const start = startOfWeekMonday(new Date());
  const keys  = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    keys.push(dateKey(d));
  }
  return keys;
}

function isDateInRange(keyStr, start, end) {
  const t = parseKey(keyStr).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function last7DayKeys() {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push(dateKey(d));
  }
  return out;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

function computeStreak() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let streak = 0;
  for (;;) {
    if (countCompletedForKey(dateKey(d)) >= 1) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return streak;
}

function globalCompletionPct() {
  const keys = allTaskKeys();
  let total = 0, done = 0;
  for (const key of keys) {
    const tasks = loadTasksForKey(key);
    total += tasks.length;
    done  += tasks.filter((t) => t.done).length;
  }
  if (total === 0) return 0;
  return Math.round((done / total) * 1000) / 10;
}

function streakWeight(streak) { return Math.min(streak * 2, 40); }
function executionScore(pct, streak) {
  return Math.min(100, Math.round((pct + streakWeight(streak)) * 10) / 10);
}

function computeAnalytics() {
  const today    = new Date();
  const todayKey = dateKey(today);
  const weekStart = startOfWeekMonday(today);
  const weekEnd   = endOfWeekSunday(today);
  const weekKeys  = currentWeekKeys();

  let completedToday = 0, completedWeek = 0, totalWeek = 0;

  for (const key of allTaskKeys()) {
    const tasks        = loadTasksForKey(key);
    const dayCompleted = tasks.filter((t) => t.done).length;
    if (key === todayKey) completedToday = dayCompleted;
    if (isDateInRange(key, weekStart, weekEnd)) {
      completedWeek += dayCompleted;
      totalWeek     += tasks.length;
    }
  }

  const completionPct = globalCompletionPct();
  const streak        = computeStreak();
  const exec          = executionScore(completionPct, streak);

  const weekStats = weekKeys.map((k) => ({
    key:       k,
    completed: countCompletedForKey(k),
    label:     SHORT_DAY[parseKey(k).getDay()],
  }));

  const maxC = Math.max(...weekStats.map((w) => w.completed), 0);
  const minC = Math.min(...weekStats.map((w) => w.completed));
  let bestLabel = '—', worstLabel = '—';
  if (completedWeek > 0) {
    bestLabel  = weekStats.filter((w) => w.completed === maxC).map((b) => b.label).join(', ');
    worstLabel = weekStats.filter((w) => w.completed === minC).map((b) => b.label).join(', ');
  }

  return {
    completedToday, completedWeek, totalWeek,
    completionPct, streak, executionScore: exec,
    weeklyTotalCompleted: completedWeek, bestDay: bestLabel, worstDay: worstLabel,
  };
}

function dayCompletionPct(key) {
  const tasks = loadTasksForKey(key);
  if (!tasks.length) return 0;
  return Math.round((tasks.filter((t) => t.done).length / tasks.length) * 1000) / 10;
}

// ─── Graphs ───────────────────────────────────────────────────────────────────

function buildTrendMarkup(pcts, keys) {
  const cols = pcts.map((p, i) => {
    const left = (i / 7) * 100, w = 100 / 7;
    return `<div class="trend__colbg" style="left:${left}%;width:${w}%"><div class="trend__fill" style="height:${p}%"></div></div>`;
  }).join('');

  const segs = [];
  for (let i = 0; i < 6; i++) {
    segs.push(`<div class="trend__horiz" style="left:${(i / 7) * 100}%;width:${100 / 7}%;bottom:${pcts[i]}%"></div>`);
    const lo = Math.min(pcts[i], pcts[i + 1]);
    const h  = Math.abs(pcts[i + 1] - pcts[i]);
    segs.push(`<div class="trend__vert" style="left:calc(${((i + 1) / 7) * 100}% - 1px);bottom:${lo}%;height:${h}%"></div>`);
  }

  const labels = keys.map((k) => {
    const d = parseKey(k);
    return `<span>${d.getMonth() + 1}/${d.getDate()}</span>`;
  }).join('');

  return `<div class="trend-wrap"><div class="trend__plot">${cols}${segs.join('')}</div><div class="trend__labels">${labels}</div></div>`;
}

function renderGraphs() {
  if (!el.graphWeekly || !el.graphTrend) return;
  const weekKeys = currentWeekKeys();
  const counts   = weekKeys.map((k) => countCompletedForKey(k));
  const max      = Math.max(...counts, 1);
  const wlabels  = weekKeys.map((k) => SHORT_DAY[parseKey(k).getDay()]);

  el.graphWeekly.innerHTML = `<div class="bar-chart">${counts.map((c, i) => {
    const h = Math.round((c / max) * 100);
    return `<div class="bar-chart__col"><div class="bar-chart__bar" style="height:${h}%"></div><span class="bar-chart__label">${wlabels[i]}</span></div>`;
  }).join('')}</div>`;

  const last7 = last7DayKeys();
  el.graphTrend.innerHTML = buildTrendMarkup(last7.map((k) => dayCompletionPct(k)), last7);
}

// ─── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const t = ['cyan', 'green', 'amber', 'ice'].includes(theme) ? theme : 'cyan';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  if (el.themeSelect) el.themeSelect.value = t;
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'cyan');
  if (el.themeSelect) el.themeSelect.addEventListener('change', () => applyTheme(el.themeSelect.value));
}

// ─── Username ─────────────────────────────────────────────────────────────────

function displayUsername() {
  if (!el.usernameDisplay) return;
  el.usernameDisplay.textContent = localStorage.getItem(USERNAME_KEY) || 'operator';
}

function initUsername() {
  if (!el.usernameDisplay) return;
  const existing = localStorage.getItem(USERNAME_KEY);
  if (!existing || !String(existing).trim()) {
    const entered = prompt('Enter your name:', '') || '';
    localStorage.setItem(USERNAME_KEY, entered.trim() || 'operator');
  }
  displayUsername();
  el.usernameDisplay.addEventListener('click', () => {
    const cur  = localStorage.getItem(USERNAME_KEY) || '';
    const next = prompt('Username:', cur);
    if (next !== null && String(next).trim() !== '') {
      localStorage.setItem(USERNAME_KEY, String(next).trim());
      displayUsername();
    }
  });
}

// ─── UI state ─────────────────────────────────────────────────────────────────

let viewYear  = new Date().getFullYear();
let viewMonth = new Date().getMonth();
/** @type {string | null} */
let selectedKey = dateKey(new Date());
/** @type {string | null} */
let selectedTaskId = null;
let focusMode = false;
/** @type {string | null} */
let selectedKeyBeforeFocus = null;

function effectiveTaskKey() {
  return focusMode ? dateKey(new Date()) : selectedKey;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// ─── Element refs ─────────────────────────────────────────────────────────────

const el = {
  // Existing
  clock:            document.getElementById('clock'),
  monthLabel:       document.getElementById('month-label'),
  weekdays:         document.getElementById('weekdays'),
  grid:             document.getElementById('calendar-grid'),
  prevMonth:        document.getElementById('prev-month'),
  nextMonth:        document.getElementById('next-month'),
  statToday:        document.getElementById('stat-today'),
  statWeek:         document.getElementById('stat-week'),
  statPct:          document.getElementById('stat-pct'),
  statStreak:       document.getElementById('stat-streak'),
  statExec:         document.getElementById('stat-exec'),
  statWeekTotal:    document.getElementById('stat-week-total'),
  statBestDay:      document.getElementById('stat-best-day'),
  statWorstDay:     document.getElementById('stat-worst-day'),
  quoteText:        document.getElementById('quote-text'),
  selectedDateLabel:document.getElementById('selected-date-label'),
  taskForm:         document.getElementById('task-form'),
  taskInput:        document.getElementById('task-input'),
  taskList:         document.getElementById('task-list'),
  taskEmpty:        document.getElementById('task-empty'),
  graphWeekly:      document.getElementById('graph-weekly-bars'),
  graphTrend:       document.getElementById('graph-trend'),
  themeSelect:      document.getElementById('theme-select'),
  usernameDisplay:  document.getElementById('username-display'),
  // Auth / sync (new)
  syncStatus:       document.getElementById('sync-status'),
  authOverlay:      document.getElementById('auth-overlay'),
  authEmail:        document.getElementById('auth-email'),
  authPassword:     document.getElementById('auth-password'),
  authError:        document.getElementById('auth-error'),
  authLoginBtn:     document.getElementById('auth-login-btn'),
  authSignupBtn:    document.getElementById('auth-signup-btn'),
  authSkipBtn:      document.getElementById('auth-skip-btn'),
  authBar:          document.getElementById('auth-bar'),
  authBarEmail:     document.getElementById('auth-bar-email'),
  authLogoutBtn:    document.getElementById('auth-logout-btn'),
  authSignInBtn:    document.getElementById('auth-signin-btn'),
};

// ─── Renders ──────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function tickClock() {
  const now = new Date();
  let h = now.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  el.clock.textContent = `${pad2(h)}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())} ${ampm}`;
}

function monthLabel() {
  return new Date(viewYear, viewMonth, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function renderWeekdays() {
  el.weekdays.innerHTML = ['mon','tue','wed','thu','fri','sat','sun']
    .map((l) => `<div class="weekday">${l}</div>`).join('');
}

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function firstWeekdayMondayIndex(y, m) {
  const dow = new Date(y, m, 1).getDay();
  return dow === 0 ? 6 : dow - 1;
}

function maxCompletedInMonth(y, m) {
  const dim = daysInMonth(y, m);
  let max = 0;
  for (let day = 1; day <= dim; day++) {
    const c = countCompletedForKey(dateKey(new Date(y, m, day)));
    if (c > max) max = c;
  }
  return max;
}

function heatOpacity(completed, maxInMonth) {
  if (completed <= 0 || maxInMonth <= 0) return 0;
  return Math.min(0.52, 0.06 + (completed / maxInMonth) * 0.46);
}

function renderCalendar() {
  el.monthLabel.textContent = monthLabel();
  const firstPad = firstWeekdayMondayIndex(viewYear, viewMonth);
  const dim      = daysInMonth(viewYear, viewMonth);
  const todayKey = dateKey(new Date());
  const maxHeat  = maxCompletedInMonth(viewYear, viewMonth);
  const cells    = [];

  for (let i = 0; i < firstPad; i++) {
    cells.push('<div class="calendar-cell calendar-cell--empty"></div>');
  }
  for (let day = 1; day <= dim; day++) {
    const key       = dateKey(new Date(viewYear, viewMonth, day));
    const isToday   = key === todayKey;
    const isSel     = key === selectedKey;
    const completed = countCompletedForKey(key);
    const heat      = heatOpacity(completed, maxHeat);
    const classes   = ['calendar-cell', isToday && 'calendar-cell--today', isSel && 'calendar-cell--selected'].filter(Boolean);
    cells.push(
      `<button type="button" class="${classes.join(' ')}" data-date="${key}" style="--heat:${heat};" aria-pressed="${isSel}" aria-label="${key}, ${completed} done">${day}</button>`
    );
  }

  el.grid.innerHTML = cells.join('');
  el.grid.querySelectorAll('.calendar-cell[data-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedKey    = btn.getAttribute('data-date');
      selectedTaskId = null;
      renderCalendar();
      renderTaskPanel();
    });
  });
}

function renderAnalytics() {
  const a = computeAnalytics();
  el.statToday.textContent    = String(a.completedToday);
  el.statWeek.textContent     = String(a.weeklyTotalCompleted);
  el.statPct.textContent      = `${a.completionPct}%`;
  el.statStreak.textContent   = String(a.streak);
  el.statExec.textContent     = `${a.executionScore}%`;
  el.statWeekTotal.textContent= String(a.weeklyTotalCompleted);
  el.statBestDay.textContent  = a.bestDay;
  el.statWorstDay.textContent = a.worstDay;
  renderGraphs();
}

function randomQuote() {
  el.quoteText.textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function setFocusMode(on) {
  if (on === focusMode) return;
  if (on) {
    selectedKeyBeforeFocus = selectedKey;
    focusMode  = true;
    selectedKey = dateKey(new Date());
    selectedTaskId = null;
  } else {
    focusMode = false;
    if (selectedKeyBeforeFocus) selectedKey = selectedKeyBeforeFocus;
    selectedKeyBeforeFocus = null;
  }
  document.body.classList.toggle('focus-mode', focusMode);
  renderCalendar();
  renderTaskPanel();
}

function shiftSelectedDate(deltaDays) {
  if (focusMode) return;
  const base = parseKey(selectedKey || dateKey(new Date()));
  base.setDate(base.getDate() + deltaDays);
  selectedKey    = dateKey(base);
  selectedTaskId = null;
  viewYear       = base.getFullYear();
  viewMonth      = base.getMonth();
  renderCalendar();
  renderTaskPanel();
}

function renderTaskPanel() {
  const key = effectiveTaskKey();
  if (!key) {
    el.selectedDateLabel.textContent = '';
    el.taskList.innerHTML = '';
    el.taskEmpty.hidden = false;
    return;
  }

  el.selectedDateLabel.textContent = focusMode ? `[${key}] focus` : `[${key}]`;
  const tasks = loadTasksForKey(key);
  el.taskList.innerHTML = '';

  if (tasks.length === 0) {
    selectedTaskId = null;
    el.taskEmpty.hidden = false;
  } else {
    el.taskEmpty.hidden = true;
    if (selectedTaskId && !tasks.some((t) => t.id === selectedTaskId)) selectedTaskId = null;

    tasks.forEach((task) => {
      const li  = document.createElement('li');
      li.className = 'task-item' + (task.done ? ' task-item--done' : '');
      if (task.id === selectedTaskId) li.classList.add('task-item--selected');
      li.dataset.id = task.id;
      li.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        selectedTaskId = task.id;
        renderTaskPanel();
      });

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = task.done;
      cb.setAttribute('aria-label', 'Complete task');

      const labelEl = document.createElement('span');
      labelEl.className   = 'task-item__label';
      labelEl.textContent = task.text;

      const del = document.createElement('button');
      del.type      = 'button';
      del.className = 'task-item__del';
      del.textContent = 'del';

      cb.addEventListener('change', () => toggleTask(key, task.id, cb.checked));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(key, task.id); });

      li.append(cb, labelEl, del);
      el.taskList.appendChild(li);
    });
  }
}

/** Convenience: re-render everything (called by sync after merge) */
function renderAll() {
  renderCalendar();
  renderAnalytics();
  renderTaskPanel();
}

// ─── Task mutations (localStorage first, then async cloud) ───────────────────

function toggleTask(key, id, done) {
  const tasks = loadTasksForKey(key);
  const t     = tasks.find((x) => x.id === id);
  if (t) { t.done = done; t.updatedAt = Date.now(); }   // <-- update timestamp
  saveTasksForKey(key, tasks);
  schedulePush(key);                                      // <-- async cloud sync
  renderAnalytics();
  renderCalendar();
  renderTaskPanel();
}

function deleteTask(key, id) {
  const tasks = loadTasksForKey(key).filter((x) => x.id !== id);
  saveTasksForKey(key, tasks);
  if (selectedTaskId === id) selectedTaskId = null;
  schedulePush(key);                                      // <-- async cloud sync
  renderAnalytics();
  renderCalendar();
  renderTaskPanel();
}

function addTask(key, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const tasks = loadTasksForKey(key);
  tasks.push({
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    text:      trimmed,
    done:      false,
    updatedAt: Date.now(),                                // <-- timestamp on creation
  });
  saveTasksForKey(key, tasks);
  schedulePush(key);                                      // <-- async cloud sync
  renderAnalytics();
  renderCalendar();
  renderTaskPanel();
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

function onGlobalKeydown(e) {
  const t = e.target;
  if ((e.key === 'f' || e.key === 'F') && !isTypingTarget(t)) {
    e.preventDefault();
    setFocusMode(!focusMode);
    return;
  }
  if (e.key === 'ArrowLeft'  && !isTypingTarget(t) && !focusMode) { e.preventDefault(); shiftSelectedDate(-1); return; }
  if (e.key === 'ArrowRight' && !isTypingTarget(t) && !focusMode) { e.preventDefault(); shiftSelectedDate(1);  return; }
  if (e.key === 'Delete' && !isTypingTarget(t)) {
    const k = effectiveTaskKey();
    if (k && selectedTaskId) { e.preventDefault(); deleteTask(k, selectedTaskId); }
  }
}

// ─── Auth UI ──────────────────────────────────────────────────────────────────

function showAuthOverlay() {
  if (el.authOverlay) el.authOverlay.hidden = false;
}

function hideAuthOverlay() {
  if (el.authOverlay) el.authOverlay.hidden = true;
}

function showAuthBar(email) {
  if (el.authBar)      { el.authBar.hidden = false; }
  if (el.authBarEmail) { el.authBarEmail.textContent = email; }
  if (el.authSignInBtn){ el.authSignInBtn.hidden = true; }
}

function hideAuthBar() {
  if (el.authBar)      el.authBar.hidden = true;
  // Show "login" button in toolbar only when Firebase is configured
  if (el.authSignInBtn) el.authSignInBtn.hidden = !firebaseReady;
}

function setAuthError(msg) {
  if (!el.authError) return;
  el.authError.textContent = msg;
  el.authError.hidden = !msg;
}

async function handleAuthAction(action) {
  const email = el.authEmail?.value?.trim() ?? '';
  const pass  = el.authPassword?.value ?? '';
  if (!email || !pass) { setAuthError('enter email and password'); return; }

  setAuthError('');
  if (el.authLoginBtn)  el.authLoginBtn.disabled  = true;
  if (el.authSignupBtn) el.authSignupBtn.disabled = true;

  const result = action === 'login'
    ? await signIn(email, pass)
    : await signUp(email, pass);

  if (el.authLoginBtn)  el.authLoginBtn.disabled  = false;
  if (el.authSignupBtn) el.authSignupBtn.disabled = false;

  if (result.error) {
    setAuthError(`> ${result.error}`);
  }
  // On success, onAuthChange will fire and handle UI transition
}

function initAuthUI() {
  // If firebase is not configured, keep everything hidden and set local mode
  if (!firebaseReady) {
    hideAuthOverlay();
    hideAuthBar();
    setSyncStatus('local');
    return; // no auth listeners needed
  }

  // Form submit (Enter key or submit button click)
  const authForm = document.getElementById('auth-form-wrap');
  authForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAuthAction('login');
  });

  el.authLoginBtn?.addEventListener('click',  (e) => { e.preventDefault(); handleAuthAction('login'); });
  el.authSignupBtn?.addEventListener('click', () => handleAuthAction('signup'));
  el.authSkipBtn?.addEventListener('click',   () => {
    hideAuthOverlay();
    setSyncStatus('local');
  });
  el.authLogoutBtn?.addEventListener('click', async () => {
    await signOut();
    setSyncStatus('local');
  });
  // "login" button in toolbar re-opens overlay
  el.authSignInBtn?.addEventListener('click', () => {
    setAuthError('');
    showAuthOverlay();
  });

  // Subscribe to auth state changes (only when firebase IS configured)
  onAuthChange((user) => {
    if (user) {
      hideAuthOverlay();
      showAuthBar(user.email);
      // Merge cloud + local data in background; re-render when done
      mergeAndPull(user.uid, renderAll);
    } else {
      hideAuthBar();
      showAuthOverlay(); // firebase ready but no user → prompt to sign in
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  initTheme();
  initUsername();
  randomQuote();
  renderWeekdays();
  tickClock();
  setInterval(tickClock, 1000);

  el.prevMonth.addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  });
  el.nextMonth.addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  });
  el.taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const k = effectiveTaskKey();
    if (!k) return;
    addTask(k, el.taskInput.value);
    el.taskInput.value = '';
  });

  document.addEventListener('keydown', onGlobalKeydown);

  // Sync & auth
  initSync();
  initAuthUI();

  // Initial render
  renderCalendar();
  renderAnalytics();
  renderTaskPanel();
}

init();
