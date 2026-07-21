import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMedia } from "@/hooks/useMedia";
import { useAppStore } from "@/store/appStore";
import MediaCard from "./MediaCard";

const MIN_CARD_WIDTH = 170;
const GAP = 14;
const OVERSCAN_ROWS = 4;

export default function GalleryPage() {
  const { media, total, loading, loadingMore, error, refresh, loadMore, hasMore } = useMedia();
  const search = useAppStore((s) => s.search);
  const selected = useAppStore((s) => s.selectedIds.length);
  const setGalleryMedia = useAppStore((s) => s.setGalleryMedia);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    let frame = 0;
    let lastWidth = -1;
    let lastHeight = -1;

    const measureContinuously = () => {
      const viewport = viewportRef.current;
      if (viewport) {
        const bounds = viewport.getBoundingClientRect();
        const width = Math.max(0, Math.round(bounds.width));
        const height = Math.max(0, Math.round(bounds.height));

        if (width !== lastWidth) {
          lastWidth = width;
          setViewportWidth(width);
        }
        if (height !== lastHeight) {
          lastHeight = height;
          setViewportHeight(height);
        }
      }

      frame = requestAnimationFrame(measureContinuously);
    };

    frame = requestAnimationFrame(measureContinuously);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setGalleryMedia(media);
  }, [media, setGalleryMedia]);

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [search]);

  const measuredWidth = viewportWidth || viewportRef.current?.clientWidth || Math.max(MIN_CARD_WIDTH, window.innerWidth - 430);
  const columnCount = Math.max(1, Math.floor((measuredWidth + GAP) / (MIN_CARD_WIDTH + GAP)));
  const cardWidth = (measuredWidth - GAP * (columnCount - 1)) / columnCount;
  const rowHeight = cardWidth + GAP;
  const rowCount = Math.ceil(media.length / columnCount);
  const totalHeight = Math.max(0, rowCount * rowHeight - (rowCount ? GAP : 0));
  const visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const visibleEnd = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS);

  const visibleRows = useMemo(
    () => Array.from({ length: Math.max(0, visibleEnd - visibleStart) }, (_, index) => visibleStart + index),
    [visibleStart, visibleEnd],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const actualScrollTop = viewport.scrollTop;
    if (actualScrollTop !== scrollTop) setScrollTop(actualScrollTop);
  }, [media.length, columnCount, rowHeight, totalHeight, scrollTop]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setScrollTop(viewport.scrollTop);
    const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (hasMore && !loadingMore && remaining < Math.max(900, rowHeight * 4)) void loadMore();
  }, [hasMore, loadingMore, loadMore, rowHeight]);

  useEffect(() => {
    if (!loading && hasMore && totalHeight <= viewportHeight + 900) void loadMore();
  }, [loading, hasMore, totalHeight, viewportHeight, loadMore]);

  if (loading) return <div className="state">Loading library…</div>;
  if (error && media.length === 0) return <div className="state error">Failed to load: {error}<button onClick={() => void refresh()}>Retry</button></div>;

  return <div className="galleryPage">
    <div className="pageHeading"><div><p>{total} result{total===1?"":"s"}{search?` for “${search}”`:""}{selected>1?` · ${selected} selected`:""}</p></div></div>
    {media.length===0?<div className="state">No media matches. Import files or change the filters.</div>:<>
      <div ref={viewportRef} className="galleryVirtualViewport" onScroll={handleScroll}>
        <div className="galleryVirtualCanvas" style={{ height: totalHeight }}>
          {visibleRows.flatMap((rowIndex) => {
            const start = rowIndex * columnCount;
            return media.slice(start, start + columnCount).map((item, columnIndex) => (
              <div
                key={item.id}
                className="galleryVirtualCell"
                style={{
                  width: cardWidth,
                  transform: `translate3d(${columnIndex * (cardWidth + GAP)}px, ${rowIndex * rowHeight}px, 0)`,
                }}
              >
                <MediaCard media={item} />
              </div>
            ));
          })}
        </div>
        {loadingMore&&<div className="galleryLoading galleryLoadingOverlay">Loading more…</div>}
        {!hasMore&&total>80&&<div className="galleryLoading">All {total} items loaded</div>}
        {error&&<div className="galleryLoading error">Could not load more items. Scroll again or refresh.</div>}
      </div>
    </>}
  </div>;
}
