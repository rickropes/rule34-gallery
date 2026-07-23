const RULE34_MENU = "gallery-import-rule34";
const DANBOORU_MENU = "gallery-import-danbooru";
const GELBOORU_MENU = "gallery-import-gelbooru";
const X_MENU = "gallery-import-x";
const BSKY_MENU = "gallery-import-bsky";
const NH_POOL_MENU = "gallery-add-collection-image";
const LOCAL_ENDPOINT = "http://127.0.0.1:37891/import";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({id:RULE34_MENU,title:"Import this Rule34 post into Gallery",contexts:["page"],documentUrlPatterns:["https://rule34.xxx/*","https://www.rule34.xxx/*"]});
    chrome.contextMenus.create({id:DANBOORU_MENU,title:"Import this Danbooru post into Gallery",contexts:["page","image","video"],documentUrlPatterns:["https://danbooru.donmai.us/posts/*","https://www.danbooru.donmai.us/posts/*"]});
    chrome.contextMenus.create({id:GELBOORU_MENU,title:"Import this Gelbooru post into Gallery",contexts:["page","image","video"],documentUrlPatterns:["https://gelbooru.com/index.php*","https://www.gelbooru.com/index.php*"]});
    chrome.contextMenus.create({id:X_MENU,title:"Import this X/Twitter post into Gallery",contexts:["page","image","video"],documentUrlPatterns:["https://x.com/*","https://www.x.com/*","https://twitter.com/*","https://www.twitter.com/*"]});
    chrome.contextMenus.create({id:BSKY_MENU,title:"Import this Bluesky post into Gallery",contexts:["page","image","video","link"],documentUrlPatterns:["https://bsky.app/*","https://www.bsky.app/*"]});
    chrome.contextMenus.create({id:NH_POOL_MENU,title:"Add image to Gallery pool",contexts:["image"],documentUrlPatterns:["https://nhentai.net/*","https://*.nhentai.net/*","https://e-hentai.org/*","https://*.e-hentai.org/*","https://exhentai.org/*","https://*.exhentai.org/*"]});
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;
  try {
    if (info.menuItemId === NH_POOL_MENU) {
      const imageUrl = info.srcUrl;
      if (!imageUrl) throw new Error("No image URL was found.");
      await chrome.tabs.sendMessage(tab.id,{type:"nh-pool-add",imageUrl});
      return;
    }
    let payload;
    if (info.menuItemId === RULE34_MENU) payload={url:tab.url,site:"rule34"};
    else if (info.menuItemId === DANBOORU_MENU) payload={url:tab.url,site:"danbooru"};
    else if (info.menuItemId === GELBOORU_MENU) payload={url:tab.url,site:"gelbooru"};
    else if (info.menuItemId === X_MENU) {
      payload=await chrome.tabs.sendMessage(tab.id,{type:"extract-x-post"});
      if(payload?.error) throw new Error(payload.error);
    } else if (info.menuItemId === BSKY_MENU) {
      payload=await chrome.tabs.sendMessage(tab.id,{type:"extract-bsky-post"});
      if(payload?.error) throw new Error(payload.error);
    } else return;
    await sendPayload(payload,true);
  } catch(error){ await notify("Gallery import failed",error.message); }
});

chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message?.type==="import-x-payload"){
    sendPayload(message.payload,true).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==="submit-nh-pool"){
    sendPayload(message.payload,false).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
});

async function sendPayload(payload, allowQueue){
  try{
    const response=await fetch(LOCAL_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(result.error||`HTTP ${response.status}`);
    await notify("Import queued","The desktop app accepted the import.");
    return result;
  }catch(error){
    if(!allowQueue) throw new Error(`Desktop app is not available. ${error.message}`);
    throw error;
  }
}
function notify(title,message){return chrome.notifications.create({type:"basic",iconUrl:"icon128.png",title,message});}
