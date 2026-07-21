import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { MediaPage } from "@/types/media";
export interface ImportMediaResult { importedCount:number; skippedCount:number; errors:string[] }
export interface ProcessMediaResult { processedCount:number; errors:string[] }
export async function ping(){return invoke<string>("ping")}
export async function listMedia(search="",addedFrom="",addedTo="",offset=0,limit=80){return invoke<MediaPage>("list_media",{search:search||null,addedFrom:addedFrom?`${addedFrom} 00:00:00`:null,addedTo:addedTo?`${addedTo} 23:59:59`:null,offset,limit})}
export async function importMediaFiles(paths:string[]){return invoke<ImportMediaResult>("import_media_files",{paths})}
export async function importMediaUrl(url:string,tags:string[]){return invoke<ImportMediaResult>("import_media_url",{url,tags})}
export async function deleteMedia(mediaIds:number[]){return invoke<number>("delete_media",{mediaIds})}
export async function processMedia(mediaIds:number[],operation:"half_size"|"quarter_size"|"remove_audio"){return invoke<ProcessMediaResult>("process_media",{mediaIds,operation})}
export async function mediaIdsWithAudio(mediaIds:number[]){return invoke<number[]>("media_ids_with_audio",{mediaIds})}
export async function trimVideo(mediaId:number,mode:"remove_start"|"remove_end",positionSeconds:number){return invoke<ProcessMediaResult>("trim_video",{mediaId,mode,positionSeconds})}
export function getMediaAssetUrl(filePath:string){return convertFileSrc(filePath)}

export async function listSearchSuggestions(query:string){return invoke<string[]>("list_search_suggestions",{query:query||null})}
export async function listCollectionPages(collectionId:number){return invoke<import("@/types/media").MediaRecord[]>("list_collection_pages",{collectionId})}
