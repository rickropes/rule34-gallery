import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Heart, Play, Check, BookOpen, LayoutDashboard } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { MediaRecord } from "@/types/media";
import { getMediaUrl } from "@/services/mediaService";
import {addMediaToBoard,BOARDS_CHANGED,loadBoards} from "@/services/boardService";
import type {BoardRecord} from "@/types/board";

export default function MediaCard({ media }: { media: MediaRecord }) {
  const selected = useAppStore((state) => state.selectedIds.includes(media.id));
  const selectedIds = useAppStore((state) => state.selectedIds);
  const galleryMedia = useAppStore((state) => state.galleryMedia);
  const toggle = useAppStore((state) => state.toggleSelected);
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
  const [boards,setBoards]=useState<BoardRecord[]>(()=>loadBoards().filter(b=>!b.archived));
  useEffect(()=>{const refresh=()=>setBoards(loadBoards().filter(b=>!b.archived));window.addEventListener(BOARDS_CHANGED,refresh);return()=>window.removeEventListener(BOARDS_CHANGED,refresh)},[]);
  useEffect(()=>{const close=()=>setMenu(null);window.addEventListener('pointerdown',close);return()=>window.removeEventListener('pointerdown',close)},[]);
  const title = media.originalFilename ?? media.storedFilename;
  const url = getMediaUrl(media.filePath);
  const sendIds=selected?selectedIds:[media.id];
  const sendMedia=sendIds.map(id=>galleryMedia.find(item=>item.id===id)).filter((item):item is MediaRecord=>Boolean(item));

  return <>
    <button className={`mediaCard ${selected ? "selected" : ""}`} title={title} aria-label={`Select ${title}`}
      onClick={(event) => toggle(media, event.ctrlKey || event.metaKey || event.shiftKey)}
      onContextMenu={e=>{e.preventDefault();e.stopPropagation();if(!selected)toggle(media,false);setMenu({x:e.clientX,y:e.clientY});}}>
      <div className="thumb">
        {media.mediaType === "image" ? <img src={url} alt={title} loading="lazy" /> : <video src={url} muted preload="metadata" />}
        {media.mediaType === "video" && (media.isAnimatedGif ? <span className="mediaTypeBadge gifBadge">GIF</span> : <span className="mediaTypeBadge playBadge" aria-hidden="true"><Play size={17} fill="currentColor" /></span>)}
        {media.collectionPageCount > 0 && <span className="mediaTypeBadge collectionBadge"><BookOpen size={17} /><b>{media.collectionPageCount}</b></span>}
        {media.favorite && <Heart className="favorite" fill="currentColor" />}
        {selected && <span className="selectionMark"><Check size={15} /></span>}
      </div>
    </button>
    {menu&&createPortal(<div className="contextMenu boardSendMenu" style={{left:menu.x,top:menu.y}} onPointerDown={e=>e.stopPropagation()}><div className="contextMenuTitle"><LayoutDashboard size={15}/> Send to Board</div>{boards.length?boards.map(b=><button key={b.id} onClick={()=>{addMediaToBoard(b.id,sendMedia);setMenu(null)}}>{b.name}</button>):<span>No active boards</span>}</div>,document.body)}
  </>;
}
