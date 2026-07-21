let contextTarget = null;
document.addEventListener("contextmenu", event => { contextTarget = event.target; }, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "extract-x-post") return;
  extractPost(contextTarget).then(sendResponse).catch(error => sendResponse({ error: error.message }));
  return true;
});

async function extractPost(target) {
  const article = target?.closest?.("article");
  if (!article) throw new Error("Select an X/Twitter post");
  return extractArticle(article);
}

async function extractArticle(article) {
  const statusLink = [...article.querySelectorAll('a[href*="/status/"]')]
    .map(a => a.href)
    .find(href => /\/status\/\d+/.test(href));
  if (!statusLink) throw new Error("Could not identify the post link");
  const parsed = new URL(statusLink);
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!match) throw new Error("Could not identify the Twitter username");
  const artist = decodeURIComponent(match[1]).replace(/^@/, "");
  const postId = match[2];
  const url = `https://x.com/${artist}/status/${postId}`;

  const imageUrls = unique([...article.querySelectorAll('img[src*="pbs.twimg.com/media/"]')]
    .map(img => originalImageUrl(img.currentSrc || img.src)));

  const directVideos = [...article.querySelectorAll("video")]
    .flatMap(video => [video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map(source => source.src)])
    .filter(src => /^https?:\/\//.test(src || ""));
  const captured = await requestCapturedVideos(postId);
  const capturedVideos = captured.urls;
  // Never use the page-wide performance resource list here: it includes media
  // from adjacent, quoted, and previously-scrolled posts. Only use URLs tied
  // to this post ID by the page hook, plus direct non-blob sources in this article.
  const videoUrls = bestVideoVariantPerAsset(unique([...directVideos, ...capturedVideos]));
  const animatedGifAssets = new Set((captured.animatedGifUrls || []).map(videoAssetKey));

  const mediaUrls = [...imageUrls, ...videoUrls];
  const mediaTypes = [...imageUrls.map(() => "image"), ...videoUrls.map(url => animatedGifAssets.has(videoAssetKey(url)) ? "animated_gif" : "video")];
  if (!mediaUrls.length) throw new Error("No downloadable media found in this post");
  return { url, site: "x", artist, mediaUrls, mediaTypes };
}

function requestCapturedVideos(postId) {
  return new Promise(resolve => {
    const requestId = `${Date.now()}-${Math.random()}`;
    const timeout = setTimeout(() => { cleanup(); resolve({ urls: [], animatedGifUrls: [] }); }, 400);
    const listener = event => {
      if (event.detail?.requestId !== requestId) return;
      cleanup();
      resolve({ urls: event.detail?.urls || [], animatedGifUrls: event.detail?.animatedGifUrls || [] });
    };
    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener("gallery-x-video-response", listener);
    }
    window.addEventListener("gallery-x-video-response", listener);
    window.dispatchEvent(new CustomEvent("gallery-x-video-request", { detail: { requestId, postId } }));
  });
}

function originalImageUrl(raw) {
  const url = new URL(raw);
  url.searchParams.set("name", "orig");
  return url.toString();
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function videoAssetKey(value) {
  return value.match(/\/(?:ext_tw_video|amplify_video|tweet_video)\/(\d+)/)?.[1] || value.split("?")[0];
}
function bestVideoVariantPerAsset(values) {
  const groups = new Map();
  for (const value of values) {
    const asset = videoAssetKey(value);
    const current = groups.get(asset);
    if (!current || videoScore(value) > videoScore(current)) groups.set(asset, value);
  }
  return [...groups.values()];
}
function videoScore(value) {
  const dimensions = value.match(/\/(\d+)x(\d+)\//);
  if (dimensions) return Number(dimensions[1]) * Number(dimensions[2]);
  return Number(value.match(/bitrate=(\d+)/)?.[1] || 0);
}

function installButtons(root = document) {
  for (const article of root.querySelectorAll?.("article") || []) {
    if (article.querySelector(".gallery-import-x-button")) continue;
    const actionGroup = [...article.querySelectorAll('[role="group"]')]
      .find(group => group.querySelector('[data-testid="reply"]') || group.querySelector('[data-testid="like"]'));
    if (!actionGroup) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gallery-import-x-button";
    button.title = "Import media into Gallery";
    button.setAttribute("aria-label", "Import media into Gallery");
    button.style.cssText = "border:0;background:transparent;color:rgb(113,118,123);display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9999px;cursor:pointer;font:700 17px Arial,sans-serif;";
    button.textContent = "⇩";
    button.addEventListener("mouseenter", () => { button.style.background = "rgba(29,155,240,.1)"; button.style.color = "rgb(29,155,240)"; });
    button.addEventListener("mouseleave", () => { button.style.background = "transparent"; button.style.color = "rgb(113,118,123)"; });
    button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      const old = button.textContent;
      button.textContent = "…";
      button.disabled = true;
      try {
        const payload = await extractArticle(article);
        const result = await chrome.runtime.sendMessage({ type: "import-x-payload", payload });
        if (!result?.ok) throw new Error(result?.error || "Import failed");
        button.textContent = "✓";
      } catch (error) {
        button.textContent = "!";
        button.title = error.message;
      } finally {
        setTimeout(() => { button.textContent = old; button.disabled = false; }, 1800);
      }
    });
    actionGroup.appendChild(button);
  }
}

const observer = new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) installButtons(node);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("DOMContentLoaded", () => installButtons());
setInterval(() => installButtons(), 2000);
