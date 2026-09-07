const retries = new Map<string, () => Promise<void>>();
export const registerSendRetry = (id: string, retry: () => Promise<void>) => {
  retries.set(id, retry);
};
export const forgetSendRetry = (id: string) => {
  retries.delete(id);
};
export const clearSendRetries = () => {
  retries.clear();
};
export const retryMessage = async (id: string) => {
  await retries.get(id)?.();
};
