import type { Guide } from "./Guide";
import type { Image } from "./Image";
import type { StepType } from "./StepType.enum";

export interface Step {
  id: number;
  title?: string;
  description?: string;
  type?: StepType;
  order?: number;
  guide?: Guide | number;
  images?: Image[];
}
