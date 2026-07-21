import type { MediaPage, MediaRecord } from "@/types/media";
import { listMedia } from "@/tauri/mediaApi";
import { mediaMembershipForBoard, parseBoardSearch } from "@/services/boardSearch";

export interface MediaProvider { listMedia(search?:string,addedFrom?:string,addedTo?:string,offset?:number,limit?:number):Promise<MediaPage> }

const FETCH_SIZE = 250;

async function listBoardFilteredMedia(search:string, addedFrom:string, addedTo:string, offset:number, limit:number): Promise<MediaPage> {
  const parsed = parseBoardSearch(search);
  if (parsed.filters.length === 0) return listMedia(search, addedFrom, addedTo, offset, limit);

  const boardSets = parsed.filters.map((filter) => ({ ...filter, membership: mediaMembershipForBoard(filter.boardId) }));
  const matchesBoards = (media: MediaRecord) => boardSets.every((filter) => {
    const inside = filter.membership.mediaIds.has(media.id)
      || (typeof media.collectionId === "number" && filter.membership.collectionIds.has(media.collectionId));
    return filter.negated ? !inside : inside;
  });

  const filtered: MediaRecord[] = [];
  let sourceOffset = 0;
  let sourceTotal = 0;
  do {
    const page = await listMedia(parsed.search, addedFrom, addedTo, sourceOffset, FETCH_SIZE);
    sourceTotal = page.total;
    filtered.push(...page.items.filter(matchesBoards));
    sourceOffset += page.items.length;
    if (page.items.length === 0) break;
  } while (sourceOffset < sourceTotal);

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
  };
}

export const mediaProvider:MediaProvider={listMedia:listBoardFilteredMedia};
