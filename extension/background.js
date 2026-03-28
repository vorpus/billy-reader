const enabledTabs = new Set();

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "SET_ICON" && sender.tab) {
    const tabId = sender.tab.id;
    if (message.enabled) {
      enabledTabs.add(tabId);
    } else {
      enabledTabs.delete(tabId);
    }
    browser.browserAction.setIcon({
      path: message.enabled ? "icon-on.png" : "icon-off.png",
      tabId,
    });
  }
});

// Reset icon when tab navigates (content script reloads, state is lost)
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    enabledTabs.delete(tabId);
    browser.browserAction.setIcon({ path: "icon-off.png", tabId });
  }
});

// Clean up when tab closes
browser.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
});
