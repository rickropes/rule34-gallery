import { create } from "zustand";
import type { MediaRecord } from "@/types/media";
type LibraryStatus = "loading" | "unconfigured" | "ready" | "error";
interface AppStore {
 libraryPath:string|null; libraryStatus:LibraryStatus; libraryError:string|null;
 selectedMedia:MediaRecord|null; selectedIds:number[]; search:string; addedFrom:string; addedTo:string; libraryVersion:number; viewerOpen:boolean;
 setLibraryPath:(v:string|null)=>void; setLibraryStatus:(v:LibraryStatus)=>void; setLibraryError:(v:string|null)=>void;
 setSelectedMedia:(v:MediaRecord|null)=>void; toggleSelected:(media:MediaRecord,additive:boolean)=>void; clearSelection:()=>void;
 setSearch:(v:string)=>void; setAddedFrom:(v:string)=>void; setAddedTo:(v:string)=>void; bumpLibraryVersion:()=>void; setViewerOpen:(v:boolean)=>void;
}
export const useAppStore=create<AppStore>((set)=>({
 libraryPath:null,libraryStatus:"loading",libraryError:null,selectedMedia:null,selectedIds:[],search:"",addedFrom:"",addedTo:"",libraryVersion:0,viewerOpen:false,
 setLibraryPath:libraryPath=>set({libraryPath}),setLibraryStatus:libraryStatus=>set({libraryStatus}),setLibraryError:libraryError=>set({libraryError}),
 setSelectedMedia:selectedMedia=>set({selectedMedia,selectedIds:selectedMedia?[selectedMedia.id]:[]}),
 toggleSelected:(media,additive)=>set(state=>{const has=state.selectedIds.includes(media.id);const ids=additive?(has?state.selectedIds.filter(id=>id!==media.id):[...state.selectedIds,media.id]):[media.id];return{selectedIds:ids,selectedMedia:ids.length?media:null};}),
 clearSelection:()=>set({selectedIds:[],selectedMedia:null}),setSearch:search=>set({search}),setAddedFrom:addedFrom=>set({addedFrom}),setAddedTo:addedTo=>set({addedTo}),
 bumpLibraryVersion:()=>set(s=>({libraryVersion:s.libraryVersion+1})),setViewerOpen:viewerOpen=>set({viewerOpen})
}));
