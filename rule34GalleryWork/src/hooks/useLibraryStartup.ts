import { useEffect } from "react";

import { useAppStore } from "@/store/appStore";
import { openConfiguredLibrary } from "@/tauri/libraryApi";

export function useLibraryStartup(): void {
  const setLibraryPath = useAppStore(
    (state) => state.setLibraryPath,
  );
  const setLibraryStatus = useAppStore(
    (state) => state.setLibraryStatus,
  );
  const setLibraryError = useAppStore(
    (state) => state.setLibraryError,
  );

  useEffect(() => {
    let cancelled = false;

    async function loadLibrary(): Promise<void> {
      setLibraryStatus("loading");
      setLibraryError(null);

      try {
        const result = await openConfiguredLibrary();

        if (cancelled) {
          return;
        }

        if (result.valid && result.path) {
          setLibraryPath(result.path);
          setLibraryStatus("ready");
          return;
        }

        setLibraryPath(null);

        // A missing or incomplete folder should send the user
        // back to setup rather than crashing the application.
        setLibraryError(result.reason);
        setLibraryStatus("unconfigured");
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error ? error.message : String(error);

        setLibraryPath(null);
        setLibraryError(message);
        setLibraryStatus("error");
      }
    }

    void loadLibrary();

    return () => {
      cancelled = true;
    };
  }, [
    setLibraryError,
    setLibraryPath,
    setLibraryStatus,
  ]);
}