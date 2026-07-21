import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Link as LinkIcon, Upload, CalendarDays, Smartphone } from "lucide-react";
import { selectAndImportMedia } from "@/services/importService";
import { importMediaUrl, listSearchSuggestions } from "@/tauri/mediaApi";
import { syncMobileQueue } from "@/tauri/mobileQueueApi";
import { useAppStore } from "@/store/appStore";

function activeSearchToken(value: string) {
  const match = value.match(/(?:^|\s)(-?"?[^^\s"]*)$/);
  return match?.[1] ?? "";
}

export default function TopBar() {
  const search=useAppStore(s=>s.search), setSearch=useAppStore(s=>s.setSearch);
  const from=useAppStore(s=>s.addedFrom), to=useAppStore(s=>s.addedTo);
  const setFrom=useAppStore(s=>s.setAddedFrom), setTo=useAppStore(s=>s.setAddedTo), bump=useAppStore(s=>s.bumpLibraryVersion);
  const [showUrl,setShowUrl]=useState(false), [url,setUrl]=useState(""), [tags,setTags]=useState("");
  const [busy,setBusy]=useState(false), [message,setMessage]=useState<string|null>(null);
  const [suggestions,setSuggestions]=useState<string[]>([]), [showSuggestions,setShowSuggestions]=useState(false);
  const searchWrap=useRef<HTMLDivElement>(null);
  const token=useMemo(()=>activeSearchToken(search),[search]);

  useEffect(()=>{
    const id=window.setTimeout(async()=>{
      const plain=token.replace(/^-/,"").replace(/^"/,"");
      if(!plain){setSuggestions([]);return;}
      try{setSuggestions(await listSearchSuggestions(plain));}catch{setSuggestions([]);}
    },120);
    return()=>window.clearTimeout(id);
  },[token]);

  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(!searchWrap.current?.contains(event.target as Node))setShowSuggestions(false);};
    window.addEventListener("pointerdown",close);
    return()=>window.removeEventListener("pointerdown",close);
  },[]);

  function chooseSuggestion(value:string){
    const negated=token.startsWith("-");
    const replacement=`${negated?"-":""}"${value}"`;
    setSearch(search.slice(0,Math.max(0,search.length-token.length))+replacement+" ");
    setShowSuggestions(false);
  }

  async function importFiles(){setBusy(true);setMessage(null);try{const r=await selectAndImportMedia();if(r){setMessage(`${r.importedCount} imported, ${r.skippedCount} skipped`);bump();}}catch(e){setMessage(String(e));}finally{setBusy(false);}}
  async function importUrl(){if(!url.trim())return;setBusy(true);setMessage("Queued download…");try{const r=await importMediaUrl(url,tags.split(/[,\n]/).map(x=>x.trim()).filter(Boolean));setMessage(`${r.importedCount} imported, ${r.skippedCount} skipped`);setUrl("");setTags("");bump();}catch(e){setMessage(String(e));}finally{setBusy(false);}}
  async function syncMobile(){setBusy(true);setMessage("Checking mobile queue…");try{const r=await syncMobileQueue();setMessage(`${r.imported} imported, ${r.failed} failed`);}catch(e){setMessage(String(e));}finally{setBusy(false);}}

  return <>
    <header className="topbar">
      <div className="searchWrap" ref={searchWrap}>
        <div className="searchBox"><Search size={17}/><input value={search} onFocus={()=>setShowSuggestions(true)} onChange={e=>{setSearch(e.target.value);setShowSuggestions(true);}} placeholder='Search tags, e.g. -"metadata:gif" bigSize:2000'/></div>
        {showSuggestions&&suggestions.length>0&&<div className="searchSuggestions">
          {suggestions.map(value=><button key={value} type="button" onPointerDown={e=>e.preventDefault()} onClick={()=>chooseSuggestion(value)}>{value.includes(":")?<><b>{value.split(":",1)[0]}</b>:{value.slice(value.indexOf(":")+1)}</>:<><b>{value}</b><span>category</span></>}</button>)}
        </div>}
      </div>
      <div className="dateFilters"><CalendarDays size={16}/><input type="date" value={from} onChange={e=>setFrom(e.target.value)} title="Added from"/><span>to</span><input type="date" value={to} onChange={e=>setTo(e.target.value)} title="Added to"/>{(from||to)&&<button onClick={()=>{setFrom("");setTo("");}}>Clear</button>}</div>
      <div className="topActions">
        <button onClick={()=>setShowUrl(v=>!v)}><LinkIcon size={16}/> Add URL</button>
        <button disabled={busy} onClick={()=>void syncMobile()}><Smartphone size={16}/> Mobile queue</button>
        <button className="primary" disabled={busy} onClick={()=>void importFiles()}><Upload size={16}/> Import files</button>
        <Link className="button" to="/settings">Settings</Link>
      </div>
    </header>
    {showUrl&&<div className="urlBar"><input value={url} onChange={e=>setUrl(e.target.value)} placeholder="Direct image/video URL"/><input value={tags} onChange={e=>setTags(e.target.value)} placeholder="Optional tags: category:name, category:name"/><button className="primary" disabled={busy||!url.trim()} onClick={()=>void importUrl()}>Queue & download</button></div>}
    {message&&<div className="notice" onClick={()=>setMessage(null)}>{message}</div>}
  </>;
}
