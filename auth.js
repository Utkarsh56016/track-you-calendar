/**
 * auth.js — Firebase email/password authentication
 *
 * All functions degrade gracefully when Firebase is not configured.
 * Clean error messages mapped from Firebase error codes.
 */

import { auth, firebaseReady } from './firebase.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

/** @type {import('firebase/auth').User | null} */
let _currentUser = null;

/** Return the currently signed-in Firebase user, or null. */
export function getUser() {
  return _currentUser;
}

/**
 * Sign in with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ user: object } | { error: string }>}
 */
export async function signIn(email, password) {
  if (!firebaseReady) return { error: 'firebase not configured' };
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    return { user: cred.user };
  } catch (err) {
    return { error: friendlyError(err.code) };
  }
}

/**
 * Create a new account with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ user: object } | { error: string }>}
 */
export async function signUp(email, password) {
  if (!firebaseReady) return { error: 'firebase not configured' };
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    return { user: cred.user };
  } catch (err) {
    return { error: friendlyError(err.code) };
  }
}

/** Sign out the current user. */
export async function signOut() {
  if (!firebaseReady || !auth) return;
  try {
    await fbSignOut(auth);
  } catch (err) {
    console.warn('[auth] signOut error:', err.message);
  }
}

/**
 * Subscribe to auth state changes.
 * Immediately calls callback with current user (or null).
 * @param {(user: object | null) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(callback) {
  if (!firebaseReady || !auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => {
    _currentUser = user;
    callback(user);
  });
}

// Map Firebase error codes → terminal-friendly messages
function friendlyError(code) {
  const MAP = {
    'auth/invalid-credential':     'invalid email or password',
    'auth/invalid-email':          'invalid email format',
    'auth/user-not-found':         'no account with that email',
    'auth/wrong-password':         'incorrect password',
    'auth/email-already-in-use':   'email already registered',
    'auth/weak-password':          'password must be 6+ characters',
    'auth/too-many-requests':      'too many attempts — try later',
    'auth/network-request-failed': 'network error — check connection',
  };
  return MAP[code] ?? `auth error: ${code}`;
}
