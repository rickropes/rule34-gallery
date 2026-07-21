import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";

import {AppGate} from "./app/AppGate";
import MainLayout from "./app/MainLayout";

import GalleryPage from "./features/gallery/GalleryPage";
import SettingsPage from "./features/settings/SettingsPage";
import BoardsPage from "./features/boards/BoardsPage";
import BoardCanvasPage from "./features/boards/BoardCanvasPage";

export default function App() {
  return (
    <AppGate>
      <BrowserRouter>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<GalleryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/boards" element={<BoardsPage />} />
            <Route path="/boards/:id" element={<BoardCanvasPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppGate>
  );
}