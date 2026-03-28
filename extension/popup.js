const toggleBtn = document.getElementById("toggle");
const statusDiv = document.getElementById("status");

function updateUI(enabled) {
  toggleBtn.textContent = enabled ? "ON" : "OFF";
  toggleBtn.classList.toggle("on", enabled);
}

async function getActiveTabId() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function sendToTab(tabId, message) {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch {
    statusDiv.textContent = "Not available on this page";
    return null;
  }
}

async function init() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const response = await sendToTab(tabId, { type: "GET_STATE" });
  if (response) {
    updateUI(response.enabled);
  }
}

toggleBtn.addEventListener("click", async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const response = await sendToTab(tabId, { type: "TOGGLE" });
  if (response) {
    updateUI(response.enabled);
    if (!response.enabled) {
      browser.tabs.reload(tabId);
      window.close();
    }
  }
});

init();
