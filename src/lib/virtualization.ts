export interface VirtualRangeOptions {
  itemCount: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
  headerHeight?: number;
}

export interface VirtualRange {
  first: number;
  last: number;
}

export function virtualRange({
  itemCount,
  itemHeight,
  scrollTop,
  viewportHeight,
  overscan,
  headerHeight = 0,
}: VirtualRangeOptions): VirtualRange {
  if (itemCount <= 0) return { first: 0, last: 0 };

  const contentScrollTop = Math.max(0, scrollTop - headerHeight);
  const firstInViewport = Math.min(
    itemCount - 1,
    Math.floor(contentScrollTop / itemHeight),
  );
  const lastInViewport = Math.min(
    itemCount,
    Math.ceil((contentScrollTop + Math.max(1, viewportHeight)) / itemHeight),
  );
  const first = Math.max(0, firstInViewport - overscan);
  const last = Math.min(itemCount, Math.max(first + 1, lastInViewport + overscan));
  return { first, last };
}

export function scrollTopForIndex({
  index,
  itemHeight,
  scrollTop,
  viewportHeight,
}: {
  index: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
}): number {
  const itemTop = Math.max(0, index * itemHeight);
  const itemBottom = itemTop + itemHeight;
  if (itemTop < scrollTop) return itemTop;
  if (itemBottom > scrollTop + viewportHeight) {
    return Math.max(0, itemBottom - viewportHeight);
  }
  return scrollTop;
}
