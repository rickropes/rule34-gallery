import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Heart, Play, Check, BookOpen, LayoutDashboard, Combine, Images, BookPlus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { MediaRecord } from "@/types/media";
import { getMediaUrl } from "@/services/mediaService";
import {addMediaToBoard,BOARDS_CHANGED,loadBoards} from "@/services/boardService";
import type {BoardRecord} from "@/types/board";
import { addImagesToComic, createComicFromImages, deleteMedia, mergeComicPages, mergeComicsIntoFirst, mergeMediaImages } from "@/tauri/mediaApi";
import { ask, message } from "@tauri-apps/plugin-dialog";

export default function MediaCard({ media }: { media: MediaRecord }) {
  const selected = useAppStore((state) => state.selectedIds.includes(media.id));
  const selectedIds = useAppStore((state) => state.selectedIds);
  const galleryMedia = useAppStore((state) => state.galleryMedia);
  const selectGalleryItem = useAppStore((state) => state.selectGalleryItem);
  const clearSelection = useAppStore((state) => state.clearSelection);
  const bumpLibraryVersion = useAppStore((state) => state.bumpLibraryVersion);
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
  const [working,setWorking]=useState(false);
  const [boards,setBoards]=useState<BoardRecord[]>(()=>loadBoards().filter(b=>!b.archived));
  useEffect(()=>{const refresh=()=>setBoards(loadBoards().filter(b=>!b.archived));window.addEventListener(BOARDS_CHANGED,refresh);return()=>window.removeEventListener(BOARDS_CHANGED,refresh)},[]);
  useEffect(()=>{const close=()=>setMenu(null);window.addEventListener('pointerdown',close);return()=>window.removeEventListener('pointerdown',close)},[]);
  const title = media.originalFilename ?? media.storedFilename;
  const url = getMediaUrl(media.filePath);
  const sendIds=selected?selectedIds:[media.id];
  const sendMedia=sendIds.map(id=>galleryMedia.find(item=>item.id===id)).filter((item):item is MediaRecord=>Boolean(item));
  const comics=sendMedia.filter(item=>item.collectionId!==null&&item.collectionPageCount>0);
  const images=sendMedia.filter(item=>item.mediaType==="image"&&item.collectionId===null);
  const onlyImages=images.length>=2&&images.length===sendMedia.length;
  const singleComic=comics.length===1&&sendMedia.length===1;
  const onlyComics=comics.length>=2&&comics.length===sendMedia.length;
  const comicPlusImages=comics.length===1&&images.length>=1&&comics.length+images.length===sendMedia.length;

  async function refreshAll(){ clearSelection(); bumpLibraryVersion(); window.dispatchEvent(new Event("rule34-library:force-gallery-refresh")); }
  async function maybeDelete(ids:number[],text:string,titleText:string){
    const remove=await ask(text,{title:titleText,kind:"info",okLabel:"Remove originals",cancelLabel:"Keep originals"});
    if(remove){await deleteMedia(ids); bumpLibraryVersion(); window.dispatchEvent(new Event("rule34-library:force-gallery-refresh"));}
  }
  async function run(action:()=>Promise<void>,titleText:string){setWorking(true);setMenu(null);try{await action();await refreshAll();}catch(e){await message(String(e),{title:`${titleText} failed`,kind:"error"});}finally{setWorking(false)}}

  const createComic=()=>run(async()=>{const ids=images.map(x=>x.id);await createComicFromImages(ids);await maybeDelete(ids,"Comic created. Remove the original standalone images?","Create Comic");},"Create Comic");
  const mergeImages=()=>run(async()=>{const ids=images.map(x=>x.id);await mergeMediaImages(ids);await maybeDelete(ids,"Merged image created. Remove the original standalone images?","Merge Images");},"Merge Images");
  const mergePages=()=>run(async()=>{const comic=comics[0];await mergeComicPages(comic.collectionId!);await maybeDelete([comic.id],"Merged image created. Remove the original comic and all of its pages?","Merge Comic Pages");},"Merge Comic Pages");
  const mergeComics=()=>run(async()=>{const ordered=[...new Set(comics.map(x=>x.collectionId!))];await mergeComicsIntoFirst(ordered);const donorCovers=comics.slice(1).map(x=>x.id);await maybeDelete(donorCovers,"Pages were copied into the first selected comic. Remove the original donor comics?","Merge Comics");},"Merge Comics");
  const addToComic=()=>run(async()=>{const ids=images.map(x=>x.id);await addImagesToComic(comics[0].collectionId!,ids);await maybeDelete(ids,"Images were added as comic pages. Remove the original standalone images?","Add to Comic");},"Add to Comic");

  return <>
    <button className={`mediaCard ${selected ? "selected" : ""}`} title={title} aria-label={`Select ${title}`}
      onClick={(event) => selectGalleryItem(media, event.ctrlKey || event.metaKey, event.shiftKey)}
      onContextMenu={e=>{e.preventDefault();e.stopPropagation();if(!selected)selectGalleryItem(media,false,false);setMenu({x:e.clientX,y:e.clientY});}}>
      <div className="thumb">
        {media.mediaType === "image" ? <img key={`${media.id}-${media.hash}`} src={url} alt={title} loading="lazy" /> : <video key={`${media.id}-${media.hash}`} src={url} muted preload="metadata" />}
        {media.mediaType === "video" && (media.isAnimatedGif ? <span className="mediaTypeBadge gifBadge">GIF</span> : <span className="mediaTypeBadge playBadge" aria-hidden="true"><Play size={17} fill="currentColor" /></span>)}
        {media.collectionPageCount > 0 && <span className="mediaTypeBadge collectionBadge"><BookOpen size={17} /><b>{media.collectionPageCount}</b></span>}
        {media.favorite && <Heart className="favorite" fill="currentColor" />}
        {selected && <span className="selectionMark"><Check size={15} /></span>}
      </div>
    </button>
    {menu&&createPortal(<div className="contextMenu boardSendMenu" style={{left:menu.x,top:menu.y}} onPointerDown={e=>e.stopPropagation()}>
      {onlyImages&&<>
        <button disabled={working} onClick={()=>void createComic()}><Images size={15}/> Create Comic ({images.length} pages)</button>
        <button disabled={working} onClick={()=>void mergeImages()}><Combine size={15}/> Merge Images</button>
      </>}
      {singleComic&&<button disabled={working} onClick={()=>void mergePages()}><Combine size={15}/> Merge Comic Pages</button>}
      {onlyComics&&<button disabled={working} onClick={()=>void mergeComics()}><Combine size={15}/> Merge Into First Comic</button>}
      {comicPlusImages&&<button disabled={working} onClick={()=>void addToComic()}><BookPlus size={15}/> Add to Comic</button>}
      {(onlyImages||singleComic||onlyComics||comicPlusImages)&&<div className="contextMenuDivider"/>}
      <div className="contextMenuTitle"><LayoutDashboard size={15}/> Send to Board</div>{boards.length?boards.map(b=><button key={b.id} onClick={()=>{addMediaToBoard(b.id,sendMedia);setMenu(null)}}>{b.name}</button>):<span>No active boards</span>}
    </div>,document.body)}
  </>;
}
