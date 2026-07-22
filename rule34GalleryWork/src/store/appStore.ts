import { create } from "zustand";
import type { MediaRecord } from "@/types/media";
type LibraryStatus = "loading" | "unconfigured" | "ready" | "error";
interface AppStore {
 libraryPath:string|null; libraryStatus:LibraryStatus; libraryError:string|null;
 selectedMedia:MediaRecord|null; selectedIds:number[]; selectionAnchorId:number|null; galleryMedia:MediaRecord[]; search:string; addedFrom:string; addedTo:string; libraryVersion:number; viewerOpen:boolean;
 setLibraryPath:(v:string|null)=>void; setLibraryStatus:(v:LibraryStatus)=>void; setLibraryError:(v:string|null)=>void;
 setSelectedMedia:(v:MediaRecord|null)=>void; setSelectedMediaSelection:(media:MediaRecord|null,ids:number[])=>void; setGalleryMedia:(v:MediaRecord[])=>void; selectGalleryItem:(media:MediaRecord,ctrl:boolean,shift:boolean)=>void; clearSelection:()=>void;
 setSearch:(v:string)=>void; setAddedFrom:(v:string)=>void; setAddedTo:(v:string)=>void; bumpLibraryVersion:()=>void; setViewerOpen:(v:boolean)=>void;
}
export const useAppStore=create<AppStore>((set)=>({
 libraryPath:null,libraryStatus:"loading",libraryError:null,selectedMedia:null,selectedIds:[],selectionAnchorId:null,galleryMedia:[],search:"",addedFrom:"",addedTo:"",libraryVersion:0,viewerOpen:false,
 setLibraryPath:libraryPath=>set({libraryPath}),setLibraryStatus:libraryStatus=>set({libraryStatus}),setLibraryError:libraryError=>set({libraryError}),
 setSelectedMedia:selectedMedia=>set({selectedMedia,selectedIds:selectedMedia?[selectedMedia.id]:[],selectionAnchorId:selectedMedia?.id??null}),setSelectedMediaSelection:(selectedMedia,selectedIds)=>set({selectedMedia,selectedIds,selectionAnchorId:selectedMedia?.id??(selectedIds.length?selectedIds[selectedIds.length-1]:null)}),setGalleryMedia:galleryMedia=>set(state=>{
  const selectedMedia=state.selectedMedia?galleryMedia.find(item=>item.id===state.selectedMedia?.id)??state.selectedMedia:null;
  return{galleryMedia,selectedMedia};
 }),
 selectGalleryItem:(media,ctrl,shift)=>set(state=>{
  if(shift){
   const anchorId=state.selectionAnchorId;
   if(anchorId===null)return{selectedIds:state.selectedIds.includes(media.id)?state.selectedIds:[...state.selectedIds,media.id],selectedMedia:media,selectionAnchorId:media.id};
   const anchorIndex=state.galleryMedia.findIndex(item=>item.id===anchorId);
   const clickedIndex=state.galleryMedia.findIndex(item=>item.id===media.id);
   if(anchorIndex<0||clickedIndex<0)return{selectedIds:state.selectedIds.includes(media.id)?state.selectedIds:[...state.selectedIds,media.id],selectedMedia:media};
   const start=Math.min(anchorIndex,clickedIndex);
   const end=Math.max(anchorIndex,clickedIndex);
   const rangeIds=state.galleryMedia.slice(start,end+1).map(item=>item.id);
   const selected=new Set(state.selectedIds);
   rangeIds.forEach(id=>selected.add(id));
   return{selectedIds:Array.from(selected),selectedMedia:media};
  }
  if(ctrl){
   const has=state.selectedIds.includes(media.id);
   const ids=has?state.selectedIds.filter(id=>id!==media.id):[...state.selectedIds,media.id];
   const selectedMedia=ids.length?(has?(state.galleryMedia.find(item=>item.id===ids[ids.length-1])??media):media):null;
   return{selectedIds:ids,selectedMedia,selectionAnchorId:media.id};
  }
  return{selectedIds:[media.id],selectedMedia:media,selectionAnchorId:media.id};
 }),
 clearSelection:()=>set({selectedIds:[],selectedMedia:null,selectionAnchorId:null}),setSearch:search=>set({search}),setAddedFrom:addedFrom=>set({addedFrom}),setAddedTo:addedTo=>set({addedTo}),
 bumpLibraryVersion:()=>set(s=>({libraryVersion:s.libraryVersion+1})),setViewerOpen:viewerOpen=>set({viewerOpen})
}));
