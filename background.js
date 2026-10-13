'use strict';

function enablePanelBehavior() {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(enablePanelBehavior);
chrome.runtime.onStartup.addListener(enablePanelBehavior);
enablePanelBehavior();

const SESSION_PREFIX = 'localWebQa:lastReport:v2:';
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.remove(`${SESSION_PREFIX}${tabId}`).catch(() => {});
    }
  });
}
