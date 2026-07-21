import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize, RotateCcw, SkipBack, SkipForward, X, ZoomIn, ZoomOut } from "lucide-react";
import { getMediaUrl } from "@/services/mediaService";
import { useMediaTags } from "@/hooks/useMediaTags";
import { useAppStore } from "@/store/appStore";
import { listCollectionPages } from "@/tauri/mediaApi";
import type { MediaRecord } from "@/types/media";

const FRAME_SECONDS = 1 / 30;

export default function MediaViewer() {
  const media = useAppStore((s) => s.selectedMedia);
  const open = useAppStore((s) => s.viewerOpen);
  const setOpen = useAppStore((s) => s.setViewerOpen);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [videoPaused, setVideoPaused] = useState(false);
  const [collectionPages, setCollectionPages] = useState<MediaRecord[]>([]);
  const [collectionIndex, setCollectionIndex] = useState(0);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const { tags } = useMediaTags(media?.id ?? null);
  const isAnimatedGif = tags.some((tag) => tag.category.toLowerCase() === "metadata" && tag.name.toLowerCase() === "animated_gif");

  useEffect(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
    setVideoPaused(false);
  }, [media?.id, open]);

  useEffect(() => {
    setCollectionIndex(0);
    if (!media?.collectionId) { setCollectionPages([]); return; }
    void listCollectionPages(media.collectionId).then(setCollectionPages).catch(() => setCollectionPages([]));
  }, [media?.id, media?.collectionId, open]);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "+") setScale((value) => Math.min(8, value + 0.25));
      if (event.key === "-") setScale((value) => Math.max(0.2, value - 0.25));
      if (collectionPages.length > 1 && event.key === "ArrowLeft") { setCollectionIndex((value) => (value - 1 + collectionPages.length) % collectionPages.length); reset(); return; }
      if (collectionPages.length > 1 && event.key === "ArrowRight") { setCollectionIndex((value) => (value + 1) % collectionPages.length); reset(); return; }
      if (media?.mediaType === "video" && videoRef.current?.paused) {
        if (event.key === "," || event.key === "ArrowLeft") stepFrame(-1);
        if (event.key === "." || event.key === "ArrowRight") stepFrame(1);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, media?.mediaType, setOpen, collectionPages.length]);

  if (!media || !open) return null;
  const activeMedia = collectionPages[collectionIndex] ?? media;
  const title = media.originalFilename ?? media.storedFilename;
  const url = getMediaUrl(activeMedia.filePath);

  function zoom(delta: number) {
    setScale((value) => Math.min(8, Math.max(0.2, value + delta)));
  }

  function reset() {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }

  function stepFrame(direction: -1 | 1) {
    const video = videoRef.current;
    if (!video || !video.paused) return;
    const duration = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
    video.currentTime = Math.min(duration, Math.max(0, video.currentTime + direction * FRAME_SECONDS));
  }

  return (
    <div ref={viewerRef} className="viewer" onClick={() => setOpen(false)}>
      <div className="viewerToolbar" onClick={(event) => event.stopPropagation()}>
        {collectionPages.length > 1 && <>
          <button onClick={() => { setCollectionIndex((value) => (value - 1 + collectionPages.length) % collectionPages.length); reset(); }}><ChevronLeft /></button>
          <span>{collectionIndex + 1} / {collectionPages.length}</span>
          <button onClick={() => { setCollectionIndex((value) => (value + 1) % collectionPages.length); reset(); }}><ChevronRight /></button>
        </>}
        {media.mediaType === "image" && (
          <>
            <button onClick={() => zoom(-0.25)} title="Zoom out"><ZoomOut /></button>
            <span>{Math.round(scale * 100)}%</span>
            <button onClick={() => zoom(0.25)} title="Zoom in"><ZoomIn /></button>
            <button onClick={reset} title="Reset"><RotateCcw /></button>
          </>
        )}
        {media.mediaType === "video" && videoPaused && (
          <>
            <button onClick={() => stepFrame(-1)} title="Previous frame (comma or left arrow)"><SkipBack /></button>
            <span>Frame step</span>
            <button onClick={() => stepFrame(1)} title="Next frame (period or right arrow)"><SkipForward /></button>
          </>
        )}
        <button onClick={() => viewerRef.current?.requestFullscreen?.()} title="Fullscreen"><Maximize /></button>
        <button onClick={() => setOpen(false)} title="Close"><X /></button>
      </div>
      <div
        className="viewerStage"
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => {
          if (media.mediaType !== "image") return;
          event.preventDefault();
          zoom(event.deltaY < 0 ? 0.2 : -0.2);
        }}
        onPointerDown={(event) => {
          if (media.mediaType === "image") {
            drag.current = { x: event.clientX, y: event.clientY, px: pos.x, py: pos.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          if (drag.current) setPos({ x: drag.current.px + event.clientX - drag.current.x, y: drag.current.py + event.clientY - drag.current.y });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        {media.mediaType === "video" ? (
          <video
            ref={videoRef}
            src={url}
            controls
            autoPlay
            loop={isAnimatedGif}
            muted={isAnimatedGif}
            playsInline
            onLoadedMetadata={(event) => { if (isAnimatedGif) void event.currentTarget.play().catch(() => undefined); }}
            onPause={() => setVideoPaused(true)}
            onPlay={() => setVideoPaused(false)}
          />
        ) : (
          <img
            className="zoomImage"
            draggable={false}
            src={url}
            alt={title}
            style={{ transform: `translate(${pos.x}px,${pos.y}px) scale(${scale})` }}
          />
        )}
      </div>
      <p className="viewerCaption">{title}</p>
    </div>
  );
}
