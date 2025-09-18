const Status = { IDLE:'idle', GENERATING:'generating', READY:'ready', VIEWED:'viewed' };

// по вкладкам: { status, ts }
const tabs = new Map();
let blinkTimer = null;

chrome.runtime.onInstalled.addListener(() => chrome.action.setBadgeText({ text: '' }));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (msg.type === 'status') {
    tabs.set(tabId, { status: msg.status, ts: Date.now() });
  } else if (msg.type === 'heartbeat') {
    const cur = tabs.get(tabId);
    if (cur?.status === Status.GENERATING) {
      cur.ts = Date.now();
      tabs.set(tabId, cur);
    } else {
      tabs.set(tabId, { status: Status.GENERATING, ts: Date.now() });
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
    recomputeBadge();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.delete(tabId)) recomputeBadge();
});

// клик по иконке — прыгаем на первую вкладку с READY
chrome.action.onClicked.addListener(() => {
  for (const [tabId, v] of tabs) {
    if (v.status === Status.READY) { chrome.tabs.update(tabId, { active: true }); break; }
  }
});

// сторож: если 8 сек нет heartbeat из GENERATING — считаем, что уже не генерит
const STALE_MS = 8000;
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [tabId, v] of tabs) {
    if (v.status === Status.GENERATING && now - v.ts > STALE_MS) {
      tabs.set(tabId, { status: Status.IDLE, ts: now });
      changed = true;
      console.log('[BG] stale GENERATING -> IDLE', tabId);
    }
  }
  if (changed) recomputeBadge();
}, 1000);

// глобальный бейдж (READY > GENERATING > пусто)
function recomputeBadge() {
  const vals = [...tabs.values()];
  const now = Date.now();
  const anyReady = vals.some(v => v.status === Status.READY);
  const anyGenFresh = vals.some(v => v.status === Status.GENERATING && now - v.ts <= STALE_MS);

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
