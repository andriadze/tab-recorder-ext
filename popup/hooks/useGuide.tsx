import { useEffect, useState } from "react";
import { Storage } from "@plasmohq/storage";
import {
  markRecordedVideoUploadFailedApi,
  startAppendRecordingApi,
  startRecordingApi,
  stopRecordingApi,
} from "../../api/guide.api";
import type { Guide } from "~ts/Guide";
import type { PendingAppendRecordingContext } from "~ts/AppendRecording";
import type {
  VideoRecordingOptions,
  VideoRecordingState,
} from "~ts/VideoRecording";
import { sendMessageToActivePage } from "~util/messaging";
import { stopRecording as handleStopRecording } from "~util/stopRecording";

const storage = new Storage();
const VIDEO_UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;

export function useGuide() {
  const [guide, setGuide] = useState<null | Guide>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoRecording, setVideoRecording] =
    useState<VideoRecordingState | null>(null);
  const [pendingAppend, setPendingAppend] =
    useState<PendingAppendRecordingContext | null>(null);

  const initGuide = async () => {
    try {
      const currGuide = await storage.get<Guide>("guide");
      let appendContext = await storage.get<PendingAppendRecordingContext>(
        "pendingAppendRecording",
      );
      if (!appendContext) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        appendContext = await storage.get<PendingAppendRecordingContext>(
          "pendingAppendRecording",
        );
      }
      const currentVideoRecording =
        (await storage.get<VideoRecordingState>("videoRecording")) || null;
      if (
        currentVideoRecording?.status === "uploading" &&
        (!currentVideoRecording.uploadStartedAt ||
          Date.now() - currentVideoRecording.uploadStartedAt >
            VIDEO_UPLOAD_TIMEOUT_MS)
      ) {
        const failedState: VideoRecordingState = {
          ...currentVideoRecording,
          active: false,
          status: "failed",
          error: "Video upload timed out. Please try recording again.",
        };
        await markRecordedVideoUploadFailedApi(
          currentVideoRecording.guideId,
          failedState.error,
        ).catch(() => undefined);
        await storage.set("videoRecording", failedState);
        setVideoRecording(failedState);
      } else {
        setVideoRecording(currentVideoRecording);
      }
      setGuide(currGuide || null);
      setPendingAppend(appendContext || null);
    } catch {
      setError("Could not load the current recording");
    } finally {
      setLoading(false);
    }
  };

  const getActiveTabId = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  };

  const sendMessageToTab = async (tabId: number, message: string) => {
    await chrome.tabs
      .sendMessage(tabId, { message })
      .catch(() => undefined);
  };

  const startRecording = async () => {
    if (actionPending) {
      return false;
    }

    setActionPending(true);
    setError(null);

    try {
      if (guide?.active) {
        throw new Error("Stop the current recording before starting another");
      }

      sendMessageToActivePage("recordingStarting");
      if (pendingAppend) {
        const validated = await startAppendRecordingApi(
          pendingAppend.guideId,
          pendingAppend.insertBeforeStepId,
        );
        const appendGuide: Guide = {
          id: validated.guideId,
          name: validated.guideName,
          active: true,
          stepCount: 0,
          recordingMode: "append",
          appendRecording: {
            ...pendingAppend,
            guideId: validated.guideId,
            guideName: validated.guideName,
            insertBeforeStepId: validated.insertBeforeStepId,
            recordedStepIds: [],
          },
        };
        await storage.set("guide", appendGuide);
        await storage.remove("pendingAppendRecording");
        setPendingAppend(null);
        setGuide(appendGuide);
        sendMessageToActivePage("startRecording");
        return true;
      }

      const newGuide = await startRecordingApi();
      if (!newGuide) {
        throw new Error("Guide creation failed");
      }

      const recordingGuide = { ...newGuide, recordingMode: "new-guide" };
      await storage.set("guide", recordingGuide);
      setGuide(recordingGuide);
      sendMessageToActivePage("startRecording");
      return true;
    } catch {
      sendMessageToActivePage("stopRecording");
      setError("Could not start recording. Please try again.");
      return false;
    } finally {
      setActionPending(false);
    }
  };

  const cancelPendingAppend = async () => {
    await storage.remove("pendingAppendRecording");
    setPendingAppend(null);
  };

  const stopRecording = async () => {
    if (!guide || actionPending) {
      return false;
    }

    setActionPending(true);
    setError(null);

    try {
      const stoppedGuide = { ...guide, active: false };
      await handleStopRecording();
      setGuide(stoppedGuide);
      return true;
    } catch {
      setGuide(guide);
      setError("Could not stop recording. Please try again.");
      return false;
    } finally {
      setActionPending(false);
    }
  };

  const startVideoRecording = async (
    options: VideoRecordingOptions = {
      microphone: false,
      webcam: false,
      showSteps: true,
    },
  ) => {
    if (actionPending) {
      return false;
    }

    setActionPending(true);
    setError(null);

    let createdGuide: Guide | null = null;
    let recordingTabId: number | undefined;

    try {
      if (guide?.active || videoRecording?.active) {
        throw new Error("Stop the current recording before starting another");
      }
      const targetTabId = await getActiveTabId();
      if (!targetTabId) {
        throw new Error("No active tab to record");
      }
      recordingTabId = targetTabId;
      const newGuide = await startRecordingApi();
      if (!newGuide) {
        throw new Error("Guide creation failed");
      }
      createdGuide = newGuide;
      const recordingGuide: Guide = {
        ...newGuide,
        active: true,
        stepCount: 0,
        recordingMode: "video",
        recordingTabId: targetTabId,
        videoRecording: options,
      };
      const recordingState: VideoRecordingState = {
        guideId: newGuide.id,
        targetTabId,
        active: true,
        status: "starting",
        options,
      };
      await storage.set("guide", recordingGuide);
      await storage.set("videoRecording", recordingState);
      setGuide(recordingGuide);
      setVideoRecording(recordingState);
      const response = await chrome.runtime.sendMessage({
        type: "START_GUIDEMAGIC_VIDEO_RECORDING",
        guideId: newGuide.id,
        targetTabId,
        options,
      });
      if (!response?.success) {
        throw new Error(response?.error || "Could not start video recording");
      }
      return true;
    } catch (error) {
      const fallbackTabId = await getActiveTabId().catch(() => undefined);
      const cleanupTabId = recordingTabId || fallbackTabId;
      if (cleanupTabId) {
        await sendMessageToTab(cleanupTabId, "stopVideoPreview");
        await sendMessageToTab(cleanupTabId, "stopRecording");
      } else {
        sendMessageToActivePage("stopRecording");
      }
      await storage.remove("guide");
      if (createdGuide?.id) {
        await stopRecordingApi(createdGuide.id).catch(() => undefined);
      }
      const failedState: VideoRecordingState = {
        ...(videoRecording || {
          guideId: 0,
          active: false,
          options,
          status: "failed",
        }),
        active: false,
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Could not start video recording",
      };
      await storage.set("videoRecording", failedState);
      setVideoRecording(failedState);
      setError(failedState.error || "Could not start video recording.");
      return false;
    } finally {
      setActionPending(false);
    }
  };

  const stopVideoRecording = async () => {
    if (!videoRecording || actionPending) {
      return false;
    }

    setActionPending(true);
    setError(null);

    try {
      await handleStopRecording();
      setGuide(null);
      window.close();
      return true;
    } catch {
      setVideoRecording(videoRecording);
      setError("Could not open the guide page. The recording is still running.");
      return false;
    } finally {
      setActionPending(false);
    }
  };

  const retryVideoUpload = async () => {
    if (!videoRecording || actionPending) {
      return false;
    }
    setActionPending(true);
    setError(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "RETRY_GUIDEMAGIC_VIDEO_UPLOAD",
      });
      if (!response?.success) {
        throw new Error(response?.error || "Could not retry video upload");
      }
      return true;
    } catch {
      setError("Could not retry video upload. Please keep this popup open and try again.");
      return false;
    } finally {
      setActionPending(false);
    }
  };

  useEffect(() => {
    initGuide();
  }, []);

  useEffect(() => {
    if (
      !videoRecording ||
      !["starting", "stopping", "uploading"].includes(videoRecording.status)
    ) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      const nextState =
        (await storage.get<VideoRecordingState>("videoRecording")) || null;
      setVideoRecording(nextState);
      if (!nextState) {
        setGuide(null);
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [videoRecording]);

  return {
    guide,
    videoRecording,
    loading,
    actionPending,
    error,
    pendingAppend,
    cancelPendingAppend,
    startRecording,
    stopRecording,
    startVideoRecording,
    stopVideoRecording,
    retryVideoUpload,
  };
}
