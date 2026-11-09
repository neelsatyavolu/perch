/** Plans a full-page capture as a column of viewport-high strips. */

export type Tile = { y: number; height: number };
export type TilePlan = { height: number; truncated: boolean; tiles: Tile[] };

/** Chrome's canvas limit is 32,767 pixels on a side; stay under it. */
export const MAX_DEVICE_PIXELS = 32_000;

export function planTiles(page: { pageHeight: number; viewportHeight: number; dpr: number; maxDevicePixels?: number }): TilePlan {
  const { pageHeight, viewportHeight, dpr } = page;
  for (const [name, value] of Object.entries({ pageHeight, viewportHeight, dpr })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  const limit = Math.floor((page.maxDevicePixels ?? MAX_DEVICE_PIXELS) / dpr);
  const height = Math.min(Math.ceil(pageHeight), limit);
  const step = Math.floor(viewportHeight);
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += step) tiles.push({ y, height: Math.min(step, height - y) });
  return { height, truncated: pageHeight > limit, tiles };
}
