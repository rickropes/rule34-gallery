import { useLibraryStartup } from "@/hooks/useLibraryStartup";
import { LibrarySetup } from "@/features/settings/LibrarySetup";
import { useAppStore } from "@/store/appStore";

import { StartupError } from "./StartupError";
import { StartupScreen } from "./StartupScreen";

interface AppGateProps {
  children: React.ReactNode;
}

export function AppGate({ children }: AppGateProps) {
  useLibraryStartup();

  const status = useAppStore((state) => state.libraryStatus);
  const error = useAppStore((state) => state.libraryError);

  if (status === "loading") {
    return <StartupScreen />;
  }

  if (status === "unconfigured") {
    return <LibrarySetup />;
  }

  if (status === "error") {
    return (
      <StartupError
        message={error ?? "Unknown startup error"}
        onRetry={() => window.location.reload()}
      />
    );
  }

  return <>{children}</>;
}