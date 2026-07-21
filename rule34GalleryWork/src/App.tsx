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

export default function App() {
  return (
    <AppGate>
      <BrowserRouter>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<GalleryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppGate>
  );
}