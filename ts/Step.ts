import type { Guide } from "./Guide";
import type { Image } from "./Image";
import type { StepType } from "./StepType.enum";

export type StepEventType = "click" | "submit";

export interface Step {
  id: number;
  title?: string;
  description?: string;
  type?: StepType;
  order?: number;
  guide?: Guide | number;
  images?: Image[];
  htmlTag?: string;
  eventType?: StepEventType;
  placeholder?: string;
  parentTitle?: string;
  url?: string;
  top?: number;
  left?: number;
  bottom?: number;
  right?: number;
  scrollX?: number;
  scrollY?: number;
  mousePosX?: number;
  mousePosY?: number;
  height?: number;
  width?: number;
  windowWidth?: number;
  windowHeight?: number;
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  recordingTimestampMs?: number;
  appendRecording?: boolean;
  insertBeforeStepId?: number;
}
