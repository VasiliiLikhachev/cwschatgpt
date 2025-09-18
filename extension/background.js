const READY_BADGE_TEXT = '!';
const DEFAULT_TITLE = 'ChatGPT Tab Notifier';

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#10a37f' });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'status' || !sender.tab?.id) {
    return;
  }

  const tabId = sender.tab.id;

  if (message.status === 'ready') {
    chrome.action.setBadgeText({ tabId, text: READY_BADGE_TEXT });
    chrome.action.setTitle({ tabId, title: 'ChatGPT ответ готов' });
  } else if (message.status === 'generating') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'ChatGPT генерирует ответ…' });
  } else if (message.status === 'viewed' || message.status === 'reset') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.action.setBadgeText({ tabId, text: '' });
  chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
  }
});
