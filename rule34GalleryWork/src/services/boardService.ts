import type { BoardRecord } from "@/types/board";
import type { MediaRecord } from "@/types/media";

const KEY = "rule34-library.boards.v1";

let sharedStorageReady = false;
let sharedWriteChain: Promise<void> = Promise.resolve();

function normalizeBoards(value: unknown): BoardRecord[] {
  if (!Array.isArray(value)) return [];
  return (value as BoardRecord[]).map((board) => ({
    ...board,
    items: Array.isArray(board.items) ? board.items : [],
    viewport: board.viewport && Number.isFinite(board.viewport.x) && Number.isFinite(board.viewport.y) && Number.isFinite(board.viewport.zoom)
      ? board.viewport
      : { x: 0, y: 0, zoom: 1 },
  }));
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function persistSharedBoards(json: string) {
  if (!sharedStorageReady) return;
  sharedWriteChain = sharedWriteChain
    .catch(() => undefined)
    .then(() => invokeTauri<void>("save_boards_json", { json }))
    .catch((error) => console.error("Failed to save shared boards", error));
}

export async function initializeBoardStorage(): Promise<void> {
  if (sharedStorageReady) return;
  try {
    const sharedJson = await invokeTauri<string | null>("load_boards_json");
    if (sharedJson) {
      const boards = normalizeBoards(JSON.parse(sharedJson));
      localStorage.setItem(KEY, JSON.stringify(boards));
    } else {
      const localJson = localStorage.getItem(KEY);
      if (localJson) {
        const boards = normalizeBoards(JSON.parse(localJson));
        await invokeTauri<void>("save_boards_json", { json: JSON.stringify(boards) });
      }
    }
  } catch (error) {
    // Browser-only development still works with localStorage.
    console.warn("Shared board storage unavailable; using localStorage", error);
  } finally {
    sharedStorageReady = true;
  }
}

export const BOARDS_CHANGED = "rule34-library.boards-changed";

export function loadBoards(): BoardRecord[] {
  try {
    return normalizeBoards(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return [];
  }
}

export function saveBoards(boards: BoardRecord[]) {
  const json = JSON.stringify(normalizeBoards(boards));
  localStorage.setItem(KEY, json);
  persistSharedBoards(json);
  window.dispatchEvent(new Event(BOARDS_CHANGED));
}

export function createBoard(name: string) {
  const now = new Date().toISOString();
  const board: BoardRecord = {
    id: crypto.randomUUID(),
    name: name.trim() || "Untitled board",
    archived: false,
    createdAt: now,
    updatedAt: now,
    items: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  saveBoards([...loadBoards(), board]);
  return board;
}

export function updateBoard(board: BoardRecord) {
  saveBoards(loadBoards().map((candidate) => candidate.id === board.id
    ? { ...board, updatedAt: new Date().toISOString() }
    : candidate));
}

export function duplicateBoard(id: string) {
  const boards = loadBoards();
  const source = boards.find((board) => board.id === id);
  if (!source) return null;
  const now = new Date().toISOString();
  const copy: BoardRecord = {
    ...source,
    id: crypto.randomUUID(),
    name: `${source.name} copy`,
    archived: false,
    createdAt: now,
    updatedAt: now,
    viewport: source.viewport ? { ...source.viewport } : { x: 0, y: 0, zoom: 1 },
    items: source.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
  };
  saveBoards([...boards, copy]);
  return copy;
}

export function setBoardArchived(id: string, archived: boolean) {
  saveBoards(loadBoards().map((board) => board.id === id
    ? { ...board, archived, updatedAt: new Date().toISOString() }
    : board));
}

export function addMediaToBoard(boardId: string, mediaRecords: MediaRecord[]) {
  const boards = loadBoards();
  const board = boards.find((candidate) => candidate.id === boardId);
  if (!board) return;

  const existing = new Set(board.items.filter((item) => item.kind === "media").map((item) => item.mediaId));
  const fresh = mediaRecords.filter((media) => !existing.has(media.id));
  const start = board.items.length;

  board.items.push(...fresh.map((media, index) => {
    const aspectRatio = media.width && media.height && media.width > 0 && media.height > 0
      ? media.width / media.height
      : 1;
    const width = 220;
    return {
      id: crypto.randomUUID(),
      kind: "media" as const,
      mediaId: media.id,
      collectionId: media.collectionId ?? undefined,
      pageIndex: media.collectionId ? 0 : undefined,
      x: ((start + index) % 4) * 260,
      y: Math.floor((start + index) / 4) * 240,
      width,
      height: width / aspectRatio,
      aspectRatio,
      rotation: 0,
    };
  }));

  board.updatedAt = new Date().toISOString();
  saveBoards(boards);
}
