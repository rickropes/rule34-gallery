import { loadBoards } from "@/services/boardService";

export type BoardSearchFilter = { boardId: string; boardName: string; negated: boolean };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseBoardSearch(search: string): { search: string; filters: BoardSearchFilter[] } {
  let remaining = search;
  const filters: BoardSearchFilter[] = [];
  const boards = loadBoards().slice().sort((a, b) => b.name.length - a.name.length);

  for (const board of boards) {
    const name = escapeRegExp(board.name.trim());
    if (!name) continue;
    // Accept board:Name, -board:Name, "board:Name", and -"board:Name".
    // Board names are matched from local storage, so spaces do not require quotes.
    const pattern = new RegExp(`(^|\\s)(-?)(?:"board:${name}"|board:${name})(?=\\s|$)`, "i");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(remaining))) {
      filters.push({ boardId: board.id, boardName: board.name, negated: match[2] === "-" });
      remaining = `${remaining.slice(0, match.index)}${match[1]}${remaining.slice(match.index + match[0].length)}`;
    }
  }

  return { search: remaining.replace(/\s+/g, " ").trim(), filters };
}

export type BoardMediaMembership = { mediaIds: Set<number>; collectionIds: Set<number> };

export function mediaMembershipForBoard(boardId: string): BoardMediaMembership {
  const board = loadBoards().find((candidate) => candidate.id === boardId);
  const mediaIds = new Set<number>();
  const collectionIds = new Set<number>();

  for (const item of board?.items ?? []) {
    if (item.kind !== "media") continue;
    if (typeof item.mediaId === "number") mediaIds.add(item.mediaId);
    // Comic board items represent the whole collection in gallery search, even
    // when the placed board page is not the collection's initial media record.
    if (typeof item.collectionId === "number") collectionIds.add(item.collectionId);
  }

  return { mediaIds, collectionIds };
}
