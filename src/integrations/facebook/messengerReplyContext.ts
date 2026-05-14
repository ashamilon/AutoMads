import { AsyncLocalStorage } from "node:async_hooks";

type Store = { replyToMid: string | undefined };

const messengerReplyAls = new AsyncLocalStorage<Store>();

/**
 * While handling one inbound webhook turn, outbound sends should thread under the
 * customer's message id so replies show as "replies" in Messenger.
 */
export function runWithMessengerReplyTo<T>(customerMessageMid: string | undefined, fn: () => Promise<T>): Promise<T> {
  return messengerReplyAls.run({ replyToMid: customerMessageMid }, fn);
}

export function getMessengerReplyToMidFromContext(): string | undefined {
  return messengerReplyAls.getStore()?.replyToMid;
}
