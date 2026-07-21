const RULE34_MENU = "gallery-import-rule34";
const X_MENU = "gallery-import-x";
const NH_POOL_MENU = "gallery-add-collection-image";
const LOCAL_ENDPOINT = "http://127.0.0.1:37891/import";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: RULE34_MENU,
      title: "Import this Rule34 post into Gallery",
      contexts: ["page"],
      documentUrlPatterns: ["https://rule34.xxx/*", "https://www.rule34.xxx/*"]
    });

    chrome.contextMenus.create({
      id: X_MENU,
      title: "Import this X/Twitter post into Gallery",
      contexts: ["page", "image", "video"],
      documentUrlPatterns: [
        "https://x.com/*",
        "https://www.x.com/*",
        "https://twitter.com/*",
        "https://www.twitter.com/*"
      ]
    });

    chrome.contextMenus.create({
      id: NH_POOL_MENU,
      title: "Add image to Gallery pool",
      contexts: ["image"],
      documentUrlPatterns: [
        "https://nhentai.net/*",
        "https://*.nhentai.net/*",
        "https://e-hentai.org/*",
        "https://*.e-hentai.org/*",
        "https://exhentai.org/*",
        "https://*.exhentai.org/*"
      ]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;

  try {
    if (info.menuItemId === NH_POOL_MENU) {
      const imageUrl = info.srcUrl;
      if (!imageUrl) throw new Error("No image URL was found.");
      await chrome.tabs.sendMessage(tab.id, { type: "nh-pool-add", imageUrl });
      return;
    }

    let payload;
    if (info.menuItemId === RULE34_MENU) {
      payload = { url: tab.url, site: "rule34" };
    } else if (info.menuItemId === X_MENU) {
      payload = await chrome.tabs.sendMessage(tab.id, { type: "extract-x-post" });
      if (payload?.error) throw new Error(payload.error);
    } else {
      return;
    }

    await sendPayload(payload, true);
  } catch (error) {
    await showNotification("Gallery import failed", error?.message || String(error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "import-x-payload") {
    sendPayload(message.payload, true)
      .then(result => sendResponse({ ok: true, queuedRemotely: Boolean(result?.queuedRemotely) }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "submit-nh-pool") {
    sendPayload(message.payload, false)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

async function sendPayload(payload, allowQueue) {
  try {
    const response = await fetch(LOCAL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await readJsonSafely(response);
    if (!response.ok) {
      throw new Error(result.error || `Desktop importer returned HTTP ${response.status}`);
    }

    await showNotification("Import queued", "The desktop app accepted the import.");
    return result;
  } catch (desktopError) {
    if (!allowQueue) {
      throw new Error(`Desktop app is not available. ${desktopError?.message || desktopError}`);
    }

    return enqueueRemotely(payload, desktopError);
  }
}

async function enqueueRemotely(payload, desktopError) {
  const queueUrl = payload?.url;
  if (!queueUrl) {
    throw new Error(
      `Desktop app is unavailable and this item has no post URL to queue. ${desktopError?.message || ""}`.trim()
    );
  }

  const { mobileQueueEndpoint, mobileQueueToken } = await chrome.storage.sync.get([
    "mobileQueueEndpoint",
    "mobileQueueToken"
  ]);

  if (!mobileQueueEndpoint || !mobileQueueToken) {
    throw new Error(
      "Desktop app is unavailable and the mobile queue is not configured. Open the extension options and save the Apps Script endpoint and token."
    );
  }

  const response = await fetch(mobileQueueEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      action: "append",
      token: mobileQueueToken,
      url: queueUrl
    }),
    redirect: "follow"
  });

  const result = await readJsonSafely(response);
  if (!response.ok || result.error) {
    throw new Error(result.error || `Mobile queue returned HTTP ${response.status}`);
  }

  await showNotification(
    "Saved to mobile queue",
    "The desktop app is closed, so the post was saved for later."
  );

  return { ...result, queuedRemotely: true };
}

async function readJsonSafely(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function showNotification(title, message) {
  return chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message: String(message || "")
  });
}
