let enabled = false;

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "GET_STATE") {
    return Promise.resolve({ enabled });
  }

  if (message.type === "TOGGLE") {
    enabled = !enabled;
    console.log(`Billy Reader: enabled = ${enabled}`);
    return Promise.resolve({ enabled });
  }
});
