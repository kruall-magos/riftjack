import { MatrixClient } from '@vector-im/matrix-bot-sdk';

// Unlike model tasks, durable inbox writes must finish before saving /sync's
// next_batch. Failures keep the previous checkpoint on disk for restart replay.
export class WorkerMatrixClient extends MatrixClient {
  inbox?: (room: string, event: any) => Promise<void>;
  protected override async startSyncInternal() {
    this.persistTokenAfterSync = true;
    return this.startSync(async (type, ...args) => {
      if (type === 'room.message' || (type === 'room.event' && args[1]?.type === 'm.reaction')) {
        try { await this.inbox?.(args[0], args[1]); }
        catch (error) { this.stop(); this.emit('worker.inbox_failure', error); throw error; }
      }
      this.emit(type, ...args);
    });
  }
}
