import { LifecycleStage } from "./types";

export const lifecycleLog: LifecycleStage[] = [];

export const logStage = (stage: LifecycleStage): void => {
  lifecycleLog.push(stage);
};

export const resetLifecycleLog = (): void => {
  lifecycleLog.length = 0;
};
