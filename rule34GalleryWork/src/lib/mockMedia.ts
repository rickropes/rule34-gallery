import type { MediaRecord } from "@/types/media";

export const mockMedia: MediaRecord[] = Array.from(
  { length: 120 },
  (_, i) => ({
    id: i + 1,
    hash: `hash_${i}`,
    originalFilename: `image_${i}.jpg`,
    storedFilename: `hash_${i}.jpg`,
    extension: "jpg",
    mediaType: i % 5 === 0 ? "video" : "image",
    width: 1920,
    height: 1080,
    filesize: 1_234_567,
    favorite: i % 7 === 0,
    addedAt: "2026-07-20",
    filePath: `/mock/hash_${i}.jpg`,
    sourceUrl: null,
    isAnimatedGif: false, collectionId: null, collectionPageCount: 0,
  }),
);