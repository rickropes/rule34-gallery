export interface CategoryPreference {
  category: string;
  color: string;
  priority: number;
  outlineEnabled: boolean;
  outlineColor: string;
}

const STORAGE_KEY = "rule34-library-category-preferences-v1";
export const CATEGORY_PREFERENCES_EVENT = "category-preferences-changed";

const DEFAULT_COLORS: Record<string, string> = {
  artist: "#f87171",
  metadata: "#fb923c",
  copyright: "#c084fc",
  character: "#4ade80",
};

export function defaultCategoryColor(category: string): string {
  return DEFAULT_COLORS[category.toLowerCase()] ?? "#93c5fd";
}

export function loadCategoryPreferences(categories: string[] = []): CategoryPreference[] {
  let saved: CategoryPreference[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      saved = parsed
        .filter((item): item is Partial<CategoryPreference> & Pick<CategoryPreference, "category" | "color" | "priority"> =>
          !!item && typeof item === "object" &&
          typeof (item as CategoryPreference).category === "string" &&
          typeof (item as CategoryPreference).color === "string" &&
          typeof (item as CategoryPreference).priority === "number")
        .map((item) => ({
          category: item.category,
          color: item.color,
          priority: item.priority,
          outlineEnabled: item.outlineEnabled === true,
          outlineColor: typeof item.outlineColor === "string" ? item.outlineColor : "#000000",
        }));
    }
  } catch {
    saved = [];
  }

  const byCategory = new Map(saved.map((item) => [item.category.toLowerCase(), item]));
  const ordered = [...saved].sort((a, b) => a.priority - b.priority);
  for (const category of categories) {
    if (!byCategory.has(category.toLowerCase())) {
      ordered.push({ category, color: defaultCategoryColor(category), priority: ordered.length, outlineEnabled: false, outlineColor: "#000000" });
    }
  }
  return ordered.map((item, priority) => ({ ...item, priority }));
}

export function saveCategoryPreferences(preferences: CategoryPreference[]): void {
  const normalized = preferences.map((item, priority) => ({ ...item, priority }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(CATEGORY_PREFERENCES_EVENT));
}
