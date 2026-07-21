import type { MediaPage } from "@/types/media";
import { listMedia } from "@/tauri/mediaApi";
export interface MediaProvider { listMedia(search?:string,addedFrom?:string,addedTo?:string,offset?:number,limit?:number):Promise<MediaPage> }
export const mediaProvider:MediaProvider={listMedia};
