import { Heart, Play, Check, BookOpen } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import type { MediaRecord } from "@/types/media";
import { getMediaUrl } from "@/services/mediaService";

export default function MediaCard({ media }: { media: MediaRecord }) {
  const selected = useAppStore((state) => state.selectedIds.includes(media.id));
  const toggle = useAppStore((state) => state.toggleSelected);
  const title = media.originalFilename ?? media.storedFilename;
  const url = getMediaUrl(media.filePath);

  return (
    <button
      className={`mediaCard ${selected ? "selected" : ""}`}
      title={title}
      aria-label={`Select ${title}`}
      onClick={(event) => toggle(media, event.ctrlKey || event.metaKey || event.shiftKey)}
    >
      <div className="thumb">
        {media.mediaType === "image"
          ? <img src={url} alt={title} loading="lazy" />
          : <video src={url} muted preload="metadata" />}
        {media.mediaType === "video" && (
          media.isAnimatedGif
            ? <span className="mediaTypeBadge gifBadge">GIF</span>
            : <span className="mediaTypeBadge playBadge" aria-hidden="true"><Play size={17} fill="currentColor" /></span>
        )}
        {media.collectionPageCount > 0 && <span className="mediaTypeBadge collectionBadge" aria-label={`${media.collectionPageCount} page collection`}><BookOpen size={17} /><b>{media.collectionPageCount}</b></span>}
        {media.favorite && <Heart className="favorite" fill="currentColor" />}
        {selected && <span className="selectionMark"><Check size={15} /></span>}
      </div>
    </button>
  );
}
