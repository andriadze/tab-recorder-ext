export interface VideoRecordingOptions {
  microphone: boolean;
  webcam: boolean;
  showSteps: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
}

export interface VideoRecordingState {
  guideId: number;
  targetTabId?: number;
  active: boolean;
  status:
    | "starting"
    | "recording"
    | "stopping"
    | "uploading"
    | "failed"
    | "complete";
  options: VideoRecordingOptions;
  error?: string;
  uploadStartedAt?: number;
}
