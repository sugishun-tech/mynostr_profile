import { CONFIG } from './config.js';

export function formatJST(unixTimestamp) {
  const d = new Date(unixTimestamp * 1000);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  return formatter.format(d).replace(/\//g, '-');
}

export function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert("コピーしました: " + text);
  }).catch(err => {
    console.error('Failed to copy: ', err);
  });
}

export function escapeHtml(unsafe) {
  return (unsafe || "").toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function normalizeRelayUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  if (!/^wss?:\/\//i.test(trimmed)) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function parseRelayText(text) {
  const relays = (text || "")
    .split(/\r?\n/)
    .map(normalizeRelayUrl)
    .filter(Boolean);
  return [...new Set(relays)];
}

export function getConfiguredRelays() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.RELAYS_STORAGE_KEY) || "[]");
    if (Array.isArray(saved) && saved.length > 0) return saved;
  } catch (e) {
    console.warn("relay settings parse failed", e);
  }
  return CONFIG.DEFAULT_RELAYS;
}

export function saveConfiguredRelays(relays) {
  const clean = [...new Set((relays || []).map(normalizeRelayUrl).filter(Boolean))];
  if (clean.length === 0) {
    localStorage.removeItem(CONFIG.RELAYS_STORAGE_KEY);
    return CONFIG.DEFAULT_RELAYS;
  }
  localStorage.setItem(CONFIG.RELAYS_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function resetConfiguredRelays() {
  localStorage.removeItem(CONFIG.RELAYS_STORAGE_KEY);
  return CONFIG.DEFAULT_RELAYS;
}
