const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

chrome.storage.sync.get(["mobileQueueEndpoint", "mobileQueueToken"]).then(values => {
  endpoint.value = values.mobileQueueEndpoint || "";
  token.value = values.mobileQueueToken || "";
});

document.querySelector("#save").addEventListener("click", async () => {
  const mobileQueueEndpoint = endpoint.value.trim();
  const mobileQueueToken = token.value.trim();
  if (mobileQueueEndpoint) {
    try { new URL(mobileQueueEndpoint); }
    catch { status.textContent = "Invalid endpoint URL."; return; }
  }
  await chrome.storage.sync.set({ mobileQueueEndpoint, mobileQueueToken });
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 1800);
});
