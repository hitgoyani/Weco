'use strict';

function enablePanelBehavior() {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(enablePanelBehavior);
chrome.runtime.onStartup.addListener(enablePanelBehavior);
enablePanelBehavior();
