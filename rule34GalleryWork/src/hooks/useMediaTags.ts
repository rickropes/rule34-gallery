import { useCallback, useEffect, useState } from "react";

import {
  createMediaTag,
  deleteMediaTag,
  getMediaTags,
  type TagRecord,
} from "@/services/tagService";

export function useMediaTags(
  mediaId: number | null,
) {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (mediaId === null) {
      setTags([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await getMediaTags(mediaId);
      setTags(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : String(cause),
      );
    } finally {
      setLoading(false);
    }
  }, [mediaId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addTag = useCallback(
    async (
      name: string,
      category = "general",
    ) => {
      if (mediaId === null) {
        return;
      }

      setError(null);

      try {
        const tag = await createMediaTag(
          mediaId,
          name,
          category,
        );

        setTags((current) => {
          const alreadyExists = current.some(
            (item) => item.id === tag.id,
          );

          if (alreadyExists) {
            return current;
          }

          return [...current, tag].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        });
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : String(cause),
        );

        throw cause;
      }
    },
    [mediaId],
  );

  const removeTag = useCallback(
    async (tagId: number) => {
      if (mediaId === null) {
        return;
      }

      setError(null);

      try {
        await deleteMediaTag(mediaId, tagId);

        setTags((current) =>
          current.filter((tag) => tag.id !== tagId),
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : String(cause),
        );

        throw cause;
      }
    },
    [mediaId],
  );

  return {
    tags,
    loading,
    error,
    refresh,
    addTag,
    removeTag,
  };
}