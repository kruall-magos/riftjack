import { basename, relative } from 'node:path';
import { PublicError, errorMessage } from './errors.js';
import { outgoingAttachments, safeName, validateOutgoing, type BackendReply, type OutgoingAttachment } from './media.js';

export type SendAttachments = (files: OutgoingAttachment[], signal: AbortSignal) => Promise<void>;
type Receipt = { path: string; name: string; status: 'sent' | 'uncertain' | 'not_sent'; error?: string };

// Turn-local receipts prevent retries (including final manifests) from duplicating
// messages when a response is lost. This is not a cross-turn delivery ledger.
export function attachmentDelivery(root: string, maxBytes: number, send: SendAttachments) {
  const attempted = new Map<string, Receipt>();
  let busy = false;
  return {
    async action(input: unknown, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'files')) {
        throw new PublicError('Supply only files; the destination is the current conversation.');
      }
      const files = outgoingAttachments(input, root);
      if (!files.length) throw new PublicError('Supply at least one attachment.');
      if ((input as { files: object[] }).files.some(file => Object.keys(file).some(k => k !== 'path' && k !== 'name'))) {
        throw new PublicError('Each attachment accepts only path and optional name.');
      }
      if (busy) throw new PublicError('An attachment delivery is already pending.');
      busy = true;
      try {
        // Reject the whole batch before sending anything if a new file is invalid.
        for (const file of files) if (!attempted.has(file.path)) await validateOutgoing(file, maxBytes);
        const receipts: Receipt[] = [];
        let stopped = false;
        for (const file of files) {
          const previous = attempted.get(file.path);
          if (previous) { receipts.push({ ...previous }); continue; }
          const receipt: Receipt = { path: relative(root, file.path), name: safeName(file.name || basename(file.path)), status: 'not_sent' };
          if (stopped || signal.aborted) { receipts.push(receipt); continue; }
          // Delivery may succeed even if its acknowledgement is lost. Never retry
          // this path automatically after entering the transport.
          receipt.status = 'uncertain';
          attempted.set(file.path, receipt);
          try {
            await send([file], signal);
            receipt.status = 'sent';
          } catch (error) {
            receipt.error = errorMessage(error, 'Delivery failed; inspect the conversation before retrying');
            stopped = true;
          }
          receipts.push({ ...receipt });
        }
        return JSON.stringify({ files: receipts });
      } finally { busy = false; }
    },
    final(reply: string | BackendReply): string | BackendReply {
      return typeof reply === 'string' ? reply : { ...reply, attachments: reply.attachments.filter(file => !attempted.has(file.path)) };
    },
  };
}
