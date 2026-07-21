import { useState } from "react";

import { initializeLibrary } from "@/services/settingsService";
import { useAppStore } from "@/store/appStore";

export function LibrarySetup() {
  const [isCreating, setIsCreating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const setLibraryPath = useAppStore((state) => state.setLibraryPath);
  const setLibraryStatus = useAppStore(
    (state) => state.setLibraryStatus,
  );
  const setLibraryError = useAppStore(
    (state) => state.setLibraryError,
  );

    const startupMessage = useAppStore(
        (state) => state.libraryError,
    );

  async function handleCreateLibrary(): Promise<void> {
    setIsCreating(true);
    setLocalError(null);

    try {
      const path = await initializeLibrary();

      // The user closed the folder picker.
      if (!path) {
        return;
      }

      setLibraryPath(path);
      setLibraryError(null);
      setLibraryStatus("ready");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      setLocalError(message);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100">
      <section className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-8 shadow-xl">
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium text-zinc-400">
            Media Library
          </p>

          <h1 className="text-2xl font-semibold">
            Choose where to store your library
          </h1>

          <p className="mt-3 text-sm leading-6 text-zinc-400">
            The application will create folders for images, videos,
            thumbnails, and metadata inside the selected directory.
          </p>
        </div>

        <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-400">
          <div>media/images</div>
          <div>media/videos</div>
          <div>cache/thumbnails</div>
          <div>metadata</div>
        </div>

        {localError && (
          <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            {localError}
          </div>
        )}

        {startupMessage && !localError && (
        <div className="mb-4 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-300">
            {startupMessage}
        </div>
        )}

        <button
          type="button"
          disabled={isCreating}
          onClick={() => void handleCreateLibrary()}
          className="w-full rounded-lg bg-zinc-100 px-4 py-3 font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCreating ? "Creating library…" : "Choose Library Folder"}
        </button>
      </section>
    </main>
  );
}