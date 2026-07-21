import { useCallback, useEffect, useRef, useState } from "react";
import { mediaProvider } from "@/providers/mediaProvider";
import { useAppStore } from "@/store/appStore";
import type { MediaRecord } from "@/types/media";
import { BOARDS_CHANGED } from "@/services/boardService";

const PAGE_SIZE = 80;

export function useMedia() {
  const search = useAppStore((s) => s.search);
  const from = useAppStore((s) => s.addedFrom);
  const to = useAppStore((s) => s.addedTo);
  const version = useAppStore((s) => s.libraryVersion);
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardVersion, setBoardVersion] = useState(0);
  const requestId = useRef(0);
  const loadedCountRef = useRef(0);

  useEffect(() => {
    loadedCountRef.current = media.length;
  }, [media.length]);

  useEffect(() => {
    const refreshBoards = () => setBoardVersion((value) => value + 1);
    window.addEventListener(BOARDS_CHANGED, refreshBoards);
    return () => window.removeEventListener(BOARDS_CHANGED, refreshBoards);
  }, []);

  const loadFirstPage = useCallback(async () => {
    const id = ++requestId.current;
    const currentlyLoaded = loadedCountRef.current;
    const refreshLimit = Math.max(PAGE_SIZE, currentlyLoaded);

    // Keep the existing virtual canvas mounted during background refreshes.
    // Replacing a long loaded list with only the first page temporarily shrinks
    // the scroll container, clamps scrollTop to zero, and leaves the virtualizer
    // rendering rows that no longer exist until the next scroll event.
    if (currentlyLoaded === 0) setLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const page = await mediaProvider.listMedia(search, from, to, 0, refreshLimit);
      if (id !== requestId.current) return;
      setMedia(page.items);
      setTotal(page.total);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
      if (currentlyLoaded === 0) {
        setMedia([]);
        setTotal(0);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [search, from, to, version, boardVersion]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || media.length >= total) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const page = await mediaProvider.listMedia(search, from, to, media.length, PAGE_SIZE);
      if (id !== requestId.current) return;
      setMedia((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setTotal(page.total);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setLoadingMore(false);
    }
  }, [loading, loadingMore, media.length, total, search, from, to]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadFirstPage(), 150);
    return () => window.clearTimeout(id);
  }, [loadFirstPage]);

  return { media, total, loading, loadingMore, error, refresh: loadFirstPage, loadMore, hasMore: media.length < total };
}
