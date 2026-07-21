import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ExternalLink, FolderOpen, ChevronLeft, ChevronRight, Maximize2, Minimize2, Scissors, Trash2, VolumeX, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { getMediaUrl } from "@/services/mediaService";
import { listCollectionPages } from "@/tauri/mediaApi";
import { useMediaTags } from "@/hooks/useMediaTags";
import {
  addTagToMedia,
  listTagCategories,
  listTagsForCategory,
  type TagRecord,
} from "@/providers/tagProvider";
import {
  deleteMedia,
  listMedia,
  processMedia,
  mediaIdsWithAudio,
  trimVideo,
  type ProcessMediaResult,
} from "@/tauri/mediaApi";
import type { MediaRecord } from "@/types/media";
import { invoke } from "@tauri-apps/api/core";
import {
  CATEGORY_PREFERENCES_EVENT,
  defaultCategoryColor,
  loadCategoryPreferences,
  type CategoryPreference,
} from "@/services/categoryPreferences";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const PREVIEW_HEIGHT_STORAGE_KEY = "rule34-library.inspector-preview-height-v6";
const MIN_PREVIEW_HEIGHT = 160;
const MAX_PREVIEW_HEIGHT = 900;

function resultMessage(action: string, result: ProcessMediaResult) {
  const done = `${action}: processed ${result.processedCount} item${result.processedCount === 1 ? "" : "s"}.`;
  return result.errors.length ? `${done}\n\n${result.errors.join("\n")}` : done;
}

export default function Inspector() {
  const media = useAppStore((s) => s.selectedMedia);
  const selectedIds = useAppStore((s) => s.selectedIds);
  const clear = useAppStore((s) => s.clearSelection);
  const bump = useAppStore((s) => s.bumpLibraryVersion);
  const setViewerOpen = useAppStore((s) => s.setViewerOpen);
  const setSearch = useAppStore((s) => s.setSearch);
  const viewerOpen = useAppStore((s) => s.viewerOpen);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const previewResizeHandleRef = useRef<HTMLDivElement>(null);
  const previewDragStart = useRef<{ y: number; height: number } | null>(null);
  const savedPreviewHeight = Number(localStorage.getItem(PREVIEW_HEIGHT_STORAGE_KEY));
  const [previewHeight, setPreviewHeight] = useState<number | null>(() =>
    Number.isFinite(savedPreviewHeight) && savedPreviewHeight >= MIN_PREVIEW_HEIGHT
      ? Math.min(MAX_PREVIEW_HEIGHT, savedPreviewHeight)
      : null,
  );
  const [isResizingPreview, setIsResizingPreview] = useState(false);
  const [collectionPages, setCollectionPages] = useState<MediaRecord[]>([]);
  const [collectionIndex, setCollectionIndex] = useState(0);

  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<TagRecord[]>([]);
  const [selectedItems, setSelectedItems] = useState<MediaRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [operationStatus, setOperationStatus] = useState<string | null>(null);
  const [audioVideoIds, setAudioVideoIds] = useState<number[]>([]);
  const [categoryPreferences, setCategoryPreferences] = useState<CategoryPreference[]>(() => loadCategoryPreferences());
  const { tags, loading, error, addTag, removeTag } = useMediaTags(media?.id ?? null);
  const isAnimatedGif = tags.some((tag) => tag.category.toLowerCase() === "metadata" && tag.name.toLowerCase() === "animated_gif");

  useEffect(() => {
    setOperationStatus(null);
  }, [media?.id, selectedIds]);

  useEffect(() => {
    if (previewHeight == null) {
      localStorage.removeItem(PREVIEW_HEIGHT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(PREVIEW_HEIGHT_STORAGE_KEY, String(previewHeight));
  }, [previewHeight]);

  useEffect(() => {
    if (!isResizingPreview) return;

    const resize = (event: PointerEvent) => {
      const start = previewDragStart.current;
      if (!start) return;
      const inspectorHeight = inspectorRef.current?.clientHeight ?? window.innerHeight;
      const viewportLimit = Math.max(MIN_PREVIEW_HEIGHT, inspectorHeight - 120);
      const maxHeight = Math.min(MAX_PREVIEW_HEIGHT, viewportLimit);
      setPreviewHeight(Math.min(maxHeight, Math.max(MIN_PREVIEW_HEIGHT, start.height + event.clientY - start.y)));
    };
    const stop = () => {
      previewDragStart.current = null;
      setIsResizingPreview(false);
    };

    document.body.classList.add("is-resizing-preview");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.body.classList.remove("is-resizing-preview");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [isResizingPreview]);

  useEffect(() => {
    setCollectionIndex(0);
    if (!media?.collectionId) { setCollectionPages([]); return; }
    void listCollectionPages(media.collectionId).then(setCollectionPages).catch(() => setCollectionPages([]));
  }, [media?.id, media?.collectionId]);

  useEffect(() => {
    void listTagCategories()
      .then((values) => setCategories(values))
      .catch(() => setCategories([]));
  }, [media?.id, tags.length]);

  useEffect(() => {
    if (!category.trim()) {
      setSuggestions([]);
      return;
    }
    void listTagsForCategory(category).then(setSuggestions).catch(() => setSuggestions([]));
  }, [category, tags.length]);

  useEffect(() => {
    if (viewerOpen) videoRef.current?.pause();
  }, [viewerOpen]);

  useEffect(() => {
    if (!selectedIds.length) {
      setSelectedItems([]);
      setAudioVideoIds([]);
      return;
    }
    void listMedia()
      .then((page) => setSelectedItems(page.items.filter((item) => selectedIds.includes(item.id))))
      .catch(() => setSelectedItems(media ? [media] : []));
  }, [selectedIds, media]);

  useEffect(() => {
    const videoIds = selectedItems.filter((item) => item.mediaType === "video").map((item) => item.id);
    if (!videoIds.length) {
      setAudioVideoIds([]);
      return;
    }
    let cancelled = false;
    void mediaIdsWithAudio(videoIds)
      .then((ids) => { if (!cancelled) setAudioVideoIds(ids); })
      .catch(() => { if (!cancelled) setAudioVideoIds(videoIds); });
    return () => { cancelled = true; };
  }, [selectedItems]);


  useEffect(() => {
    const refreshPreferences = () => setCategoryPreferences(loadCategoryPreferences(categories));
    refreshPreferences();
    window.addEventListener(CATEGORY_PREFERENCES_EVENT, refreshPreferences);
    return () => window.removeEventListener(CATEGORY_PREFERENCES_EVENT, refreshPreferences);
  }, [categories]);

  const sortedTags = useMemo(() => {
    const priorities = new Map(categoryPreferences.map((item, index) => [item.category.toLowerCase(), index]));
    return [...tags].sort((a, b) => {
      const categoryOrder = (priorities.get(a.category.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
        - (priorities.get(b.category.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
      if (categoryOrder !== 0) return categoryOrder;
      const categoryName = a.category.localeCompare(b.category, undefined, { sensitivity: "base" });
      if (categoryName !== 0) return categoryName;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [tags, categoryPreferences]);

  function categoryAppearance(categoryName: string) {
    const preference = categoryPreferences.find((item) => item.category.toLowerCase() === categoryName.toLowerCase());
    return {
      color: preference?.color ?? defaultCategoryColor(categoryName),
      outlineEnabled: preference?.outlineEnabled ?? false,
      outlineColor: preference?.outlineColor ?? "#000000",
    };
  }

  const filtered = useMemo(
    () => suggestions
      .filter((tag) => tag.name.toLowerCase().includes(name.toLowerCase()) && !tags.some((x) => x.id === tag.id))
      .slice(0, 8),
    [suggestions, name, tags],
  );

  if (!media) return <aside className="inspector emptyInspector">Select media to inspect tags and details.</aside>;

  const previewMedia = collectionPages[collectionIndex] ?? media;
  const title = media.originalFilename ?? media.storedFilename;
  const url = getMediaUrl(previewMedia.filePath);
  const multiple = selectedIds.length > 1;
  const selectedVideoIds = selectedItems.filter((item) => item.mediaType === "video").map((item) => item.id);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !category.trim()) return;
    setBusy(true);
    try {
      if (multiple) await addTagToMedia(selectedIds, name.trim(), category.trim());
      else await addTag(name, category);
      setName("");
      bump();
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    if (!confirm(`Delete ${selectedIds.length} selected item${selectedIds.length === 1 ? "" : "s"} from the gallery and disk?`)) return;
    setBusy(true);
    try {
      await deleteMedia(selectedIds);
      clear();
      bump();
    } finally {
      setBusy(false);
    }
  }

  async function runOperation(operation: "half_size" | "quarter_size" | "remove_audio") {
    const ids = operation === "remove_audio" ? audioVideoIds : selectedIds;
    if (!ids.length) return;
    const label = operation === "half_size" ? "/2" : operation === "quarter_size" ? "/4" : "Remove audio";
    const warning = operation === "half_size"
      ? `Resize ${ids.length} selected item${ids.length === 1 ? "" : "s"} to 50% width and height? This replaces the original files.`
      : operation === "quarter_size"
        ? `Resize ${ids.length} selected item${ids.length === 1 ? "" : "s"} to 25% width and height? This replaces the original files.`
        : `Remove audio from ${ids.length} selected video${ids.length === 1 ? "" : "s"}? This replaces the original files.`;
    if (!confirm(warning)) return;

    setBusy(true);
    setOperationStatus(`${label} in progress…`);
    videoRef.current?.pause();
    try {
      const result = await processMedia(ids, operation);
      const message = resultMessage(label, result);
      setOperationStatus(message);
      alert(message);
      clear();
      bump();
    } catch (cause) {
      setOperationStatus(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runTrim(mode: "remove_start" | "remove_end") {
    if (!media || media.mediaType !== "video" || selectedIds.length !== 1) return;
    const player = videoRef.current;
    if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return;
    const position = player.currentTime;
    const edgeTolerance = 0.05;
    if (position <= edgeTolerance || position >= player.duration - edgeTolerance) {
      setOperationStatus("Move the video seeker away from the beginning and end before trimming.");
      return;
    }
    const label = mode === "remove_start" ? "Remove Start" : "Remove End";
    const kept = mode === "remove_start" ? player.duration - position : position;
    if (!confirm(`${label} at ${position.toFixed(2)} seconds? The resulting video will be approximately ${kept.toFixed(2)} seconds and will replace the original file.`)) return;

    setBusy(true);
    setOperationStatus(`${label} in progress…`);
    player.pause();
    try {
      const result = await trimVideo(media.id, mode, position);
      const message = resultMessage(label, result);
      setOperationStatus(message);
      alert(message);
      clear();
      bump();
    } catch (cause) {
      setOperationStatus(`${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  function openViewer() {
    videoRef.current?.pause();
    setViewerOpen(true);
  }

  return (
    <aside ref={inspectorRef} className="inspector">
      <div className="preview" style={{ height: previewHeight == null ? "calc(50% - 4.5px)" : previewHeight }} onDoubleClick={openViewer}>
        <button className="expand" onClick={openViewer}><Maximize2 size={16} /></button>
        {media.mediaType === "video"
          ? <video ref={videoRef} src={url} controls autoPlay={isAnimatedGif} loop={isAnimatedGif} muted={isAnimatedGif} playsInline onLoadedMetadata={(event) => { if (isAnimatedGif) void event.currentTarget.play().catch(() => undefined); }} />
          : <img src={url} alt={title} />}
        {collectionPages.length > 1 && <>
          <button className="collectionNav collectionPrev" onClick={(event) => { event.stopPropagation(); setCollectionIndex((value) => (value - 1 + collectionPages.length) % collectionPages.length); }} onDoubleClick={(event) => event.stopPropagation()}><ChevronLeft /></button>
          <button className="collectionNav collectionNext" onClick={(event) => { event.stopPropagation(); setCollectionIndex((value) => (value + 1) % collectionPages.length); }} onDoubleClick={(event) => event.stopPropagation()}><ChevronRight /></button>
          <span className="collectionCounter">{collectionIndex + 1} / {collectionPages.length}</span>
        </>}
      </div>
      <div
        ref={previewResizeHandleRef}
        className="previewResizeHandle"
        role="separator"
        aria-label="Resize image and video preview"
        aria-orientation="horizontal"
        aria-valuemin={MIN_PREVIEW_HEIGHT}
        aria-valuemax={MAX_PREVIEW_HEIGHT}
        aria-valuenow={Math.round(previewHeight ?? (inspectorRef.current?.clientHeight ?? MIN_PREVIEW_HEIGHT * 2) / 2)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          previewDragStart.current = { y: event.clientY, height: event.currentTarget.previousElementSibling?.getBoundingClientRect().height ?? MIN_PREVIEW_HEIGHT };
          setIsResizingPreview(true);
        }}
        onDoubleClick={() => {
          setPreviewHeight(null);
          localStorage.removeItem(PREVIEW_HEIGHT_STORAGE_KEY);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          setPreviewHeight((height) => {
            const currentHeight = height ?? previewResizeHandleRef.current?.previousElementSibling?.getBoundingClientRect().height ?? MIN_PREVIEW_HEIGHT;
            return Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, currentHeight + (event.key === "ArrowDown" ? 20 : -20)));
          });
        }}
      />

      <div className="inspectorBody">
        <div className="inspectorTitle">
          <div>
            <h2>{multiple ? `${selectedIds.length} items selected` : title}</h2>
            <p className="muted">{multiple ? "Bulk editing mode" : `${media.mediaType} · ${media.extension.toUpperCase()} · ${formatSize(media.filesize)}`}</p>
          </div>
          <button className="danger" disabled={busy} onClick={() => void removeSelected()}><Trash2 size={16} /> Delete</button>
        </div>

        <section>
          <h3>Save space</h3>
          <div className="mediaActions">
            <button disabled={busy} onClick={() => void runOperation("half_size")}>
              <Minimize2 size={16} /> /2
            </button>
            <button disabled={busy} onClick={() => void runOperation("quarter_size")}>
              <Minimize2 size={16} /> /4
            </button>
            {audioVideoIds.length > 0 && (
              <button disabled={busy} onClick={() => void runOperation("remove_audio")}>
                <VolumeX size={16} /> Remove audio
                {audioVideoIds.length !== selectedIds.length ? ` (${audioVideoIds.length})` : ""}
              </button>
            )}
            {!multiple && media.mediaType === "video" && (
              <>
                <button disabled={busy} onClick={() => void runTrim("remove_start")}>
                  <Scissors size={16} /> Remove Start
                </button>
                <button disabled={busy} onClick={() => void runTrim("remove_end")}>
                  <Scissors size={16} /> Remove End
                </button>
              </>
            )}
          </div>
          <p className="muted">/2 reduces width and height to 50%; /4 reduces both to 25%. Trim buttons cut at the video player’s current position. These actions replace the original stored file.</p>
          {operationStatus && <p className="operationStatus">{operationStatus}</p>}
        </section>

        <section>
          <h3>{multiple ? "Add tag to selection" : "Tags"}</h3>
          <form className="tagForm" onSubmit={submit}>
            <input list="category-options" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" />
            <datalist id="category-options">{categories.map((value) => <option key={value} value={value} />)}</datalist>
            <div className="tagInputRow">
              <input list="tag-options" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tag name" />
              <datalist id="tag-options">{filtered.map((tag) => <option key={tag.id} value={tag.name} />)}</datalist>
              <button className="primary" disabled={busy || !category.trim() || !name.trim()}>Add{multiple ? ` to ${selectedIds.length}` : ""}</button>
            </div>
          </form>
          {!multiple && (loading
            ? <p className="muted">Loading tags…</p>
            : <div className="tagList">{sortedTags.map((tag) => (
              <span
                className={`tag tag-${tag.category}`}
                key={tag.id}
                title="Double-click to add to search. Ctrl+click to search only this tag."
                onClick={(event) => {
                  const value = JSON.stringify(`${tag.category}:${tag.name}`);
                  if (event.ctrlKey || event.metaKey) setSearch(value);
                }}
                onDoubleClick={() => {
                  const value = JSON.stringify(`${tag.category}:${tag.name}`);
                  setSearch(useAppStore.getState().search.trim()
                    ? `${useAppStore.getState().search.trim()} ${value}`
                    : value);
                }}
              >
                <b style={(() => {
                  const appearance = categoryAppearance(tag.category);
                  return {
                    color: appearance.color,
                    WebkitTextStroke: appearance.outlineEnabled ? `3px ${appearance.outlineColor}` : undefined,
                    paintOrder: appearance.outlineEnabled ? "stroke fill" : undefined,
                  };
                })()}>{tag.category}</b>: {tag.name}
                <button
                  onClick={(event) => { event.stopPropagation(); void removeTag(tag.id); }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  aria-label={`Remove ${tag.name}`}
                ><X size={12} /></button>
              </span>
            ))}</div>)}
          {error && <p className="error">{error}</p>}
        </section>

        {!multiple && (
          <section className="sourceLinkSection">
            {media.sourceUrl && (
              <a className="sourceLink" href={media.sourceUrl} target="_blank" rel="noreferrer" title={media.sourceUrl}>
                <ExternalLink size={15} /> Link
              </a>
            )}
            <button
              className="sourceLink explorerLink"
              type="button"
              title="Show this file in Explorer"
              onClick={() => void invoke("reveal_media_file", { path: media.filePath })}
            >
              <FolderOpen size={15} /> Explorer
            </button>
          </section>
        )}

        {!multiple && (
          <section className="details">
            <h3>Details</h3>
            <p>{media.width && media.height ? `${media.width} × ${media.height}` : "Dimensions unavailable"}</p>
            <p>Added {new Date(media.addedAt).toLocaleString()}</p>
            <p className="break">{media.storedFilename}</p>
          </section>
        )}
      </div>
    </aside>
  );
}
