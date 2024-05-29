import type { Step } from "./Step";

export interface Guide {
  id: number;
  name?: string;
  description?: string;
  active?: boolean;
  steps?: Step[];
}
