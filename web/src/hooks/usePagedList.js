import { useState } from 'react';

/**
 * Slice `items` into a page of `pageSize`, clamping `page` into [1, pageCount]
 * so a shrinking list (a filter, a delete) never points past the last page.
 * Exported for its unit test; usePagedList below is the thin useState wrapper.
 */
export function paginate(items, pageSize, page) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const curPage = Math.min(page, pageCount);
  return { page: curPage, pageCount, pageItems: items.slice((curPage - 1) * pageSize, curPage * pageSize) };
}

/**
 * Paginate `items` into `pageSize`-sized pages, resetting to page 1 whenever
 * `resetKey` changes — compared against the previous render's key here rather
 * than in an effect, so a filter/search/sort change lands on page 1 before
 * paint instead of flashing the old page first.
 */
export function usePagedList(items, pageSize, resetKey) {
  const [page, setPage] = useState(1);
  const [prevKey, setPrevKey] = useState(resetKey);
  if (resetKey !== prevKey) {
    setPrevKey(resetKey);
    setPage(1);
  }
  return { setPage, ...paginate(items, pageSize, page) };
}
