import type { Step } from "./Step";

export interface Image {
  id: number;
  url: string;
  active: boolean;
  step?: Step | number;
}
