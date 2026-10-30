/**
 * Chats that may feed anything combining businesses: other businesses' starting prices, the proof
 * report and model replays. Meta's terms keep a WhatsApp chat, and everything taken from it, with
 * the business it came to, so those are left out here. Each business's own Charm still learns from
 * its own WhatsApp chats. Owners' tests are left out too, since they aren't real jobs.
 */
export const pooledChat = (alias: string) => `${alias}.source NOT IN ('test','whatsapp')`;
