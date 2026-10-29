export function shouldShowDock(homeOpen: boolean, settingsOpen: boolean): boolean { return homeOpen || settingsOpen }

export function clampHomeBounds(
  saved: { x: number; y: number; width: number; height: number } | undefined,
  areas: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number; width: number; height: number } {
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1440, height: 900 }
  const area = saved ? areas.find(a => saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y) ?? fallback : fallback
  const width = Math.min(saved?.width ?? 960, area.width), height = Math.min(saved?.height ?? 680, area.height)
  return { width: Math.round(width), height: Math.round(height), x: Math.round(Math.max(area.x, Math.min(saved?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(saved?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height))) }
}
