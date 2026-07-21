import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/appStore";
import { syncMobileQueue } from "@/tauri/mobileQueueApi";
import TopBar from "../components/TopBar";
import StatusBar from "../components/StatusBar";
import Inspector from "@/features/viewer/Inspector";
import MediaViewer from "@/features/viewer/MediaViewer";

const DEFAULT_INSPECTOR_WIDTH=360, MIN_INSPECTOR_WIDTH=280, MIN_GALLERY_WIDTH=360;
const WIDTH_STORAGE_KEY="rule34-library.inspector-width";

export default function MainLayout(){
  const contentRef=useRef<HTMLDivElement>(null);
  const location=useLocation();
  const bumpLibraryVersion=useAppStore(s=>s.bumpLibraryVersion);
  const libraryStatus=useAppStore(s=>s.libraryStatus);
  const [inspectorWidth,setInspectorWidth]=useState(()=>{const saved=Number(localStorage.getItem(WIDTH_STORAGE_KEY));return Number.isFinite(saved)&&saved>=MIN_INSPECTOR_WIDTH?saved:DEFAULT_INSPECTOR_WIDTH;});
  const [isResizing,setIsResizing]=useState(false);
  const stopResizing=useCallback(()=>setIsResizing(false),[]);

  useEffect(()=>{if(!isResizing)return;const resize=(event:PointerEvent)=>{const bounds=contentRef.current?.getBoundingClientRect();if(!bounds)return;const maxWidth=Math.max(MIN_INSPECTOR_WIDTH,bounds.width-MIN_GALLERY_WIDTH);setInspectorWidth(Math.min(maxWidth,Math.max(MIN_INSPECTOR_WIDTH,bounds.right-event.clientX)));};document.body.classList.add("is-resizing-inspector");window.addEventListener("pointermove",resize);window.addEventListener("pointerup",stopResizing);window.addEventListener("pointercancel",stopResizing);return()=>{document.body.classList.remove("is-resizing-inspector");window.removeEventListener("pointermove",resize);window.removeEventListener("pointerup",stopResizing);window.removeEventListener("pointercancel",stopResizing);};},[isResizing,stopResizing]);
  useEffect(()=>{localStorage.setItem(WIDTH_STORAGE_KEY,String(inspectorWidth));window.dispatchEvent(new CustomEvent("gallery-layout-change"));},[inspectorWidth]);
  useEffect(()=>{let unlisten:(()=>void)|undefined;void listen("library-changed",()=>bumpLibraryVersion()).then(dispose=>{unlisten=dispose;});return()=>unlisten?.();},[bumpLibraryVersion]);
  useEffect(()=>{if(libraryStatus!=="ready")return;void syncMobileQueue().then(r=>{if(r.imported)bumpLibraryVersion();}).catch(()=>undefined);},[libraryStatus,bumpLibraryVersion]);

  return <div className="appShell"><div className="appWorkspace"><TopBar/><div ref={contentRef} className="contentSplit"><main className={`galleryPane ${location.pathname==="/"?"galleryRoute":location.pathname.startsWith("/boards/")?"boardRoute":"settingsRoute"}`}><Outlet/></main><div className="inspectorResizeHandle" role="separator" aria-label="Resize inspector" aria-orientation="vertical" aria-valuemin={MIN_INSPECTOR_WIDTH} aria-valuenow={Math.round(inspectorWidth)} tabIndex={0} onPointerDown={e=>{e.preventDefault();setIsResizing(true);}} onDoubleClick={()=>setInspectorWidth(DEFAULT_INSPECTOR_WIDTH)} onKeyDown={e=>{if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;e.preventDefault();setInspectorWidth(w=>Math.max(MIN_INSPECTOR_WIDTH,w+(e.key==="ArrowLeft"?20:-20)));}}/><div className="inspectorPane" style={{width:inspectorWidth}}><Inspector/></div></div><StatusBar/><MediaViewer/></div></div>;
}
