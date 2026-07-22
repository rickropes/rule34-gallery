import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeBoardStorage } from "@/services/boardService";

async function start() {
  // Load the app-data copy before React reads boards. This makes debug and
  // release builds share the same board database despite different web origins.
  await initializeBoardStorage();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
