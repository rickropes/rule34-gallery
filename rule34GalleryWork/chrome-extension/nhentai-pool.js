const STORAGE_KEY="galleryImagePoolV2";
const LEGACY_STORAGE_KEY="nhentaiImagePoolV1";
let state={images:[],metadata:null};
let box;

init();
async function init(){
  const stored=await chrome.storage.local.get([STORAGE_KEY,LEGACY_STORAGE_KEY]);
  state=stored[STORAGE_KEY]||stored[LEGACY_STORAGE_KEY]||state;
  if(!stored[STORAGE_KEY]&&stored[LEGACY_STORAGE_KEY]) await chrome.storage.local.set({[STORAGE_KEY]:state});
  state.images=(state.images||[]).map((item,index)=>typeof item==="string"?{url:item,pageNumber:null,addedOrder:index}:item);
  sortImages();
  render();
}
chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message?.type!=="nh-pool-add") return;
  const pageNumber=readCurrentPageNumber();
  addImage(message.imageUrl,pageNumber,normalizeGalleryUrl(location.href)).then(()=>sendResponse({ok:true,pageNumber})).catch(e=>sendResponse({ok:false,error:e.message}));
  return true;
});
async function addImage(url,pageNumber,sourceUrl){
  if(!/^https?:\/\//i.test(url)) throw new Error("Invalid image URL");
  const existing=state.images.find(item=>item.url===url);
  if(existing){
    if(Number.isFinite(pageNumber)) existing.pageNumber=pageNumber;
    if(sourceUrl) existing.sourceUrl=normalizeGalleryUrl(sourceUrl);
  }else{
    state.images.push({url,pageNumber:Number.isFinite(pageNumber)?pageNumber:null,sourceUrl:normalizeGalleryUrl(sourceUrl||location.href),addedOrder:Date.now()+Math.random()});
  }
  sortImages();
  await save(); render();
}
function providerForUrl(raw=location.href){
  try{
    const host=new URL(raw,location.href).hostname.toLowerCase();
    if(host==="e-hentai.org"||host.endsWith(".e-hentai.org")) return "ehentai";
    if(host==="exhentai.org"||host.endsWith(".exhentai.org")) return "exhentai";
    if(host==="nhentai.net"||host.endsWith(".nhentai.net")) return "nhentai";
  }catch{}
  return "generic";
}
function readCurrentPageNumber(){
  const provider=providerForUrl();
  if(provider==="nhentai"){
    const text=document.querySelector("button.page-number .current")?.textContent?.trim();
    const parsed=Number.parseInt(text||"",10);
    if(Number.isFinite(parsed)&&parsed>0) return parsed;
    const pathMatch=location.pathname.match(/\/(?:g\/\d+\/)?(\d+)\/?$/);
    if(pathMatch){const value=Number.parseInt(pathMatch[1],10);if(Number.isFinite(value)&&value>0)return value;}
  }
  if(provider==="ehentai"||provider==="exhentai"){
    const urlMatch=location.pathname.match(/^\/s\/[^/]+\/\d+-(\d+)\/?$/);
    if(urlMatch){const value=Number.parseInt(urlMatch[1],10);if(Number.isFinite(value)&&value>0)return value;}
    const selected=document.querySelector("#i2 .sn div, #i2 .sn span, .sn div")?.textContent||"";
    const match=selected.match(/(\d+)\s*(?:of|\/)\s*\d+/i);
    if(match){const value=Number.parseInt(match[1],10);if(Number.isFinite(value)&&value>0)return value;}
  }
  return null;
}

function normalizeGalleryUrl(raw){
  try{
    const url=new URL(raw,location.href);
    const provider=providerForUrl(url.toString());
    if(provider==="nhentai"){
      const match=url.pathname.match(/^\/g\/(\d+)(?:\/\d+)?\/?$/);
      if(match){url.pathname=`/g/${match[1]}/`;url.search="";url.hash="";}
      return url.toString();
    }
    if(provider==="ehentai"||provider==="exhentai"){
      const direct=url.pathname.match(/^\/g\/(\d+)\/([^/]+)\/?$/);
      if(direct){url.pathname=`/g/${direct[1]}/${direct[2]}/`;url.search="";url.hash="";return url.toString();}
      const galleryLink=Array.from(document.querySelectorAll('a[href*="/g/"]')).map(a=>a.href).find(href=>{
        try{return providerForUrl(href)===provider&&/^\/g\/\d+\/[^/]+\/?$/.test(new URL(href).pathname);}catch{return false;}
      });
      if(galleryLink) return normalizeGalleryUrl(galleryLink);
    }
    url.hash="";
    return url.toString();
  }catch{return raw;}
}
function currentPageImage(){
  const provider=providerForUrl();
  if(provider==="nhentai") return document.querySelector('#image-container img')?.src||null;
  if(provider==="ehentai"||provider==="exhentai") return document.querySelector('#img')?.src||document.querySelector('#i3 img')?.src||null;
  return document.querySelector('main img')?.src||null;
}
function sortImages(){
  state.images.sort((a,b)=>{
    const ap=Number.isFinite(a.pageNumber)?a.pageNumber:Number.POSITIVE_INFINITY;
    const bp=Number.isFinite(b.pageNumber)?b.pageNumber:Number.POSITIVE_INFINITY;
    return ap-bp||(a.addedOrder||0)-(b.addedOrder||0);
  });
}
async function save(){await chrome.storage.local.set({[STORAGE_KEY]:state});}
function readMetadata(){
  const provider=providerForUrl();
  if(provider==="ehentai"||provider==="exhentai") return readEHMetadata();
  const title=(document.querySelector("#info h1")?.textContent||document.querySelector("h1.title")?.textContent||document.querySelector("main h1")?.textContent||document.title).trim();
  const tags=[];
  document.querySelectorAll("#tags .tag-container").forEach(container=>{
    const rawLabel=Array.from(container.childNodes).find(node=>node.nodeType===Node.TEXT_NODE)?.textContent||"";
    const label=rawLabel.replace(":","").trim().toLowerCase();
    container.querySelectorAll("a.tagchip .name, a.tag .name").forEach(node=>{
      const name=(node.textContent||"").trim();
      if(name) tags.push({category:normalizeCategory(label),name});
    });
  });
  return {title,sourceUrl:normalizeGalleryUrl(location.href),provider,tags:dedupeTags(tags)};
}
function readEHMetadata(){
  const title=(document.querySelector("#gn")?.textContent||document.querySelector("#gj")?.textContent||document.querySelector("h1")?.textContent||document.title).trim();
  const tags=[];
  document.querySelectorAll("tr").forEach(row=>{
    const categoryCell=row.querySelector("td.tc");
    if(!categoryCell) return;
    const namespace=(categoryCell.textContent||"").replace(":","").trim().toLowerCase();
    row.querySelectorAll("td:nth-child(2) a").forEach(link=>{
      const name=(link.textContent||"").trim();
      if(name) tags.push({category:normalizeCategory(namespace),name});
    });
  });
  return {title,sourceUrl:normalizeGalleryUrl(location.href),provider:providerForUrl(),tags:dedupeTags(tags)};
}
function normalizeCategory(value){
  const map={
    characters:"character",character:"character",
    parodies:"copyright",parody:"copyright",
    artists:"artist",artist:"artist",
    groups:"artist",group:"artist",
    tags:"general",tag:"general"
  };
  return map[value]||"general";
}
function dedupeTags(tags){const seen=new Set();return tags.filter(t=>{const k=`${t.category}:${t.name}`.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});}
async function submit(){
  if(!state.images.length){status("Add at least one image.",true);return;}
  const inferredSource=normalizeGalleryUrl(state.metadata?.sourceUrl||state.images.find(item=>item.sourceUrl)?.sourceUrl||location.href);
  const metadata=state.metadata?{...state.metadata,sourceUrl:inferredSource}:null;
  status("Sending…");
  const response=await chrome.runtime.sendMessage({type:"submit-nh-pool",payload:{url:inferredSource,site:"collection",mediaUrls:state.images.map(item=>item.url),mediaTypes:state.images.map(()=>"image"),mediaPageNumbers:state.images.map(item=>Number.isFinite(item.pageNumber)?item.pageNumber:null),collectionMetadata:metadata}});
  if(!response?.ok){status(response?.error||"Desktop app did not accept the collection.",true);return;}
  state={images:[],metadata:null}; await save(); render();
}
function status(text,error=false){const el=box?.querySelector("[data-status]");if(el){el.textContent=text;el.style.color=error?"#ff8b8b":"#9fe6b8";}}
function render(){
  if(!box){
    box=document.createElement("div");box.id="gallery-nh-pool";
    box.style.cssText="position:fixed;right:12px;top:12px;z-index:2147483647;width:320px;max-height:70vh;overflow:auto;background:#111;color:#eee;border:1px solid #555;border-radius:10px;padding:10px;font:13px/1.35 Arial,sans-serif;box-shadow:0 8px 30px #000a";
    document.documentElement.appendChild(box);
  }
  box.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><strong>Gallery image pool</strong><span>${state.images.length} image${state.images.length===1?"":"s"}</span></div>
  <div style="margin:7px 0;color:#aaa">${state.metadata?`Metadata: ${escapeHtml(state.metadata.title||"saved")}`:"No metadata saved"}</div>
  <div style="max-height:220px;overflow:auto">${state.images.map((item,i)=>`<div style="display:flex;gap:6px;margin:4px 0;align-items:center"><img src="${escapeAttr(item.url)}" style="width:42px;height:56px;object-fit:cover;border-radius:4px"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Number.isFinite(item.pageNumber)?`Page ${item.pageNumber}`:`Item ${i+1}`} · ${escapeHtml(item.url)}</span><button data-remove="${i}">×</button></div>`).join("")||"<em>Right-click an image or use Add page.</em>"}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px"><button data-add-page>Add page</button><button data-meta>Add metadata</button><button data-clear-meta>Clear metadata</button><button data-clear style="grid-column:1/-1">Clear images</button><button data-submit style="grid-column:1/-1;font-weight:bold">Submit to app</button></div><div data-status style="margin-top:6px;min-height:18px"></div>`;
  box.querySelectorAll("button").forEach(b=>b.style.cssText="background:#2b2b2b;color:#fff;border:1px solid #666;border-radius:5px;padding:5px;cursor:pointer");
  box.querySelector("[data-add-page]").onclick=async()=>{const image=currentPageImage();if(!image){status("No page image found.",true);return;}await addImage(image,readCurrentPageNumber(),location.href);status("Current page added.");};
  box.querySelector("[data-meta]").onclick=async()=>{state.metadata=readMetadata();await save();render();status(`Saved ${state.metadata.tags.length} tags.`);};
  box.querySelector("[data-clear-meta]").onclick=async()=>{state.metadata=null;await save();render();};
  box.querySelector("[data-clear]").onclick=async()=>{state.images=[];await save();render();};
  box.querySelector("[data-submit]").onclick=()=>submit().catch(e=>status(e.message,true));
  box.querySelectorAll("[data-remove]").forEach(btn=>btn.onclick=async()=>{state.images.splice(Number(btn.dataset.remove),1);await save();render();});
}
function escapeHtml(v){return String(v).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
function escapeAttr(v){return escapeHtml(v).replace(/"/g,"&quot;");}
