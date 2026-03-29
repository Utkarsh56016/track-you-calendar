/**
 * firebase.js — Firebase SDK initialization
 *
 * ⚙️  SETUP: Replace the placeholder values below with your Firebase config.
 *     Firebase Console → Project Settings → Your Apps → Web App → Config
 *
 * If left unconfigured, the app runs in full local-only mode (no sync).
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// ─── Replace these with your project values ────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAOReUbHwY86YQQcRuYluO4yVHtlrsCayQ",
  authDomain: "track-you-calendar.firebaseapp.com",
  projectId: "track-you-calendar",
  storageBucket: "track-you-calendar.firebasestorage.app",
  messagingSenderId: "693885133232",
  appId: "1:693885133232:web:7ab4ef114ce384f196f675"
};
// ───────────────────────────────────────────────────────────────────────────

const CONFIG_FILLED = FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";

let _auth = null;
let _db = null;

if (CONFIG_FILLED) {
  try {
    const app = initializeApp(FIREBASE_CONFIG);
    _auth = getAuth(app);
    _db = getFirestore(app);
  } catch (err) {
    console.warn('[firebase] Init failed — local-only mode:', err.message);
  }
} else {
  console.info('[firebase] No config detected — running in local-only mode.');
}

/** Firebase Auth instance, or null if not configured. */
export const auth = _auth;

/** Firestore instance, or null if not configured. */
export const db = _db;

/** True only when Firebase is properly configured and initialized. */
export const firebaseReady = CONFIG_FILLED && _auth !== null && _db !== null;
