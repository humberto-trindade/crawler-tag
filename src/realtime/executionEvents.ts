import { EventEmitter } from "node:events";

export type ExecutionEventPayload = {
  executionId: string;
  type: "status" | "warning" | "progress";
  data: Record<string, unknown>;
};

class ExecutionEvents extends EventEmitter {
  publish(payload: ExecutionEventPayload) {
    this.emit(`execution:${payload.executionId}`, payload);
  }

  subscribe(executionId: string, listener: (payload: ExecutionEventPayload) => void) {
    this.on(`execution:${executionId}`, listener);
    return () => this.off(`execution:${executionId}`, listener);
  }
}

export const executionEvents = new ExecutionEvents();
