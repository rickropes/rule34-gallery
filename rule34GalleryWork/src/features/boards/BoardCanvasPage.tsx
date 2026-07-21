import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bold, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Italic, Move, Play, Save, Trash2, Type, Underline } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { loadBoards, updateBoard } from "@/services/boardService";
import { useAppStore } from "@/store/appStore";
import { getMediaUrl } from "@/services/mediaService";
import { listCollectionPages, listMedia } from "@/tauri/mediaApi";
import type { MediaRecord } from "@/types/media";
import type { BoardItem, BoardRecord } from "@/types/board";

type ViewState = { x: number; y: number; zoom: number };
type PanState = { pointerId: number; startX: number; startY: number; viewX: number; viewY: number; moved: boolean };
type DragState = { pointerId: number; startX: number; startY: number; positions: Map<string, { x: number; y: number }> };
type MarqueeState = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
  canvasLeft: number;
  canvasTop: number;
};
type InsertMenu = { clientX: number; clientY: number; worldX: number; worldY: number };

const MIN_MEDIA_WIDTH = 80;
const DRAG_THRESHOLD = 4;
const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];

function mediaAspectRatio(media?: MediaRecord, item?: BoardItem) {
  // Prefer the media's known dimensions over an old board-item fallback. This
  // prevents videos imported before metadata was available from staying square.
  if (media?.width && media?.height && media.width > 0 && media.height > 0) return media.width / media.height;
  if (item?.aspectRatio && Number.isFinite(item.aspectRatio) && item.aspectRatio > 0) return item.aspectRatio;
  if (item?.width && item?.height && item.height > 0) return item.width / item.height;
  return 1;
}

function intersects(a: DOMRect, b: { left: number; top: number; right: number; bottom: number }) {
  return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

export default function BoardCanvasPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const gallery = useAppStore((state) => state.galleryMedia);
  const setSelectedMedia = useAppStore((state) => state.setSelectedMedia);
  const initial = useMemo(() => loadBoards().find((candidate) => candidate.id === id) ?? null, [id]);

  const [board, setBoard] = useState<BoardRecord | null>(initial);
  const [boardMedia, setBoardMedia] = useState<MediaRecord[]>(gallery);
  const [collectionPages, setCollectionPages] = useState<Record<number, MediaRecord[]>>({});
  const [view, setView] = useState<ViewState>(() => initial?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [insertMenu, setInsertMenu] = useState<InsertMenu | null>(null);
  const [fontSizeDrafts, setFontSizeDrafts] = useState<Record<string, number>>({});
  const [textRevision, setTextRevision] = useState(0);
  const pan = useRef<PanState | null>(null);
  const drag = useRef<DragState | null>(null);
  const itemElements = useRef(new Map<string, HTMLDivElement>());
  const textEditors = useRef(new Map<string, HTMLDivElement>());
  const textSelections = useRef(new Map<string, Range>());
  const pendingTextFocus = useRef<string | null>(null);
  const suppressNextContextMenu = useRef(false);
  const loadingCollections = useRef(new Set<number>());
  const boardRef = useRef<BoardRecord | null>(initial);
  const viewRef = useRef<ViewState>(initial?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const savedSnapshot = useRef("");
  const savedTextRevision = useRef(0);

  useEffect(() => {
    void listMedia("", "", "", 0, 10000)
      .then((page) => setBoardMedia(page.items))
      .catch(() => setBoardMedia(gallery));
  }, [gallery]);

  useEffect(() => {
    if (!board) return;
    const ids = new Set<number>();
    board.items.forEach((item) => {
      if (item.kind !== "media" || !item.mediaId) return;
      const media = boardMedia.find((candidate) => candidate.id === item.mediaId);
      const collectionId = item.collectionId ?? media?.collectionId ?? null;
      if (collectionId && !collectionPages[collectionId] && !loadingCollections.current.has(collectionId)) {
        ids.add(collectionId);
      }
    });
    ids.forEach((collectionId) => {
      loadingCollections.current.add(collectionId);
      void listCollectionPages(collectionId)
        .then((pages) => {
          setCollectionPages((current) => ({ ...current, [collectionId]: pages }));
          setBoardMedia((current) => {
            const byId = new Map(current.map((item) => [item.id, item]));
            pages.forEach((page) => byId.set(page.id, page));
            return [...byId.values()];
          });
        })
        .catch(() => setCollectionPages((current) => ({ ...current, [collectionId]: [] })))
        .finally(() => loadingCollections.current.delete(collectionId));
    });
  }, [board, boardMedia, collectionPages]);

  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => {
    if (!initial) return;
    savedSnapshot.current = JSON.stringify({ ...initial, viewport: initial.viewport ?? { x: 0, y: 0, zoom: 1 } });
  }, [initial]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,[contenteditable=true]")) return;
      if (selectedIds.size === 0) return;
      event.preventDefault();
      setBoard((current) => current ? { ...current, items: current.items.filter((item) => !selectedIds.has(item.id)) } : current);
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedIds]);

  useEffect(() => () => {
    const current = boardRef.current;
    if (!current) return;
    const textById = new Map<string, string>();
    textEditors.current.forEach((editor, itemId) => textById.set(itemId, editor.innerHTML));
    const updated: BoardRecord = {
      ...current,
      viewport: viewRef.current,
      items: current.items.map((item) => item.kind === "text" && textById.has(item.id) ? { ...item, text: textById.get(item.id) ?? item.text } : item),
    };
    const snapshot = JSON.stringify(updated);
    if (snapshot !== savedSnapshot.current) updateBoard(updated);
  }, []);

  useEffect(() => {
    const itemId = pendingTextFocus.current;
    if (!itemId) return;
    const editor = textEditors.current.get(itemId);
    if (!editor) return;
    pendingTextFocus.current = null;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    textSelections.current.set(itemId, range.cloneRange());
  }, [board?.items.length]);

  if (!board) {
    return <div className="state error">Board not found.<button onClick={() => nav("/boards")}>Back</button></div>;
  }

  function patchItem(itemId: string, patch: Partial<BoardItem>) {
    setBoard((current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === itemId ? { ...item, ...patch } : item),
    } : current);
  }

  function rememberTextSelection(itemId: string) {
    const editor = textEditors.current.get(itemId);
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) textSelections.current.set(itemId, range.cloneRange());
  }

  function restoreTextSelection(itemId: string) {
    const editor = textEditors.current.get(itemId);
    const range = textSelections.current.get(itemId);
    if (!editor || !range) return false;
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range.cloneRange());
    return true;
  }

  function commitTextHtml(itemId: string) {
    const editor = textEditors.current.get(itemId);
    if (editor) patchItem(itemId, { text: editor.innerHTML });
  }

  function applyTextCommand(itemId: string, command: "bold" | "italic" | "underline") {
    if (!restoreTextSelection(itemId)) return;
    document.execCommand(command, false);
    rememberTextSelection(itemId);
  }

  function applyTextFontSize(itemId: string, pixels: number) {
    const editor = textEditors.current.get(itemId);
    const size = Math.max(8, Math.min(144, Math.round(pixels || 24)));
    setFontSizeDrafts((current) => ({ ...current, [itemId]: size }));
    if (!editor || !restoreTextSelection(itemId)) return;

    document.execCommand("fontSize", false, "7");
    const replacements: HTMLSpanElement[] = [];
    editor.querySelectorAll('font[size="7"]').forEach((node) => {
      const span = document.createElement("span");
      span.style.fontSize = `${size}px`;
      while (node.firstChild) span.appendChild(node.firstChild);
      node.replaceWith(span);
      replacements.push(span);
    });

    if (replacements.length > 0) {
      const range = document.createRange();
      const first = replacements[0];
      const last = replacements[replacements.length - 1];
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      textSelections.current.set(itemId, range.cloneRange());
    } else {
      rememberTextSelection(itemId);
    }
  }

  function stepTextFontSize(itemId: string, direction: -1 | 1, fallback: number) {
    const current = fontSizeDrafts[itemId] ?? fallback;
    const next = direction > 0
      ? FONT_SIZE_PRESETS.find((size) => size > current) ?? FONT_SIZE_PRESETS[FONT_SIZE_PRESETS.length - 1]
      : [...FONT_SIZE_PRESETS].reverse().find((size) => size < current) ?? FONT_SIZE_PRESETS[0];
    applyTextFontSize(itemId, next);
  }

  function buildPersistedBoard() {
    const textById = new Map<string, string>();
    textEditors.current.forEach((editor, itemId) => textById.set(itemId, editor.innerHTML));
    return {
      ...board!,
      viewport: view,
      items: board!.items.map((item) => item.kind === "text" && textById.has(item.id)
        ? { ...item, text: textById.get(item.id) ?? item.text }
        : item),
    } satisfies BoardRecord;
  }

  function save() {
    const updated = { ...buildPersistedBoard(), updatedAt: new Date().toISOString() };
    updateBoard(updated);
    setBoard(updated);
    boardRef.current = updated;
    savedSnapshot.current = JSON.stringify(updated);
    savedTextRevision.current = textRevision;
  }

  function duplicateText(item: BoardItem) {
    const editor = textEditors.current.get(item.id);
    const copyId = crypto.randomUUID();
    const copy: BoardItem = { ...item, id: copyId, x: item.x + 24, y: item.y + 24, text: editor?.innerHTML ?? item.text ?? "" };
    setBoard((current) => current ? { ...current, items: [...current.items, copy] } : current);
    setSelectedIds(new Set([copyId]));
    pendingTextFocus.current = copyId;
  }

  function duplicateMediaItem(item: BoardItem) {
    const copyId = crypto.randomUUID();
    const copy: BoardItem = { ...item, id: copyId, x: item.x + 24, y: item.y + 24 };
    setBoard((current) => current ? { ...current, items: [...current.items, copy] } : current);
    setSelectedIds(new Set([copyId]));
    const media = copy.mediaId ? boardMedia.find((candidate) => candidate.id === copy.mediaId) : undefined;
    if (media) setSelectedMedia(media);
  }

  function selectCollectionPage(item: BoardItem, pages: MediaRecord[], pageIndex: number, collectionId: number) {
    const boundedIndex = Math.max(0, Math.min(pages.length - 1, pageIndex));
    const page = pages[boundedIndex];
    if (!page) return;
    const ratio = mediaAspectRatio(page, item);
    patchItem(item.id, {
      mediaId: page.id,
      collectionId,
      pageIndex: boundedIndex,
      aspectRatio: ratio,
      height: item.width / ratio,
    });
    setSelectedMedia(page);
  }

  function createTextAt(menu: InsertMenu) {
    const itemId = crypto.randomUUID();
    setBoard((current) => current ? {
      ...current,
      items: [...current.items, {
        id: itemId,
        kind: "text",
        text: "",
        x: menu.worldX,
        y: menu.worldY,
        width: 0,
        height: 0,
        rotation: 0,
        fontSize: 24,
        bold: false,
        italic: false,
        underline: false,
        backgroundColor: "#fff7b2",
      }],
    } : current);
    setSelectedIds(new Set([itemId]));
    pendingTextFocus.current = itemId;
    setInsertMenu(null);
  }

  function beginItemDrag(event: React.PointerEvent<HTMLDivElement>, item: BoardItem, media?: MediaRecord) {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,[contenteditable=true]")) return;
    event.preventDefault();
    event.stopPropagation();
    const additive = event.ctrlKey || event.metaKey;
    let nextSelection = new Set(selectedIds);
    if (additive) {
      if (nextSelection.has(item.id)) nextSelection.delete(item.id);
      else nextSelection.add(item.id);
    } else if (!nextSelection.has(item.id)) {
      nextSelection = new Set([item.id]);
    }
    if (nextSelection.size === 0) nextSelection.add(item.id);
    setSelectedIds(nextSelection);
    event.currentTarget.setPointerCapture(event.pointerId);
    const positions = new Map<string, { x: number; y: number }>();
    board!.items.forEach((candidate) => {
      if (nextSelection.has(candidate.id)) positions.set(candidate.id, { x: candidate.x, y: candidate.y });
    });
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, positions };
    if (media && nextSelection.size === 1) setSelectedMedia(media);
  }

  const marqueeRect = marquee ? {
    left: Math.min(marquee.startX, marquee.currentX),
    top: Math.min(marquee.startY, marquee.currentY),
    right: Math.max(marquee.startX, marquee.currentX),
    bottom: Math.max(marquee.startY, marquee.currentY),
  } : null;
  const dirtySnapshot = JSON.stringify({ ...board, viewport: view });
  const hasUnsavedChanges = dirtySnapshot !== savedSnapshot.current || textRevision !== savedTextRevision.current;

  return <div className="boardEditor">
    <div className="boardToolbar">
      <button onClick={() => { if (hasUnsavedChanges) save(); nav("/boards"); }}><ArrowLeft size={16} /> Boards</button>
      <input value={board.name} onChange={(event) => setBoard({ ...board, name: event.target.value })} />
      <span>{Math.round(view.zoom * 100)}%</span>
      <button className={hasUnsavedChanges ? "primary boardSaveDirty" : "boardSaveClean"} disabled={!hasUnsavedChanges} onClick={save}><Save size={16} /> {hasUnsavedChanges ? "Save board" : "Saved"}</button>
    </div>

    <div
      className="boardViewport"
      onContextMenu={(event) => {
        event.preventDefault();
        if (suppressNextContextMenu.current) {
          suppressNextContextMenu.current = false;
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setInsertMenu({
          clientX: event.clientX - rect.left,
          clientY: event.clientY - rect.top,
          worldX: (event.clientX - rect.left - view.x) / view.zoom,
          worldY: (event.clientY - rect.top - view.y) / view.zoom,
        });
      }}
      onWheel={(event) => {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        setView((current) => {
          const zoom = Math.min(3, Math.max(0.2, current.zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
          const worldX = (pointerX - current.x) / current.zoom;
          const worldY = (pointerY - current.y) / current.zoom;
          return { zoom, x: pointerX - worldX * zoom, y: pointerY - worldY * zoom };
        });
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        setInsertMenu(null);
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (event.button === 0) {
          pan.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (event.button === 2) {
          const additive = event.ctrlKey || event.metaKey;
          setMarquee({
            pointerId: event.pointerId,
            startX: x,
            startY: y,
            currentX: x,
            currentY: y,
            additive,
            canvasLeft: rect.left,
            canvasTop: rect.top,
          });
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        const activePan = pan.current;
        if (activePan?.pointerId === event.pointerId) {
          const dx = event.clientX - activePan.startX;
          const dy = event.clientY - activePan.startY;
          if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) activePan.moved = true;
          setView((current) => ({ ...current, x: activePan.viewX + dx, y: activePan.viewY + dy }));
        }
        const activeDrag = drag.current;
        if (activeDrag?.pointerId === event.pointerId) {
          const dx = (event.clientX - activeDrag.startX) / view.zoom;
          const dy = (event.clientY - activeDrag.startY) / view.zoom;
          setBoard((current) => current ? {
            ...current,
            items: current.items.map((item) => {
              const origin = activeDrag.positions.get(item.id);
              return origin ? { ...item, x: origin.x + dx, y: origin.y + dy } : item;
            }),
          } : current);
        }
        setMarquee((current) => current?.pointerId === event.pointerId
          ? {
              ...current,
              currentX: event.clientX - current.canvasLeft,
              currentY: event.clientY - current.canvasTop,
            }
          : current);
      }}
      onPointerUp={(event) => {
        if (marquee?.pointerId === event.pointerId) {
          const endX = event.clientX - marquee.canvasLeft;
          const endY = event.clientY - marquee.canvasTop;
          const box = {
            left: marquee.canvasLeft + Math.min(marquee.startX, endX),
            top: marquee.canvasTop + Math.min(marquee.startY, endY),
            right: marquee.canvasLeft + Math.max(marquee.startX, endX),
            bottom: marquee.canvasTop + Math.max(marquee.startY, endY),
          };
          const moved = Math.hypot(endX - marquee.startX, endY - marquee.startY) >= DRAG_THRESHOLD;
          if (moved) {
            suppressNextContextMenu.current = true;
            const hits = board.items.filter((item) => {
              const element = itemElements.current.get(item.id);
              return element ? intersects(element.getBoundingClientRect(), box) : false;
            }).map((item) => item.id);
            setSelectedIds((current) => {
              const next = marquee.additive ? new Set(current) : new Set<string>();
              hits.forEach((itemId) => next.add(itemId));
              return next;
            });
          }
          setMarquee(null);
        }
        if (pan.current?.pointerId === event.pointerId) {
          if (!pan.current.moved) setSelectedIds(new Set());
          pan.current = null;
        }
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
      }}
      onPointerCancel={(event) => {
        if (pan.current?.pointerId === event.pointerId) pan.current = null;
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
        if (marquee?.pointerId === event.pointerId) setMarquee(null);
      }}
    >
      <div className="boardWorld" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})` }}>
        {board.items.map((item) => {
          const storedMedia = item.mediaId ? boardMedia.find((candidate) => candidate.id === item.mediaId) : undefined;
          const collectionId = item.collectionId ?? storedMedia?.collectionId ?? null;
          const pages = collectionId ? (collectionPages[collectionId] ?? []) : [];
          const inferredPageIndex = pages.findIndex((page) => page.id === item.mediaId);
          const currentPageIndex = item.pageIndex != null
            ? Math.max(0, Math.min(pages.length - 1, item.pageIndex))
            : inferredPageIndex >= 0 ? inferredPageIndex : 0;
          const media = pages[currentPageIndex] ?? storedMedia;
          const ratio = mediaAspectRatio(media, item);
          const displayHeight = item.kind === "media" ? item.width / ratio : undefined;
          const isSelected = selectedIds.has(item.id);
          return <div
            ref={(node) => { if (node) itemElements.current.set(item.id, node); else itemElements.current.delete(item.id); }}
            key={item.id}
            className={`boardItem ${item.kind === "media" ? "boardMediaItem" : "boardTextItem"}`}
            style={{ left: item.x, top: item.y, ...(item.kind === "media" ? { width: item.width, height: displayHeight } : {}) }}
            onPointerDown={(event) => beginItemDrag(event, item, media)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedIds(new Set([item.id]));
              if (media) setSelectedMedia(media);
            }}
          >
            {item.kind === "text" ? <>
              {isSelected && <div className="boardTextToolbar" onPointerDown={(event) => event.stopPropagation()}>
                <div className="boardFontSizeControl" title="Font size">
                  <button title="Previous preset" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); stepTextFontSize(item.id, -1, item.fontSize ?? 24); }}><ChevronDown size={13} /></button>
                  <input type="number" min="8" max="144" value={fontSizeDrafts[item.id] ?? item.fontSize ?? 24}
                    onPointerDown={(event) => { event.stopPropagation(); rememberTextSelection(item.id); }}
                    onChange={(event) => setFontSizeDrafts((current) => ({ ...current, [item.id]: Number(event.target.value) }))}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") { event.preventDefault(); applyTextFontSize(item.id, Number(event.currentTarget.value)); }
                      if (event.key === "ArrowUp") { event.preventDefault(); stepTextFontSize(item.id, 1, item.fontSize ?? 24); }
                      if (event.key === "ArrowDown") { event.preventDefault(); stepTextFontSize(item.id, -1, item.fontSize ?? 24); }
                    }}
                    onBlur={(event) => applyTextFontSize(item.id, Number(event.currentTarget.value))} />
                  <button title="Next preset" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); stepTextFontSize(item.id, 1, item.fontSize ?? 24); }}><ChevronUp size={13} /></button>
                </div>
                <button title="Bold" onPointerDown={(event) => { event.preventDefault(); applyTextCommand(item.id, "bold"); }}><Bold size={14} /></button>
                <button title="Italic" onPointerDown={(event) => { event.preventDefault(); applyTextCommand(item.id, "italic"); }}><Italic size={14} /></button>
                <button title="Underline" onPointerDown={(event) => { event.preventDefault(); applyTextCommand(item.id, "underline"); }}><Underline size={14} /></button>
                <label className="boardTextBackgroundColor" title="Text box background color" onPointerDown={(event) => { event.stopPropagation(); rememberTextSelection(item.id); }}>
                  <span aria-hidden="true" style={{ backgroundColor: item.backgroundColor ?? "#fff7b2" }} />
                  <input type="color" value={item.backgroundColor ?? "#fff7b2"}
                    onChange={(event) => patchItem(item.id, { backgroundColor: event.currentTarget.value })} />
                </label>
                <button title="Duplicate text" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); duplicateText(item); }}><Copy size={14} /></button>
                <button title="Delete text" onPointerDown={(event) => event.stopPropagation()} onClick={() => setBoard((current) => current ? { ...current, items: current.items.filter((candidate) => candidate.id !== item.id) } : current)}><Trash2 size={14} /></button>
              </div>}
              <div className={`boardTextContent ${isSelected ? "selected" : ""}`} style={{ backgroundColor: item.backgroundColor ?? "#fff7b2" }}>
                <div ref={(node) => { if (node) textEditors.current.set(item.id, node); else textEditors.current.delete(item.id); }}
                  className="boardTextEditor" contentEditable suppressContentEditableWarning spellCheck
                  style={{ fontSize: item.fontSize ?? 24 }} dangerouslySetInnerHTML={{ __html: item.text ?? "" }}
                  onPointerDown={(event) => { event.stopPropagation(); setSelectedIds(new Set([item.id])); }}
                  onKeyUp={() => rememberTextSelection(item.id)} onMouseUp={() => rememberTextSelection(item.id)}
                  onInput={(event) => { rememberTextSelection(item.id); setTextRevision((value) => value + 1); event.stopPropagation(); }} onBlur={() => commitTextHtml(item.id)} />
              </div>
              {isSelected && <div className="boardTextDragHandle" title="Drag text"
                onPointerDown={(event) => beginItemDrag(event, item)}><Move size={13} /><span>Drag</span></div>}
            </> : <>
              <div className={`boardMediaContent ${isSelected ? "selected" : ""}`} style={{ transform: `rotate(${item.rotation}deg)` }}>
                {media?.mediaType === "video" && <span className="boardMediaTypeBadge boardVideoBadge" aria-label="Video"><Play size={15} fill="currentColor" /></span>}
                {collectionId && <span className="boardMediaTypeBadge boardComicBadge" aria-label="Comic"><BookOpen size={15} /></span>}
                {media ? media.mediaType === "image"
                  ? <img src={getMediaUrl(media.filePath)} draggable={false} onDragStart={(event) => event.preventDefault()} />
                  : <video src={getMediaUrl(media.filePath)} muted controls={isSelected} loop={media.isAnimatedGif} draggable={false}
                      onLoadedMetadata={(event) => {
                        const video = event.currentTarget;
                        if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
                        const loadedRatio = video.videoWidth / video.videoHeight;
                        if (!Number.isFinite(loadedRatio) || loadedRatio <= 0 || Math.abs(loadedRatio - ratio) < 0.0001) return;
                        patchItem(item.id, { aspectRatio: loadedRatio, height: item.width / loadedRatio });
                      }}
                      onDragStart={(event) => event.preventDefault()} />
                  : <div className="missingBoardMedia">Media #{item.mediaId}</div>}
              </div>
              {isSelected && <div className="boardMediaControls" onPointerDown={(event) => event.stopPropagation()}>
                <div className="boardMediaControlRow">
                  <label className="boardRotateControl" title={`Rotation ${Math.round(item.rotation)}°`}><span>{Math.round(item.rotation)}°</span>
                    <input type="range" min="-180" max="180" value={item.rotation} onChange={(event) => patchItem(item.id, { rotation: Number(event.target.value) })} /></label>
                  <button className="boardDelete" title="Remove from board" onClick={() => setBoard((current) => current ? { ...current, items: current.items.filter((candidate) => candidate.id !== item.id) } : current)}><Trash2 size={14} /></button>
                </div>
                {collectionId && pages.length > 0 && <div className="boardComicPageRow">
                  <div className="boardComicPageStepper" title="Displayed comic page">
                    <button title="Previous page" disabled={currentPageIndex <= 0} onClick={() => selectCollectionPage(item, pages, currentPageIndex - 1, collectionId)}><ChevronLeft size={14} /></button>
                    <span>Page {currentPageIndex + 1} / {pages.length}</span>
                    <button title="Next page" disabled={currentPageIndex >= pages.length - 1} onClick={() => selectCollectionPage(item, pages, currentPageIndex + 1, collectionId)}><ChevronRight size={14} /></button>
                  </div>
                  <button title="Duplicate this comic page item" onClick={() => duplicateMediaItem({ ...item, mediaId: media?.id ?? item.mediaId, collectionId, pageIndex: currentPageIndex })}><Copy size={14} /> Duplicate</button>
                </div>}
              </div>}
              {isSelected && selectedIds.size === 1 && <div className="boardResize" onPointerDown={(event) => {
                event.preventDefault(); event.stopPropagation();
                const startX = event.clientX; const startY = event.clientY; const startWidth = item.width; const startHeight = displayHeight ?? item.height; const resizeRatio = ratio;
                const move = (pointer: PointerEvent) => {
                  const dx = (pointer.clientX - startX) / view.zoom; const dy = (pointer.clientY - startY) / view.zoom;
                  const nextWidth = Math.max(MIN_MEDIA_WIDTH, Math.abs(dx) >= Math.abs(dy) ? startWidth + dx : (startHeight + dy) * resizeRatio);
                  patchItem(item.id, { width: nextWidth, height: nextWidth / resizeRatio, aspectRatio: resizeRatio });
                };
                const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
                window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
              }} />}
            </>}
          </div>;
        })}
      </div>
      {marqueeRect && <div className="boardMarquee" style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.right - marqueeRect.left, height: marqueeRect.bottom - marqueeRect.top }} />}
      {insertMenu && <div className="boardInsertMenu" style={{ left: insertMenu.clientX, top: insertMenu.clientY }} onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => createTextAt(insertMenu)}><Type size={15} /> Text</button>
      </div>}
    </div>
  </div>;
}
