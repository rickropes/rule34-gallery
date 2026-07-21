import { useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getMobileQueueSettings, setMobileQueueSettings } from "@/tauri/mobileQueueApi";
import { listTagCategories } from "@/providers/tagProvider";
import {
  loadCategoryPreferences,
  saveCategoryPreferences,
  type CategoryPreference,
} from "@/services/categoryPreferences";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [categoryPreferences, setCategoryPreferences] = useState<CategoryPreference[]>([]);

  useEffect(() => {
    void getMobileQueueSettings()
      .then((value) => { setEndpoint(value.endpoint); setToken(value.token); })
      .catch((error) => setMessage(String(error)));
    void listTagCategories()
      .then((categories) => setCategoryPreferences(loadCategoryPreferences(categories)))
      .catch(() => setCategoryPreferences(loadCategoryPreferences()));
  }, []);

  async function saveMobileQueue() {
    try {
      await setMobileQueueSettings(endpoint, token);
      setMessage("Mobile queue settings saved.");
    } catch (error) {
      setMessage(String(error));
    }
  }

  function updateColor(index: number, color: string) {
    setCategoryPreferences((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, color } : item));
  }

  function updateOutlineEnabled(index: number, outlineEnabled: boolean) {
    setCategoryPreferences((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, outlineEnabled } : item));
  }

  function updateOutlineColor(index: number, outlineColor: string) {
    setCategoryPreferences((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, outlineColor } : item));
  }

  function moveCategory(index: number, direction: -1 | 1) {
    setCategoryPreferences((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((item, priority) => ({ ...item, priority }));
    });
  }

  function saveCategories() {
    saveCategoryPreferences(categoryPreferences);
    setMessage("Category appearance and priorities saved.");
  }

  return (
    <div className="settingsPage">
      <button className="settingsBackButton" onClick={() => navigate("/")}><ArrowLeft size={17} /> Back to gallery</button>
      <h1>Settings</h1>

      <section className="settingsCard">
        <h2>Category appearance and priority</h2>
        <p>Choose each category’s text color, optional outline, and order. Higher categories appear first in the Inspector.</p>
        <div className="categoryPreferenceList">
          {categoryPreferences.map((item, index) => (
            <div className="categoryPreferenceRow" key={item.category}>
              <span className="categoryPriority">{index + 1}</span>
              <strong style={{
                color: item.color,
                WebkitTextStroke: item.outlineEnabled ? `3px ${item.outlineColor}` : undefined,
                paintOrder: item.outlineEnabled ? "stroke fill" : undefined,
              }}>{item.category}</strong>
              <div className="categoryAppearanceControls">
                <label className="categoryColorControl">
                  Text color
                  <input type="color" value={item.color} onChange={(event) => updateColor(index, event.target.value)} />
                </label>
                <label className="categoryOutlineToggle">
                  <input type="checkbox" checked={item.outlineEnabled} onChange={(event) => updateOutlineEnabled(index, event.target.checked)} />
                  Outline
                </label>
                <label className="categoryColorControl">
                  Outline color
                  <input type="color" value={item.outlineColor} disabled={!item.outlineEnabled} onChange={(event) => updateOutlineColor(index, event.target.value)} />
                </label>
              </div>
              <div className="categoryOrderButtons">
                <button type="button" disabled={index === 0} onClick={() => moveCategory(index, -1)} aria-label={`Move ${item.category} up`}><ArrowUp size={16} /></button>
                <button type="button" disabled={index === categoryPreferences.length - 1} onClick={() => moveCategory(index, 1)} aria-label={`Move ${item.category} down`}><ArrowDown size={16} /></button>
              </div>
            </div>
          ))}
        </div>
        <button className="primary" onClick={saveCategories}>Save category settings</button>
      </section>

      <section className="settingsCard">
        <h2>Mobile share queue</h2>
        <p>Paste the deployed Google Apps Script web-app URL and the same private token used by the Android app.</p>
        <label>Apps Script endpoint<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://script.google.com/macros/s/.../exec" /></label>
        <label>Private token<input value={token} onChange={(event) => setToken(event.target.value)} type="password" placeholder="A long random secret" /></label>
        <button className="primary" onClick={() => void saveMobileQueue()}>Save mobile queue</button>
      </section>
      {message && <p className="settingsMessage">{message}</p>}
    </div>
  );
}
