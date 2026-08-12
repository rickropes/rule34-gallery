const DEFAULT_MOBILE_QUEUE_ENDPOINT = "https://script.google.com/macros/s/AKfycbzgBoDbRkY3ZfM6CfDOxO48dsnDu7IYH6LR18yzhhmG1W-lSO6HVld7C0G_f4g9DdANxg/exec";
const MOBILE_QUEUE_CONFIG_REVISION = 2;
const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

chrome.storage.sync.get(["mobileQueueEndpoint", "mobileQueueToken", "mobileQueueConfigRevision"]).then(async values => {
  let savedEndpoint = String(values.mobileQueueEndpoint || "").trim();
  if (values.mobileQueueConfigRevision !== MOBILE_QUEUE_CONFIG_REVISION || !savedEndpoint) {
    savedEndpoint = DEFAULT_MOBILE_QUEUE_ENDPOINT;
    await chrome.storage.sync.set({
      mobileQueueEndpoint: savedEndpoint,
      mobileQueueConfigRevision: MOBILE_QUEUE_CONFIG_REVISION
    });
  }
  endpoint.value = savedEndpoint;
  token.value = values.mobileQueueToken || "";
});

document.querySelector("#save").addEventListener("click", async () => {
  const mobileQueueEndpoint = endpoint.value.trim();
  const mobileQueueToken = token.value.trim();
  if (mobileQueueEndpoint) {
    try { new URL(mobileQueueEndpoint); }
    catch { status.textContent = "Invalid endpoint URL."; return; }
  }
  await chrome.storage.sync.set({ mobileQueueEndpoint, mobileQueueToken, mobileQueueConfigRevision: MOBILE_QUEUE_CONFIG_REVISION });
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 1800);
});
