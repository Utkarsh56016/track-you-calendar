/**
 * sync.js — Hybrid sync: localStorage (primary) ↔ Firestore (secondary)
 *
 * Rules:
 *  • localStorage is ALWAYS updated first — UI never waits on the network
 *  • Firestore writes are debounced 1.5 s to batch rapid changes
 *  • Merge conflict: task with higher updatedAt wins; tie → cloud wins
 *  • Offline: writes queued locally, flushed automatically when back online
 *  • Only changed data is written to Firestore (fingerprint comparison)
 */

import { db, firebaseReady } from './firebase.js';
import { getUser } from './auth.js';
import {
  doc,
  setDoc,
  getDocs,
  collection,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// ─── Types ──────────────────────────────────────────────────────────────────
/** @typedef {{ id: string, text: string, done: boolean, updatedAt: number }} Task */

// ─── Sync status indicator ──────────────────────────────────────────────────

const STATUS_LABELS = {
  local:   '● local mode',
  syncing: '↻ syncing...',
  synced:  '✓ synced',
  offline: '⚡ offline',
  error:   '✗ sync error',
};

/** @param {'local'|'syncing'|'synced'|'offline'|'error'} status */
export function setSyncStatus(status) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = STATUS_LABELS[status] ?? status;
  el.dataset.status = status;
}

// ─── localStorage helpers ────────────────────────────────────────────────────

const STORAGE_PREFIX = 'tasks-';
const DATE_KEY_RE    = /^tasks-\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} t @returns {Task} */
function normalizeTask(t) {
  return {
    id:        String(t.id ?? ''),
    text:      String(t.text ?? ''),
    done:      Boolean(t.done),
    updatedAt: Number(t.updatedAt ?? 0),
  };
}

/** @param {string} dateKey @returns {Task[]} */
function localLoad(dateKey) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + dateKey);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normalizeTask) : [];
  } catch {
    return [];
  }
}

/** @param {string} dateKey @param {Task[]} tasks */
function localSave(dateKey, tasks) {
  localStorage.setItem(STORAGE_PREFIX + dateKey, JSON.stringify(tasks));
}

/** @returns {string[]} all YYYY-MM-DD keys stored in localStorage */
function allLocalKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && DATE_KEY_RE.test(k)) keys.push(k.slice(STORAGE_PREFIX.length));
  }
  return keys;
}

// ─── Merge (updatedAt wins) ──────────────────────────────────────────────────

/**
 * Merge two task arrays. Higher updatedAt wins; on tie, cloud wins.
 * Tasks present only on one side are included unchanged.
 * @param {Task[]} local
 * @param {Task[]} cloud
 * @returns {Task[]}
 */
export function mergeTasks(local, cloud) {
  /** @type {Map<string, Task>} */
  const m = new Map();
  for (const t of local)  m.set(t.id, t);
  for (const t of cloud) {
    const existing = m.get(t.id);
    // Tie (===) → cloud wins (it had the last write timestamp)
    if (!existing || t.updatedAt >= existing.updatedAt) m.set(t.id, t);
  }
  return [...m.values()];
}

/** Order-independent fingerprint for change detection */
function fingerprint(tasks) {
  return tasks.map((t) => `${t.id}:${t.done}:${t.updatedAt}`).sort().join('|');
}

// ─── Firestore helpers ────────────────────────────────────────────────────────

function dateRef(uid, dateKey) {
  return doc(db, 'users', uid, 'tasks', dateKey);
}
function tasksColRef(uid) {
  return collection(db, 'users', uid, 'tasks');
}

/** @param {string} uid @param {string} dateKey @param {Task[]} tasks */
async function cloudWrite(uid, dateKey, tasks) {
  await setDoc(dateRef(uid, dateKey), { tasks, updatedAt: serverTimestamp() });
}

// cloudRead removed — full collection fetch via getDocs is used in mergeAndPull

// ─── Offline pending queue ────────────────────────────────────────────────────

/** @type {Set<string>} date keys awaiting a network write */
const pendingQueue = new Set();

async function flushQueue() {
  const user = getUser();
  if (!user || !navigator.onLine) return;
  for (const dk of [...pendingQueue]) {
    try {
      await cloudWrite(user.uid, dk, localLoad(dk));
      pendingQueue.delete(dk);
    } catch (err) {
      console.warn('[sync] queue flush error:', dk, err.message);
    }
  }
  if (pendingQueue.size === 0) setSyncStatus('synced');
}

// ─── Debounced per-key push ───────────────────────────────────────────────────

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const pushTimers = new Map();
const DEBOUNCE_MS = 1500;

/**
 * Schedule a debounced Firestore write for dateKey.
 * Called after every local task mutation. NEVER blocks the UI.
 * @param {string} dateKey  e.g. "2025-03-29"
 */
export function schedulePush(dateKey) {
  const user = getUser();
  if (!user || !firebaseReady) return; // not logged in → skip silently

  const existing = pushTimers.get(dateKey);
  if (existing != null) clearTimeout(existing);

  setSyncStatus('syncing');

  pushTimers.set(dateKey, setTimeout(async () => {
    pushTimers.delete(dateKey);

    if (!navigator.onLine) {
      pendingQueue.add(dateKey);
      setSyncStatus('offline');
      return;
    }

    try {
      await cloudWrite(user.uid, dateKey, localLoad(dateKey));
      setSyncStatus('synced');
    } catch (err) {
      console.warn('[sync] push error:', dateKey, err.message);
      pendingQueue.add(dateKey);
      setSyncStatus('error');
    }
  }, DEBOUNCE_MS));
}

// ─── Full merge on login ──────────────────────────────────────────────────────

/**
 * Fetch all cloud documents, merge with localStorage using updatedAt,
 * write back only what changed. Called once on login.
 * @param {string} uid
 * @param {() => void} [onComplete]  callback to trigger a UI re-render
 */
export async function mergeAndPull(uid, onComplete) {
  if (!firebaseReady || !db) return;
  setSyncStatus('syncing');

  try {
    // 1. Fetch all cloud date docs in one round-trip
    const snapshot = await getDocs(tasksColRef(uid));
    /** @type {Map<string, Task[]>} */
    const cloudMap = new Map();
    snapshot.forEach((d) => {
      const raw = d.data();
      cloudMap.set(d.id, Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask) : []);
    });

    // 2. Union of all date keys from both sides
    const allKeys = new Set([...allLocalKeys(), ...cloudMap.keys()]);

    // 3. Per-date merge — only write where something changed
    const cloudWrites = [];
    for (const dk of allKeys) {
      const local  = localLoad(dk);
      const cloud  = cloudMap.get(dk) ?? [];
      const merged = mergeTasks(local, cloud);

      const localFp  = fingerprint(local);
      const cloudFp  = fingerprint(cloud);
      const mergedFp = fingerprint(merged);

      if (mergedFp !== localFp)  localSave(dk, merged);      // update localStorage
      if (mergedFp !== cloudFp)  cloudWrites.push(cloudWrite(uid, dk, merged)); // push to cloud
    }

    await Promise.allSettled(cloudWrites);
    setSyncStatus('synced');

    onComplete?.(); // signal main script to re-render with merged data

  } catch (err) {
    console.warn('[sync] mergeAndPull error:', err.message);
    setSyncStatus('error');
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

/** Wire up online/offline listeners. Call once at app startup. */
export function initSync() {
  if (!firebaseReady) {
    setSyncStatus('local');
    return;
  }
  window.addEventListener('online',  () => flushQueue());
  window.addEventListener('offline', () => setSyncStatus('offline'));
  if (!navigator.onLine) setSyncStatus('offline');
}
