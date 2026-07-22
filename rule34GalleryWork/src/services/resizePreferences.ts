export type ResizeFilter = "nearest" | "triangle" | "catmull_rom" | "gaussian" | "lanczos3";

const STORAGE_KEY = "rule34-library-resize-filter";
export const DEFAULT_RESIZE_FILTER: ResizeFilter = "nearest";

export const RESIZE_FILTER_OPTIONS: Array<{ value: ResizeFilter; label: string; description: string }> = [
  { value: "nearest", label: "Nearest Neighbor", description: "Fastest and sharpest; may look jagged on diagonals." },
  { value: "triangle", label: "Triangle (bilinear)", description: "Fast and smooth, but can look blurry." },
  { value: "catmull_rom", label: "Catmull-Rom", description: "Sharper high-quality resize with moderate processing time." },
  { value: "gaussian", label: "Gaussian", description: "Smooth high-quality resize with more processing time." },
  { value: "lanczos3", label: "Lanczos 3", description: "Highest detail retention, usually the slowest option." },
];

export function loadResizeFilter(): ResizeFilter {
  const value = localStorage.getItem(STORAGE_KEY);
  return RESIZE_FILTER_OPTIONS.some((option) => option.value === value)
    ? value as ResizeFilter
    : DEFAULT_RESIZE_FILTER;
}

export function saveResizeFilter(filter: ResizeFilter): void {
  localStorage.setItem(STORAGE_KEY, filter);
}
