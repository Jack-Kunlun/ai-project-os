export const DEFAULT_LIST_PAGE_SIZE = 20;
export const MAX_LIST_PAGE_SIZE = 50;

export type ListPagination = Readonly<{
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}>;

export function listPagination(page: number, pageSize: number, total: number): ListPagination {
  return Object.freeze({
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

