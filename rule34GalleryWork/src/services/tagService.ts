export { listTagCategories, listTagsForCategory } from "@/providers/tagProvider";
import { addMediaTag, listMediaTags, removeMediaTag, type TagRecord } from "@/providers/tagProvider";
export type { TagRecord };
export const getMediaTags=listMediaTags;
export async function createMediaTag(mediaId:number,name:string,category=""){
  if(!name.trim()||!category.trim()) throw new Error("Category and tag name are required.");
  return addMediaTag(mediaId,name.trim(),category.trim());
}
export const deleteMediaTag=removeMediaTag;
