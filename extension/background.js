const Status = { IDLE:'idle', GENERATING:'generating', READY:'ready', VIEWED:'viewed' };

// по вкладкам: { status, ts }
const tabs = new Map();
let blinkTimer = null;
const heartbeatConfigs = new Map(); // tabId -> { intervalMs, staleMs }
const DEFAULT_STALE_MS = 20000;
const HEARTBEAT_GRACE_FACTOR = 3;
const MIN_HEARTBEAT_INTERVAL_MS = 6000;
const WATCHDOG_ALARM = 'heartbeat-watchdog';

const heartbeatAlarmName = (tabId) => `heartbeat:${tabId}`;

function normalizeInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return MIN_HEARTBEAT_INTERVAL_MS;
  return Math.max(ms, MIN_HEARTBEAT_INTERVAL_MS);
}

function scheduleHeartbeatAlarm(tabId, intervalMs) {
  const normalized = normalizeInterval(intervalMs);
  const periodInMinutes = Math.max(normalized / 60000, 0.1);
  const name = heartbeatAlarmName(tabId);
  chrome.alarms.create(name, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
  heartbeatConfigs.set(tabId, {
    intervalMs: normalized,
    staleMs: Math.max(normalized * HEARTBEAT_GRACE_FACTOR, DEFAULT_STALE_MS),
  });
}

function clearHeartbeat(tabId) {
  const name = heartbeatAlarmName(tabId);
  heartbeatConfigs.delete(tabId);
  chrome.alarms.clear(name, () => { void chrome.runtime.lastError; });
}

function getStaleMs(tabId) {
  return heartbeatConfigs.get(tabId)?.staleMs ?? DEFAULT_STALE_MS;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.1 });
});

chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.1 });

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (msg.type === 'status') {
    tabs.set(tabId, { status: msg.status, ts: Date.now() });
    if (msg.status === Status.GENERATING) {
      // оставляем расписание heartbeats за контент-скриптом
    } else {
      clearHeartbeat(tabId);
    }
  } else if (msg.type === 'heartbeat') {
    const cur = tabs.get(tabId);
    if (cur?.status === Status.GENERATING) {
      cur.ts = Date.now();
      tabs.set(tabId, cur);
    } else {
      tabs.set(tabId, { status: Status.GENERATING, ts: Date.now() });
    }
  } else if (msg.type === 'heartbeat-control') {
    if (msg.action === 'stop') {
      clearHeartbeat(tabId);
    } else if (msg.action === 'start' || msg.action === 'update') {
      scheduleHeartbeatAlarm(tabId, msg.intervalMs);
    }
  } else {
    return;
  }

  console.log('[BG] msg', tabId, msg.type, tabs.get(tabId));
  recomputeBadge();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const cur = tabs.get(tabId);
  if (cur?.status === Status.READY) {
    tabs.set(tabId, { status: Status.VIEWED, ts: Date.now() });
    recomputeBadge();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // игнорируем SPA-шум
  const url = changeInfo.url || tab?.url || '';
  const onChatGPT = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url);
  if (!onChatGPT && tabs.has(tabId)) {
    tabs.delete(tabId);
    clearHeartbeat(tabId);
    recomputeBadge();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const removed = tabs.delete(tabId);
  clearHeartbeat(tabId);
  if (removed) recomputeBadge();
});

// клик по иконке — прыгаем на первую вкладку с READY
chrome.action.onClicked.addListener(() => {
  for (const [tabId, v] of tabs) {
    if (v.status === Status.READY) { chrome.tabs.update(tabId, { active: true }); break; }
  }
});

function runWatchdog() {
  const now = Date.now();
  let changed = false;
  for (const [tabId, v] of tabs) {
    if (v.status === Status.GENERATING) {
      if (now - v.ts > getStaleMs(tabId)) {
        tabs.set(tabId, { status: Status.IDLE, ts: now });
        clearHeartbeat(tabId);
        changed = true;
        console.log('[BG] stale GENERATING -> IDLE', tabId);
      }
    } else if (heartbeatConfigs.has(tabId)) {
      clearHeartbeat(tabId);
    }
  }
  if (changed) recomputeBadge();
}

runWatchdog();

// глобальный бейдж (READY > GENERATING > пусто)
function recomputeBadge() {
  const now = Date.now();
  let anyReady = false;
  let anyGenFresh = false;

  for (const [tabId, v] of tabs) {
    if (v.status === Status.READY) {
      anyReady = true;
      break;
    }
    if (v.status === Status.GENERATING && now - v.ts <= getStaleMs(tabId)) {
      anyGenFresh = true;
    }
  }

  if (anyReady) { stopBlink(); setBadge('!'); return; }
  if (anyGenFresh) { startBlink(); return; }
  stopBlink(); setBadge('');
}

function setBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
}

function startBlink() {
  if (blinkTimer) return;
  let visible = true;
  blinkTimer = setInterval(() => {
    chrome.action.setBadgeText({ text: visible ? '…' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
    visible = !visible; // переключатель ДОЛЖЕН быть внутри таймера
  }, 500);
}

function stopBlink() {
  if (!blinkTimer) return;
  clearInterval(blinkTimer);
  blinkTimer = null;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const name = alarm?.name;
  if (!name) return;
  if (name === WATCHDOG_ALARM) {
    runWatchdog();
    return;
  }
  if (!name.startsWith('heartbeat:')) return;
  const tabId = Number(name.split(':')[1]);
  if (!Number.isInteger(tabId) || !heartbeatConfigs.has(tabId)) {
    chrome.alarms.clear(name, () => { void chrome.runtime.lastError; });
    return;
  }
  try {
    chrome.tabs.sendMessage(tabId, { type: 'heartbeat-ping' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    clearHeartbeat(tabId);
  }
});
