export type AskFolioMessageElement = { scrollHeight: number; scrollTop: number };
export type AskFolioStorage = Pick<Storage, "removeItem">;

export function askFolioStorageKey(userId: string) {
  return `folio-chat:${userId}`;
}

export function clearAskFolioHistory(userId: string, storage: AskFolioStorage) {
  storage.removeItem(askFolioStorageKey(userId));
}

export function scrollAskFolioToLatest(element: AskFolioMessageElement) {
  element.scrollTop = element.scrollHeight;
}
