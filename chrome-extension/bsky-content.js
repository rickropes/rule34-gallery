let blueskyContextTarget = null;
document.addEventListener("contextmenu", event => { blueskyContextTarget = event.target; }, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "extract-bsky-post") return;
  try { sendResponse(extractBlueskyPost(blueskyContextTarget)); }
  catch (error) { sendResponse({ error: error.message }); }
});

function extractBlueskyPost(target) {
  const container = target?.closest?.('div[data-testid^="feedItem"], article') || target?.closest?.('main') || document;
  const candidates = [
    ...(target?.closest?.('a[href*="/profile/"][href*="/post/"]') ? [target.closest('a[href*="/profile/"][href*="/post/"]')] : []),
    ...container.querySelectorAll?.('a[href*="/profile/"][href*="/post/"]') || [],
    ...document.querySelectorAll('a[href*="/profile/"][href*="/post/"]')
  ];
  let href = candidates.map(anchor => anchor.href).find(value => /\/profile\/[^/]+\/post\/[^/?#]+/.test(value || ""));
  if (!href) {
    const current = location.href;
    if (/\/profile\/[^/]+\/post\/[^/?#]+/.test(current)) href = current;
  }
  if (!href) throw new Error("Could not identify the Bluesky post link. Right-click inside an individual post.");
  const parsed = new URL(href);
  const match = parsed.pathname.match(/^\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (!match) throw new Error("Could not identify the Bluesky handle or post id.");
  const artist = decodeURIComponent(match[1]).replace(/^@/, "");
  return {
    url: `https://bsky.app/profile/${encodeURIComponent(artist)}/post/${match[2]}`,
    site: "bsky",
    artist,
    mediaUrls: [],
    mediaTypes: []
  };
}
