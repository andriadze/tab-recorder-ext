import {
  finishAppendRecordingApi,
  markRecordedVideoUploadFailedApi,
  markRecordedVideoUploadStartedApi,
  stopRecordingApi,
} from "~api/guide.api";
import { sendMessageToActivePage } from "./messaging";
import type { Guide } from "~ts/Guide";
import type { VideoRecordingState } from "~ts/VideoRecording";
import { Storage } from "@plasmohq/storage";

const storage = new Storage();
const VIDEO_UPLOAD_TIMEOUT_ALARM = "guidemagic-video-upload-timeout";
const STOP_VIDEO_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      globalThis.setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function stopOffscreenVideoRecording() {
  console.info("[GuideMagic video] sending stop to recorder controller");
  const response = await withTimeout(
    chrome.runtime.sendMessage({
      target: "video-recorder",
      type: "STOP_VIDEO_RECORDING",
    }),
    STOP_VIDEO_TIMEOUT_MS,
    "Stopping video recording",
  );

  if (!response?.success) {
    throw new Error(response?.error || "Could not stop video recording");
  }
  console.info("[GuideMagic video] recorder controller accepted stop");
}

async function sendMessageToRecordedTab(guide: Guide, message: string) {
  if (!guide.recordingTabId) {
    sendMessageToActivePage(message);
    return;
  }

  await chrome.tabs
    .sendMessage(guide.recordingTabId, { message })
    .catch(() => sendMessageToActivePage(message));
}

async function stopVideoGuideRecording(guide: Guide) {
  const stoppedGuide = { ...guide, active: false };
  await storage.set("guide", stoppedGuide);
  await sendMessageToRecordedTab(guide, "stopVideoPreview");

  const videoState: VideoRecordingState = {
    guideId: guide.id,
    targetTabId: guide.recordingTabId,
    active: false,
    status: "uploading",
    options: guide.videoRecording || {
      microphone: false,
      webcam: false,
      showSteps: true,
    },
    uploadStartedAt: Date.now(),
  };
  await storage.remove("guide");
  await storage.set("videoRecording", videoState);
  await markRecordedVideoUploadStartedApi(guide.id).catch(() => undefined);
  chrome.alarms.create(VIDEO_UPLOAD_TIMEOUT_ALARM, {
    delayInMinutes: 20,
  });

  stopOffscreenVideoRecording().catch((error) => {
    console.error("[GuideMagic video] recorder controller stop failed", {
      guideId: guide.id,
      error,
    });
    void markRecordedVideoUploadFailedApi(
      guide.id,
      error instanceof Error ? error.message : "Could not stop video recording",
    );
  });

  if ((guide.stepCount || 0) > 0) {
    void stopRecordingApi(guide.id).catch(() => undefined);
  }

  await chrome.tabs.create({
    url: `${process.env.PLASMO_PUBLIC_APP_ROUTE}/guides/${guide.id}`,
  });
}

async function closeRecorderTab() {
  const recorderTabId = await storage.get<number>("videoRecorderTabId");
  const recorderWindowId = await storage.get<number>("videoRecorderWindowId");
  await storage.remove("videoRecorderTabId");
  await storage.remove("videoRecorderWindowId");

  if (recorderTabId) {
    await chrome.tabs.remove(recorderTabId).catch(() => undefined);
    return;
  }

  if (recorderWindowId) {
    await chrome.windows.remove(recorderWindowId).catch(() => undefined);
  }
}

async function cancelVideoSetupRecording(guide: Guide) {
  await stopOffscreenVideoRecording().catch(() => undefined);
  await storage.remove("guide");
  await storage.remove("videoRecording");
  await stopRecordingApi(guide.id).catch(() => undefined);
  await closeRecorderTab();
}

export async function stopRecording() {
  const guide = await storage.get<Guide>("guide");
  if (!guide?.id) {
    const videoRecording = await storage.get<VideoRecordingState>(
      "videoRecording",
    );
    if (videoRecording?.guideId && videoRecording.active) {
      if (videoRecording.status === "starting") {
        await cancelVideoSetupRecording({
          id: videoRecording.guideId,
          active: false,
          stepCount: 0,
          recordingMode: "video",
          recordingTabId: videoRecording.targetTabId,
          videoRecording: videoRecording.options,
        });
        return;
      }

      await stopVideoGuideRecording({
        id: videoRecording.guideId,
        active: false,
        stepCount: 0,
        recordingMode: "video",
        recordingTabId: videoRecording.targetTabId,
        videoRecording: videoRecording.options,
      });
    }
    return;
  }

  const stoppedGuide = { ...guide, active: false };

  if (guide.recordingMode === "video") {
    const videoRecording = await storage.get<VideoRecordingState>(
      "videoRecording",
    );
    if (videoRecording?.status === "starting") {
      await cancelVideoSetupRecording(guide);
      return;
    }

    await sendMessageToRecordedTab(guide, "stopRecording");
    await stopVideoGuideRecording(guide);
    return;
  }

  await sendMessageToRecordedTab(guide, "stopRecording");

  if (guide.recordingMode === "append" && guide.appendRecording) {
    await finishAppendRecordingApi(
      guide.id,
      guide.appendRecording.recordedStepIds,
    );
    await storage.set("guide", stoppedGuide);
    await storage.remove("pendingAppendRecording");

    const returnTabId = guide.appendRecording.returnTabId;
    if (returnTabId != null) {
      try {
        await chrome.tabs.get(returnTabId);
        await chrome.tabs.update(returnTabId, { active: true });
        await chrome.tabs.sendMessage(returnTabId, {
          type: "APPEND_RECORDING_COMPLETE",
          guideId: guide.id,
        });
        return;
      } catch {
        // The original guide tab was closed; open a replacement below.
      }
    }

    await chrome.tabs.create({
      url: `${process.env.PLASMO_PUBLIC_APP_ROUTE}/guides/${guide.id}`,
    });
    return;
  }

  await storage.set("guide", stoppedGuide);
  await stopRecordingApi(guide.id);

  if (guide.stepCount > 0) {
    chrome.tabs.create({
      url: `${process.env.PLASMO_PUBLIC_APP_ROUTE}/guides/${stoppedGuide.id}`,
    });
  }
}
