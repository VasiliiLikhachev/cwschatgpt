// --- статусы ---
const Status = { IDLE: 'idle', GENERATING: 'generating', READY: 'ready' };

// --- состояние ---
let state = Status.IDLE;
let snapshot = null;         // { msgCount, lastLen, t }
let checkScheduled = false;

// --- хелперы ---
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const getAssistantNodes = () => $$('[data-message-author-role="assistant"]');
const getLastAssistantNode = () => {
  const nodes = getAssistantNodes();
  return nodes.length ? nodes[nodes.length - 1] : null;
};
const getLastAssistantLength = () => {
  const n = getLastAssistantNode();
  return n ? (n.textContent || '').length : 0;
};

// считаем, что "генерация идет" только если кнопка Stop реально ВИДИМА
const isGenerating = () => {
  const el =
    $('button[data-testid="stop-button"]') ||
    $('[data-testid="stop-streaming-button"]');
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const visible =
    el.offsetParent !== null &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0';
  return visible;
};

// безопасная отправка сообщений в бэкграунд
const notify = (status) => {
  try {
    if (chrome?.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'status', status }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_) {}
};

// heartbeat-конфигурация и управление
const HEARTBEAT_VISIBLE_MS = 6000;
const HEARTBEAT_HIDDEN_MS  = 9000;
let   heartbeatActive = false;
let   heartbeatInterval = null;

const getHeartbeatDelay = () => (
  document.visibilityState === 'hidden' ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_VISIBLE_MS
);

const sendHeartbeat = () => {
  if (state !== Status.GENERATING) return;
  try {
    if (chrome?.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'heartbeat', status: 'generating' }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_) {}
};

const startHeartbeat = () => {
  if (heartbeatActive) return;
  heartbeatActive = true;
  sendHeartbeat();
  heartbeatInterval = getHeartbeatDelay();
  try {
    if (chrome?.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'heartbeat-control',
        action: 'start',
        intervalMs: heartbeatInterval,
      }, () => { void chrome.runtime.lastError; });
    }
  } catch (_) {}
};

const stopHeartbeat = () => {
  if (!heartbeatActive) return;
  heartbeatActive = false;
  heartbeatInterval = null;
  try {
    if (chrome?.runtime?.id) {
      chrome.runtime.sendMessage({ type: 'heartbeat-control', action: 'stop' }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_) {}
};

const updateHeartbeatSchedule = (force = false) => {
  if (!heartbeatActive || state !== Status.GENERATING) return;
  const nextInterval = getHeartbeatDelay();
  if (!force && heartbeatInterval === nextInterval) return;
  heartbeatInterval = nextInterval;
  try {
    if (chrome?.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'heartbeat-control',
        action: 'update',
        intervalMs: heartbeatInterval,
      }, () => { void chrome.runtime.lastError; });
    }
  } catch (_) {}
};

const scheduleCheck = () => {
  if (checkScheduled) return;
  checkScheduled = true;
  requestAnimationFrame(() => {
    checkScheduled = false;
    evaluate();
  });
};

// --- ядро ---
const evaluate = () => {
  const generatingNow = isGenerating();

  if (generatingNow) {
    if (state !== Status.GENERATING) {
      state = Status.GENERATING;
      snapshot = {
        msgCount: getAssistantNodes().length,
        lastLen:  getLastAssistantLength(),
        t:        Date.now(),
      };
      console.log('[GPT Badge] START', snapshot);
      notify(Status.GENERATING);
      startHeartbeat();
    } else if (!heartbeatActive) {
      startHeartbeat();
    } else {
      updateHeartbeatSchedule();
    }
    return;
  }

  if (state === Status.GENERATING) {
    stopHeartbeat();
    const msgCount = getAssistantNodes().length;
    const lastLen  = getLastAssistantLength();

    console.log('[GPT Badge] CHECK after generation', {
      prevMsg: snapshot?.msgCount, nowMsg: msgCount,
      prevLen: snapshot?.lastLen,  nowLen: lastLen
    });

    const grewByNewMsg = !snapshot || msgCount > snapshot.msgCount;
    const grewByText   = !snapshot || lastLen  > snapshot.lastLen;
    const hasNewAnswer = grewByNewMsg || grewByText;

    state = hasNewAnswer ? Status.READY : Status.IDLE;

    if (hasNewAnswer) {
      console.log('[GPT Badge] READY');
      notify(Status.READY);
    } else {
      console.log('[GPT Badge] no change, stay IDLE');
      notify(Status.IDLE);
    }
  }
};

// следим за DOM
const observer = new MutationObserver(scheduleCheck);
observer.observe(document.documentElement, { childList: true, subtree: true });

console.log('[GPT Badge] content script loaded');
evaluate();

// сброс при возврате к вкладке
const resetIfViewed = () => {
  if (state === Status.READY) {
    state = Status.IDLE;
    console.log('[GPT Badge] VIEWED');
    try {
      chrome?.runtime?.id && chrome.runtime.sendMessage({ type: 'status', status: 'viewed' }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }
};
window.addEventListener('focus', resetIfViewed);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resetIfViewed();
  if (heartbeatActive && state === Status.GENERATING) {
    if (document.visibilityState === 'hidden') sendHeartbeat();
    updateHeartbeatSchedule();
  }
});

// резервный поллинг — даже если вкладка в фоне
const POLL_MS = 1000;
setInterval(() => {
  try {
    if (state === Status.GENERATING) evaluate();
  } catch (_) {}
}, POLL_MS);

// слушаем пинги из background, чтобы heartbeat не залипал в фоне
try {
  chrome?.runtime?.onMessage?.addListener((msg) => {
    if (msg?.type === 'heartbeat-ping' && heartbeatActive && state === Status.GENERATING) {
      sendHeartbeat();
      updateHeartbeatSchedule();
    }
  });
} catch (_) {}
