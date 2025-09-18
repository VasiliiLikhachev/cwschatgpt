const Status = {
  IDLE: 'idle',
  GENERATING: 'generating',
  READY: 'ready',
};

let state = Status.IDLE;
let generationSnapshot = null;
let checkScheduled = false;

const scheduleCheck = () => {
  if (checkScheduled) {
    return;
  }

  checkScheduled = true;
  requestAnimationFrame(() => {
    checkScheduled = false;
    evaluateState();
  });
};

const countAssistantMessages = () =>
  document.querySelectorAll('[data-message-author-role="assistant"]').length;

const notify = (status) => {
  chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {
    // The background service worker might be asleep; ignore errors.
  });
};

const evaluateState = () => {
  const isGeneratingNow = Boolean(
    document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('[data-testid="stop-streaming-button"]')
  );

  if (isGeneratingNow) {
    if (state !== Status.GENERATING) {
      state = Status.GENERATING;
      generationSnapshot = {
        count: countAssistantMessages(),
        timestamp: Date.now(),
      };
      notify(Status.GENERATING);
    }
    return;
  }

  if (state === Status.GENERATING) {
    const currentCount = countAssistantMessages();
    const hasNewAnswer =
      !generationSnapshot || currentCount > generationSnapshot.count;

    state = hasNewAnswer ? Status.READY : Status.IDLE;

    if (hasNewAnswer) {
      notify(Status.READY);
    }
  }
};

const observer = new MutationObserver(() => {
  scheduleCheck();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

evaluateState();

window.addEventListener('focus', () => {
  if (state === Status.READY) {
    state = Status.IDLE;
    notify('viewed');
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state === Status.READY) {
    state = Status.IDLE;
    notify('viewed');
  }
});
