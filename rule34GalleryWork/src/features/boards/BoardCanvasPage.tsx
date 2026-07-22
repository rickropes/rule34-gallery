import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bold, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, FileDown, Italic, Move, Play, Save, Trash2, Type, Underline } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { loadBoards, updateBoard } from "@/services/boardService";
import { useAppStore } from "@/store/appStore";
import { getMediaUrl } from "@/services/mediaService";
import { listCollectionPages, listMedia } from "@/tauri/mediaApi";
import type { MediaRecord } from "@/types/media";
import type { BoardItem, BoardRecord } from "@/types/board";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { message, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

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
  const libraryVersion = useAppStore((state) => state.libraryVersion);
  const setSelectedMedia = useAppStore((state) => state.setSelectedMedia);
  const setSelectedMediaSelection = useAppStore((state) => state.setSelectedMediaSelection);
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
  const [exportingPdf, setExportingPdf] = useState(false);
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
  }, [gallery, libraryVersion]);

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

  useEffect(() => {
    if (!board || selectedIds.size === 0) {
      setSelectedMediaSelection(null, []);
      return;
    }
    const selectedMediaItems = board.items
      .filter((item) => selectedIds.has(item.id) && item.kind === "media" && item.mediaId)
      .map((item) => boardMedia.find((candidate) => candidate.id === item.mediaId))
      .filter((item): item is MediaRecord => Boolean(item));
    if (selectedMediaItems.length === 0) {
      setSelectedMediaSelection(null, []);
      return;
    }
    setSelectedMediaSelection(selectedMediaItems[0], [...new Set(selectedMediaItems.map((item) => item.id))]);
  }, [board, boardMedia, selectedIds, setSelectedMediaSelection]);

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

  function rotatedBounds(item: BoardItem, width: number, height: number) {
    if (item.kind !== "media" || !item.rotation) {
      return { left: item.x, top: item.y, right: item.x + width, bottom: item.y + height };
    }
    const radians = item.rotation * Math.PI / 180;
    const rotatedWidth = Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians));
    const rotatedHeight = Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
    const centerX = item.x + width / 2;
    const centerY = item.y + height / 2;
    return {
      left: centerX - rotatedWidth / 2,
      top: centerY - rotatedHeight / 2,
      right: centerX + rotatedWidth / 2,
      bottom: centerY + rotatedHeight / 2,
    };
  }

  async function exportToPdf() {
    if (exportingPdf) return;
    const currentBoard = board;
    if (!currentBoard) return;
    if (currentBoard.items.length === 0) {
      await message("Add something to the board before exporting it.", { title: "Export to PDF", kind: "info" });
      return;
    }

    let releaseInputLock: (() => void) | null = null;
    let restoreVideoFrames: (() => void) | null = null;
    setExportingPdf(true);

    try {
      // Commit the latest contentEditable HTML before freezing the board DOM.
      const persisted = buildPersistedBoard();
      setBoard(persisted);
      boardRef.current = persisted;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      const lockUserInput = () => {
        const blockedEvents = [
          "pointerdown", "pointermove", "pointerup", "pointercancel",
          "mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu",
          "touchstart", "touchmove", "touchend", "touchcancel",
          "wheel", "keydown", "keyup", "keypress", "beforeinput", "input", "change",
          "dragstart", "drag", "dragend", "drop",
        ];
        const block = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        };
        blockedEvents.forEach((eventName) => window.addEventListener(eventName, block, { capture: true, passive: false }));

        const overlay = document.createElement("div");
        overlay.className = "boardPdfInputLock";
        overlay.setAttribute("role", "status");
        overlay.setAttribute("aria-live", "polite");
        overlay.textContent = "Preparing PDF…";
        Object.assign(overlay.style, {
          position: "fixed",
          inset: "0",
          zIndex: "2147483647",
          cursor: "wait",
          background: "rgba(10, 12, 16, 0.18)",
          display: "grid",
          placeItems: "center",
          color: "white",
          fontSize: "16px",
          fontWeight: "600",
          pointerEvents: "auto",
          userSelect: "none",
        });
        document.body.appendChild(overlay);
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) activeElement.blur();

        return () => {
          blockedEvents.forEach((eventName) => window.removeEventListener(eventName, block, { capture: true }));
          overlay.remove();
        };
      };

      const captureVideoFrame = async (video: HTMLVideoElement, fallbackWidth: number, fallbackHeight: number) => {
        const drawFrame = (source: HTMLVideoElement) => {
          if (source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
          const frame = document.createElement("canvas");
          frame.width = Math.max(1, source.videoWidth || Math.round(fallbackWidth));
          frame.height = Math.max(1, source.videoHeight || Math.round(fallbackHeight));
          const context = frame.getContext("2d");
          if (!context) return null;
          context.drawImage(source, 0, 0, frame.width, frame.height);
          return frame.toDataURL("image/png");
        };

        try {
          const currentFrame = drawFrame(video);
          if (currentFrame) return currentFrame;
        } catch {
          // Try a detached decoder below.
        }

        // Tauri's asset protocol can display a video while still preventing a
        // WebView canvas from reading its pixels. Ask the native side to decode
        // the frame directly from the local file before trying another WebView
        // video element.
        const filePath = video.dataset.filePath;
        if (filePath) {
          try {
            const bytes = await invoke<number[]>("extract_video_frame_png", {
              path: filePath,
              timeSeconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
            });
            if (bytes.length > 0) {
              const binary = new Uint8Array(bytes);
              const blob = new Blob([binary], { type: "image/png" });
              return await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
              });
            }
          } catch (error) {
            console.warn("Native video frame extraction failed; trying WebView decoder", error);
          }
        }

        const decoder = document.createElement("video");
        decoder.muted = true;
        decoder.preload = "auto";
        decoder.playsInline = true;
        decoder.crossOrigin = video.crossOrigin;
        decoder.src = video.currentSrc || video.src;
        const waitFor = (eventName: "loadeddata" | "seeked", timeout = 5000) => new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, timeout);
          decoder.addEventListener(eventName, () => {
            window.clearTimeout(timer);
            resolve();
          }, { once: true });
        });

        try {
          decoder.load();
          await waitFor("loadeddata");
          const requestedTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          if (decoder.duration > 0 && requestedTime > 0) {
            decoder.currentTime = Math.min(requestedTime, Math.max(0, decoder.duration - 0.001));
            await waitFor("seeked");
          }
          return drawFrame(decoder);
        } catch {
          return null;
        } finally {
          decoder.removeAttribute("src");
          decoder.load();
        }
      };

      releaseInputLock = lockUserInput();

      // Replace the live video nodes in place. Cloning a board containing normal
      // images is much more reliable than asking html2canvas to render <video>.
      // Input stays locked until every original video has been restored.
      const replacements: Array<{ image: HTMLImageElement; video: HTMLVideoElement }> = [];
      const capturedVideoFrames = new Map<string, string>();
      const liveVideos = Array.from(document.querySelectorAll<HTMLVideoElement>(".boardViewport .boardItem video"));
      for (const video of liveVideos) {
        const rect = video.getBoundingClientRect();
        const frameUrl = await captureVideoFrame(video, rect.width, rect.height);
        if (!frameUrl || !video.parentNode) continue;
        const itemId = video.closest<HTMLElement>(".boardItem")?.dataset.boardItemId;
        if (itemId) capturedVideoFrames.set(itemId, frameUrl);

        const image = document.createElement("img");
        image.src = frameUrl;
        image.className = video.className;
        image.style.cssText = video.style.cssText;
        image.alt = "Video frame";
        image.draggable = false;

        const computed = getComputedStyle(video);
        image.style.width = computed.width;
        image.style.height = computed.height;
        image.style.display = computed.display;
        image.style.objectFit = computed.objectFit;
        image.style.objectPosition = computed.objectPosition;
        image.style.borderRadius = computed.borderRadius;
        image.style.clipPath = computed.clipPath;
        image.style.opacity = computed.opacity;
        image.style.filter = computed.filter;
        image.style.transform = computed.transform;
        image.style.transformOrigin = computed.transformOrigin;

        video.replaceWith(image);
        replacements.push({ image, video });
      }

      restoreVideoFrames = () => {
        for (const { image, video } of replacements.reverse()) {
          if (image.parentNode) image.replaceWith(video);
        }
      };

      await Promise.all(replacements.map(({ image }) => image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          })));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      const itemSizes = persisted.items.map((item) => {
        const element = itemElements.current.get(item.id);
        const storedMedia = item.mediaId ? boardMedia.find((candidate) => candidate.id === item.mediaId) : undefined;
        const collectionId = item.collectionId ?? storedMedia?.collectionId ?? null;
        const pages = collectionId ? (collectionPages[collectionId] ?? []) : [];
        const pageIndex = item.pageIndex != null
          ? Math.max(0, Math.min(Math.max(0, pages.length - 1), item.pageIndex))
          : Math.max(0, pages.findIndex((page) => page.id === item.mediaId));
        const media = pages[pageIndex] ?? storedMedia;
        const ratio = mediaAspectRatio(media, item);
        const width = item.kind === "media" ? item.width : Math.max(1, element?.offsetWidth ?? item.width ?? 1);
        const height = item.kind === "media" ? item.width / ratio : Math.max(1, element?.offsetHeight ?? item.height ?? 1);
        return { item, width, height, bounds: rotatedBounds(item, width, height) };
      });

      const padding = 28;
      const minX = Math.min(...itemSizes.map(({ bounds }) => bounds.left));
      const minY = Math.min(...itemSizes.map(({ bounds }) => bounds.top));
      const maxX = Math.max(...itemSizes.map(({ bounds }) => bounds.right));
      const maxY = Math.max(...itemSizes.map(({ bounds }) => bounds.bottom));
      const exportWidth = Math.max(1, Math.ceil(maxX - minX + padding * 2));
      const exportHeight = Math.max(1, Math.ceil(maxY - minY + padding * 2));

      const exportRoot = document.createElement("div");
      exportRoot.className = "boardPdfExportRoot";
      Object.assign(exportRoot.style, {
        position: "fixed",
        left: "-100000px",
        top: "0",
        width: `${exportWidth}px`,
        height: `${exportHeight}px`,
        overflow: "hidden",
        background: "#15181e",
        zIndex: "-1",
      });

      for (const { item, width, height } of itemSizes) {
        const original = itemElements.current.get(item.id);
        if (!original) continue;
        const clone = original.cloneNode(true) as HTMLDivElement;
        clone.classList.remove("selected");
        clone.querySelectorAll(".selected").forEach((node) => node.classList.remove("selected"));
        clone.querySelectorAll(".boardTextToolbar,.boardTextDragHandle,.boardMediaControls,.boardResize,.boardMediaTypeBadge")
          .forEach((node) => node.remove());
        clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
        Object.assign(clone.style, {
          left: `${item.x - minX + padding}px`,
          top: `${item.y - minY + padding}px`,
          width: item.kind === "media" ? `${width}px` : clone.style.width,
          height: item.kind === "media" ? `${height}px` : clone.style.height,
          outline: "none",
          boxShadow: "none",
        });
        exportRoot.appendChild(clone);
      }

      document.body.appendChild(exportRoot);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await Promise.all(Array.from(exportRoot.querySelectorAll("img")).map((image) => image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          })));

      const maxCanvasSide = 12000;
      const maxCanvasPixels = 80_000_000;
      const captureScale = Math.max(0.5, Math.min(
        3,
        maxCanvasSide / exportWidth,
        maxCanvasSide / exportHeight,
        Math.sqrt(maxCanvasPixels / (exportWidth * exportHeight)),
      ));
      const canvas = await html2canvas(exportRoot, {
        backgroundColor: "#15181e",
        scale: captureScale,
        useCORS: true,
        logging: false,
        width: exportWidth,
        height: exportHeight,
      });

      // html2canvas/WebView cloning can silently omit data-URL images that replaced
      // local videos. Paint decoded frames directly onto the final raster instead.
      // This path uses board coordinates, so it does not depend on cloned DOM media.
      const outputContext = canvas.getContext("2d");
      if (outputContext && capturedVideoFrames.size > 0) {
        const loadFrameImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("Could not decode an extracted video frame."));
          image.src = src;
        });

        for (const { item, width, height } of itemSizes) {
          const frameUrl = capturedVideoFrames.get(item.id);
          if (!frameUrl || item.kind !== "media") continue;
          try {
            const frame = await loadFrameImage(frameUrl);
            const targetX = (item.x - minX + padding) * captureScale;
            const targetY = (item.y - minY + padding) * captureScale;
            const targetWidth = width * captureScale;
            const targetHeight = height * captureScale;
            const sourceRatio = frame.naturalWidth / Math.max(1, frame.naturalHeight);
            const targetRatio = targetWidth / Math.max(1, targetHeight);
            let drawWidth = targetWidth;
            let drawHeight = targetHeight;
            if (sourceRatio > targetRatio) drawHeight = targetWidth / sourceRatio;
            else drawWidth = targetHeight * sourceRatio;

            outputContext.save();
            outputContext.translate(targetX + targetWidth / 2, targetY + targetHeight / 2);
            outputContext.rotate((item.rotation ?? 0) * Math.PI / 180);
            outputContext.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
            outputContext.restore();
          } catch (error) {
            console.warn(`Could not paint video frame for board item ${item.id}`, error);
          }
        }
      }
      exportRoot.remove();

      // Restore the live board before opening the native save dialog.
      restoreVideoFrames();
      restoreVideoFrames = null;
      releaseInputLock();
      releaseInputLock = null;

      const pdfPointScale = Math.min(0.75, 14400 / Math.max(exportWidth, exportHeight));
      const pageWidth = Math.max(1, exportWidth * pdfPointScale);
      const pageHeight = Math.max(1, exportHeight * pdfPointScale);
      const pdf = new jsPDF({
        orientation: pageWidth >= pageHeight ? "landscape" : "portrait",
        unit: "pt",
        format: [pageWidth, pageHeight],
        compress: true,
        hotfixes: ["px_scaling"],
      });
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");

      const safeName = currentBoard.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";
      const path = await saveFileDialog({
        title: "Export board to PDF",
        defaultPath: `${safeName}.pdf`,
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
      });
      if (!path) return;
      const bytes = Array.from(new Uint8Array(pdf.output("arraybuffer")));
      await invoke("save_pdf_file", { path, bytes });
    } catch (error) {
      console.error("Board PDF export failed", error);
      await message(`Could not export this board.\n\n${String(error)}`, { title: "Export to PDF", kind: "error" });
    } finally {
      restoreVideoFrames?.();
      releaseInputLock?.();
      document.querySelectorAll(".boardPdfExportRoot,.boardPdfInputLock").forEach((node) => node.remove());
      setExportingPdf(false);
    }
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
      <button onClick={() => void exportToPdf()} disabled={exportingPdf}><FileDown size={16} /> {exportingPdf ? "Exporting…" : "Export to PDF"}</button>
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
            data-board-item-id={item.id}
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
                  : <video src={getMediaUrl(media.filePath)} data-file-path={media.filePath} muted controls={isSelected} loop={media.isAnimatedGif} draggable={false}
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
