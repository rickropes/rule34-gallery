import { invoke } from "@tauri-apps/api/core";
export interface TagRecord { id:number; name:string; category:string }
export const listMediaTags=(mediaId:number)=>invoke<TagRecord[]>("list_media_tags",{mediaId});
export const addMediaTag=(mediaId:number,tagName:string,category:string)=>invoke<TagRecord>("add_media_tag",{mediaId,tagName,category});
export const removeMediaTag=(mediaId:number,tagId:number)=>invoke<void>("remove_media_tag",{mediaId,tagId});
export const listTagCategories=()=>invoke<string[]>("list_tag_categories");
export const listTagsForCategory=(category:string)=>invoke<TagRecord[]>("list_tags_for_category",{category});
export const addTagToMedia=(mediaIds:number[],tagName:string,category:string)=>invoke<TagRecord>("add_tag_to_media",{mediaIds,tagName,category});
