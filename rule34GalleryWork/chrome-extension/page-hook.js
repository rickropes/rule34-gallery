(() => {
  const videosByPost = new Map();
  const animatedGifUrlsByPost = new Map();

  function add(postId, urls, animatedGif = false) {
    if (!postId || !urls?.length) return;
    const current = videosByPost.get(String(postId)) || new Set();
    for (const url of urls) {
      if (typeof url === "string" && /^https:\/\/video\.twimg\.com\//i.test(url) && /\.(?:mp4|webm)(?:\?|$)/i.test(url)) {
        current.add(url.replace(/\\u002F/g, "/").replace(/\\\//g, "/"));
      }
    }
    if (current.size) videosByPost.set(String(postId), current);
    if (animatedGif) {
      const gifs = animatedGifUrlsByPost.get(String(postId)) || new Set();
      for (const url of urls) if (typeof url === "string") gifs.add(url.replace(/\u002F/g, "/").replace(/\\\//g, "/"));
      if (gifs.size) animatedGifUrlsByPost.set(String(postId), gifs);
    }
  }

  function collectUrls(value, output = []) {
    if (typeof value === "string") {
      if (/^https:\/\/video\.twimg\.com\//i.test(value) && /\.(?:mp4|webm)(?:\?|$)/i.test(value)) output.push(value);
      return output;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectUrls(item, output);
      return output;
    }
    if (!value || typeof value !== "object") return output;
    for (const item of Object.values(value)) collectUrls(item, output);
    return output;
  }

  function collectPrimaryTweetMedia(tweet) {
    const urls = [];
    const legacy = tweet?.legacy || tweet?.tweet?.legacy || tweet;
    const media = legacy?.extended_entities?.media || legacy?.entities?.media || [];
    for (const item of Array.isArray(media) ? media : []) {
      const variants = item?.video_info?.variants || item?.variants || [];
      for (const variant of variants) {
        const url = variant?.url;
        const contentType = String(variant?.content_type || variant?.contentType || "");
        if (typeof url === "string" && /^https:\/\/video\.twimg\.com\//i.test(url)
            && (/\.(?:mp4|webm)(?:\?|$)/i.test(url) || contentType.startsWith("video/"))) {
          urls.push(url);
        }
      }
      const direct = item?.video_url || item?.url;
      if (typeof direct === "string" && /^https:\/\/video\.twimg\.com\//i.test(direct)
          && /\.(?:mp4|webm)(?:\?|$)/i.test(direct)) urls.push(direct);
    }
    return urls;
  }

  function collectAnimatedGifMedia(tweet) {
    const urls = [];
    const legacy = tweet?.legacy || tweet?.tweet?.legacy || tweet;
    const media = legacy?.extended_entities?.media || legacy?.entities?.media || [];
    for (const item of Array.isArray(media) ? media : []) {
      const kind = String(item?.type || item?.kind || "").toLowerCase();
      if (!kind.includes("gif")) continue;
      const variants = item?.video_info?.variants || item?.variants || [];
      for (const variant of variants) {
        const url = variant?.url;
        const contentType = String(variant?.content_type || variant?.contentType || "");
        if (typeof url === "string" && /^https:\/\/video\.twimg\.com\//i.test(url)
            && (/\.(?:mp4|webm)(?:\?|$)/i.test(url) || contentType.startsWith("video/"))) urls.push(url);
      }
    }
    return urls;
  }

  function inspect(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }

    // Store media only against the exact tweet object that owns it. Do not
    // recursively collect every video URL below a parent response object,
    // because that mixes replies, quoted tweets, and timeline neighbours.
    const postId = value?.rest_id || value?.id_str || value?.legacy?.id_str;
    if (postId) {
      add(String(postId), collectPrimaryTweetMedia(value));
      const animatedUrls = collectAnimatedGifMedia(value);
      if (animatedUrls.length) {
        const gifs = animatedGifUrlsByPost.get(String(postId)) || new Set();
        for (const url of animatedUrls) gifs.add(url);
        animatedGifUrlsByPost.set(String(postId), gifs);
      }
    }

    for (const item of Object.values(value)) inspect(item);
  }

  function inspectText(text) {
    if (!text || text.length > 25_000_000) return;
    try { inspect(JSON.parse(text)); } catch (_) {
      // Ignore non-JSON response bodies rather than guessing tweet ownership.
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const clone = response.clone();
      clone.text().then(inspectText).catch(() => {});
    } catch (_) {}
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__galleryUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", () => {
      try {
        if (typeof this.responseText === "string") inspectText(this.responseText);
      } catch (_) {}
    });
    return originalSend.apply(this, args);
  };

  window.addEventListener("gallery-x-video-request", event => {
    const postId = String(event.detail?.postId || "");
    window.dispatchEvent(new CustomEvent("gallery-x-video-response", {
      detail: { requestId: event.detail?.requestId, postId, urls: [...(videosByPost.get(postId) || [])], animatedGifUrls: [...(animatedGifUrlsByPost.get(postId) || [])] }
    }));
  });
})();
