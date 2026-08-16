import { applyCommand, normalizeCommand } from "./commands.js";
import { type CommandEnvelope, type CommandPayload, type CommandType, type ProjectDocumentV1 } from "./model.js";

export type SyncTransport = (command: CommandEnvelope) => Promise<ProjectDocumentV1>;

export class OptimisticCommandQueue {
  private queue: Promise<void> = Promise.resolve();
  private current: ProjectDocumentV1;

  public constructor(initial: ProjectDocumentV1, private readonly transport: SyncTransport) {
    this.current = initial;
  }

  public get project(): ProjectDocumentV1 { return this.current; }

  public dispatch(type: CommandType, payload: CommandPayload): CommandEnvelope {
    const baseRevision = this.current.revision;
    const command = normalizeCommand({ schemaVersion: 1, id: `sync-${baseRevision + 1}-${type}`, type, payload, expectedRevision: baseRevision });
    const result = applyCommand(this.current, command);
    this.current = result.project;
    const optimisticRevision = result.project.revision;
    this.queue = this.queue.then(async () => {
      const authoritative = await this.transport(command);
      if (this.current.revision === optimisticRevision) this.current = authoritative;
    });
    return command;
  }

  public async idle(): Promise<ProjectDocumentV1> {
    await this.queue;
    return this.current;
  }
}
