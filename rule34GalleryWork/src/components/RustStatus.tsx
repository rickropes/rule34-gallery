import { useEffect, useState } from "react";
import { ping } from "@/tauri/mediaApi";

export default function RustStatus() {
  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    ping()
      .then((result) => setStatus(`Rust: ${result}`))
      .catch(() => setStatus("Rust: Offline"));
  }, []);

  return (
    <span className="text-xs text-zinc-400">
      {status}
    </span>
  );
}