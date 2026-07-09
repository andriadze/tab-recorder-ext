import { Storage } from "@plasmohq/storage";
import {
  markRecordedVideoUploadFailedApi,
  stopRecordingApi,
} from "~api/guide.api";
import type { VideoRecordingOptions } from "~ts/VideoRecording";
import AuthHandler from "~util/AuthHandler";

const storage = new Storage();
const VIDEO_RECORDER_PATH = "tabs/video-recorder.html";
const VIDEO_UPLOAD_TIMEOUT_ALARM = "guidemagic-video-upload-timeout";
const VIDEO_UPLOAD_TIMEOUT_MINUTES = 20;

async function failVideoUpload(guideId: number, message: string) {
  await markRecordedVideoUploadFailedApi(guideId, message).catch(() => undefined);
  await storage.set("videoRecording", {
    guideId,
    active: false,
    status: "failed",
    options: { microphone: false, webcam: false, showSteps: true },
    error: message,
  });
}

async function cancelStartingVideoRecording(guideId: number) {
  await stopRecordingApi(guideId).catch(() => undefined);
  await storage.remove("guide");
  await storage.remove("videoRecording");
  await storage.remove("videoRecorderTabId");
  await storage.remove("videoRecorderWindowId");
}

async function openRecorderTab(
  guideId: number,
  options: VideoRecordingOptions,
  targetTabId?: number,
) {
  const params = new URLSearchParams({
    guideId: String(guideId),
    microphone: String(options.microphone),
    webcam: String(options.webcam),
    showSteps: String(options.showSteps),
  });
  if (targetTabId) {
    params.set("targetTabId", String(targetTabId));
  }

  const targetTab = targetTabId ? await chrome.tabs.get(targetTabId) : null;
  const recorderTab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`${VIDEO_RECORDER_PATH}?${params}`),
    active: true,
    pinned: true,
    index: 0,
    windowId: targetTab?.windowId,
  });

  await storage.set("videoRecorderTabId", recorderTab.id);
  await storage.set("videoRecorderWindowId", recorderTab.windowId);
}

async function startVideoRecording(
  guideId: number,
  options: VideoRecordingOptions,
  targetTabId?: number,
) {
  await openRecorderTab(guideId, options, targetTabId);
  const current = await storage.get<any>("videoRecording");

  await storage.set("videoRecording", {
    guideId,
    targetTabId: targetTabId || current?.targetTabId,
    active: true,
    status: "starting",
    options,
  });
}

async function stopVideoRecording() {
  const response = await chrome.runtime.sendMessage({
    target: "video-recorder",
    type: "STOP_VIDEO_RECORDING",
  });

  if (!response?.success) {
    throw new Error(response?.error || "Could not stop video recording");
  }
}

async function stopVideoRecordingWithFailureGuard() {
  const state = await storage.get<any>("videoRecording");
  try {
    await stopVideoRecording();
  } catch (error) {
    if (state?.guideId) {
      await failVideoUpload(
        state.guideId,
        error instanceof Error ? error.message : "Could not stop video recording",
      );
    }
    throw error;
  }
}

async function retryVideoUpload() {
  const response = await chrome.runtime.sendMessage({
    target: "video-recorder",
    type: "RETRY_VIDEO_UPLOAD",
  });

  if (!response?.success) {
    throw new Error(response?.error || "Could not retry video upload");
  }
}

async function getAccessToken(refresh?: boolean) {
  if (refresh) {
    const refreshed = await AuthHandler.refreshToken();
    if (!refreshed?.access_token) {
      throw new Error("User session is no longer valid");
    }
    return refreshed.access_token;
  }

  const token = await AuthHandler.getAccessToken();
  if (!token) {
    throw new Error("User session is no longer valid");
  }
  return token;
}

export function registerVideoRecordingBackground() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "START_GUIDEMAGIC_VIDEO_RECORDING") {
      startVideoRecording(message.guideId, message.options, message.targetTabId)
        .then(() => sendResponse({ success: true }))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    if (message?.type === "VIDEO_RECORDING_STARTED") {
      if (message.targetTabId) {
        void (async () => {
          const targetTabId = Number(message.targetTabId);
          await chrome.tabs
            .sendMessage(targetTabId, {
              message: "startRecording",
              options: message.options,
              recordingStartedAt: message.recordingStartedAt,
            })
            .catch(() => undefined);
          await chrome.tabs.update(targetTabId, { active: true }).catch(() => undefined);
          const current = await storage.get<any>("videoRecording");
          if (current?.guideId === message.guideId) {
            await storage.set("videoRecording", {
              ...current,
              active: true,
              status: "recording",
              options: message.options || current.options,
            });
          }
        })();
      }
    }

    if (message?.type === "STOP_GUIDEMAGIC_VIDEO_RECORDING") {
      stopVideoRecordingWithFailureGuard()
        .then(() => sendResponse({ success: true }))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    if (message?.type === "RETRY_GUIDEMAGIC_VIDEO_UPLOAD") {
      retryVideoUpload()
        .then(() => sendResponse({ success: true }))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    if (message?.type === "GET_GUIDEMAGIC_ACCESS_TOKEN") {
      getAccessToken(Boolean(message.refresh))
        .then((accessToken) => sendResponse({ success: true, accessToken }))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    if (message?.type === "GUIDEMAGIC_WEBRTC_PREVIEW_OFFER") {
      chrome.tabs
        .sendMessage(Number(message.targetTabId), {
          message: "guidemagicWebrtcPreviewOffer",
          offer: message.offer,
        })
        .then((response) => sendResponse(response))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    if (message?.type === "VIDEO_RECORDING_COMPLETE") {
      void chrome.alarms.clear(VIDEO_UPLOAD_TIMEOUT_ALARM);
      void storage.remove("videoRecording");
      void (async () => {
        const recorderTabId =
          sender.tab?.id || (await storage.get<number>("videoRecorderTabId"));
        const recorderWindowId = await storage.get<number>("videoRecorderWindowId");
        await storage.remove("videoRecorderTabId");
        await storage.remove("videoRecorderWindowId");
        if (recorderTabId) {
          await chrome.tabs.remove(recorderTabId).catch(() => undefined);
        } else if (recorderWindowId) {
          await chrome.windows.remove(recorderWindowId).catch(() => undefined);
        }
      })();
    }

    if (message?.type === "VIDEO_RECORDING_FAILED") {
      void (async () => {
        const state = await storage.get<any>("videoRecording");
        const guide = await storage.get<any>("guide");
        const targetTabId = state?.targetTabId || guide?.recordingTabId;
        if (targetTabId) {
          await chrome.tabs
            .sendMessage(targetTabId, { message: "stopVideoPreview" })
            .catch(() => undefined);
          await chrome.tabs
            .sendMessage(targetTabId, { message: "stopRecording" })
            .catch(() => undefined);
        }
        if (message.guideId) {
          await failVideoUpload(
            Number(message.guideId),
            message.error || "Video recording failed",
          );
        }
        await storage.remove("guide");
        await storage.remove("videoRecorderTabId");
        await storage.remove("videoRecorderWindowId");
      })();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const recorderTabId = await storage.get<number>("videoRecorderTabId");
      if (recorderTabId !== tabId) {
        return;
      }

      const state = await storage.get<any>("videoRecording");
      if (state?.status !== "starting" || !state.guideId) {
        await storage.remove("videoRecorderTabId");
        await storage.remove("videoRecorderWindowId");
        return;
      }

      await cancelStartingVideoRecording(Number(state.guideId));
    })();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== VIDEO_UPLOAD_TIMEOUT_ALARM) {
      return;
    }

    void (async () => {
      const state = await storage.get<any>("videoRecording");
      if (state?.status !== "uploading" || !state.guideId) {
        return;
      }
      await failVideoUpload(
        state.guideId,
        "Video upload timed out. Please try recording again.",
      );
    })();
  });
}
