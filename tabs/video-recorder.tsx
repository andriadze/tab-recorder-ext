import { Storage } from "@plasmohq/storage";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  VideoRecordingOptions,
  VideoRecordingState,
} from "~ts/VideoRecording";

const storage = new Storage();
const MAX_RECORDING_MS = 15 * 60 * 1000;
const MIN_VALID_RECORDING_BYTES = 1024;
const VIDEO_RECORDING_PREFERENCES_KEY = "videoRecordingPreferences";

let recorder: MediaRecorder | null = null;
let webcamRecorder: MediaRecorder | null = null;
let recorderStopped = false;
let webcamRecorderStopped = true;
let chunks: Blob[] = [];
let webcamChunks: Blob[] = [];
let activeStreams: MediaStream[] = [];
let stopTimerId: number | null = null;
let activeGuideId: number | null = null;
let activeOptions: VideoRecordingOptions | null = null;
let activeUserStream: MediaStream | null = null;
let retryBlob: Blob | null = null;
let retryWebcamBlob: Blob | null = null;
let webcamPreviewVideo: HTMLVideoElement | null = null;
let webcamPreviewTimerId: number | null = null;
let webcamPreviewPeerConnection: RTCPeerConnection | null = null;
let webcamCompositorFrameId: number | null = null;
let webcamCompositorWindow: Window | null = null;
let activeCompositorCleanup: (() => void) | null = null;
let recordingStartedAt: number | null = null;

type RecorderDevices = {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
};

type RecorderPageStatus = VideoRecordingState["status"] | "setup";

type EbmlElement = {
  id: number;
  headerStart: number;
  contentStart: number;
  contentEnd: number;
  size: number;
  sizeOffset: number;
  sizeLength: number;
  unknownSize: boolean;
};

function getDefaultVideoRecordingOptions(): VideoRecordingOptions {
  return {
    microphone: false,
    webcam: false,
    showSteps: true,
  };
}

function normalizeVideoRecordingOptions(
  options?: Partial<VideoRecordingOptions> | null,
): VideoRecordingOptions {
  return {
    ...getDefaultVideoRecordingOptions(),
    ...options,
    showSteps:
      typeof options?.showSteps === "boolean" ? options.showSteps : true,
  };
}

function getRecorderPageCopy(status: RecorderPageStatus) {
  if (status === "recording") {
    return {
      title: "Recording in progress",
      copy: "Please don't close this tab while GuideMagic is recording.",
    };
  }

  if (status === "stopping") {
    return {
      title: "Finalizing recording",
      copy: "Please don't close this tab while GuideMagic prepares your upload.",
    };
  }

  if (status === "uploading") {
    return {
      title: "Upload in progress",
      copy: "Please don't close this tab while GuideMagic uploads your recording.",
    };
  }

  return {
    title: "Video recording",
    copy: "",
  };
}

function getVintLength(firstByte: number) {
  for (let length = 1; length <= 8; length += 1) {
    if (firstByte & (1 << (8 - length))) return length;
  }
  return 0;
}

function readEbmlId(data: Uint8Array, offset: number) {
  if (offset >= data.length) return null;

  const length = getVintLength(data[offset]);
  if (!length || offset + length > data.length) return null;

  let id = 0;
  for (let index = 0; index < length; index += 1) {
    id = (id << 8) | data[offset + index];
  }

  return { id, length };
}

function readEbmlSize(data: Uint8Array, offset: number) {
  if (offset >= data.length) return null;

  const length = getVintLength(data[offset]);
  if (!length || offset + length > data.length) return null;

  const marker = 1 << (8 - length);
  let value = BigInt(data[offset] & (marker - 1));
  let unknownValue = BigInt(marker - 1);

  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(data[offset + index]);
    unknownValue = (unknownValue << 8n) | 0xffn;
  }

  return {
    length,
    size: Number(value),
    unknownSize: value === unknownValue,
  };
}

function encodeEbmlSize(size: number, length: number) {
  if (!Number.isFinite(size) || size < 0) return null;

  const max = (1n << BigInt(7 * length)) - 2n;
  let value = BigInt(Math.round(size));
  if (value > max) return null;

  const bytes = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  bytes[0] |= 1 << (8 - length);
  return bytes;
}

function readEbmlElement(
  data: Uint8Array,
  offset: number,
  containerEnd: number,
): EbmlElement | null {
  const id = readEbmlId(data, offset);
  if (!id) return null;

  const sizeOffset = offset + id.length;
  const size = readEbmlSize(data, sizeOffset);
  if (!size) return null;

  const contentStart = sizeOffset + size.length;
  const contentEnd = size.unknownSize
    ? containerEnd
    : contentStart + size.size;
  if (contentEnd > containerEnd) return null;

  return {
    id: id.id,
    headerStart: offset,
    contentStart,
    contentEnd,
    size: size.size,
    sizeOffset,
    sizeLength: size.length,
    unknownSize: size.unknownSize,
  };
}

function findEbmlElement(
  data: Uint8Array,
  start: number,
  end: number,
  targetId: number,
) {
  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(data, offset, end);
    if (!element) return null;
    if (element.id === targetId) return element;
    offset = element.contentEnd;
  }
  return null;
}

function readUnsignedInteger(data: Uint8Array, start: number, end: number) {
  let value = 0;
  for (let offset = start; offset < end; offset += 1) {
    value = value * 256 + data[offset];
  }
  return value;
}

function createWebmDurationElement(durationMs: number, timecodeScale: number) {
  const durationTimecode = (durationMs * 1_000_000) / timecodeScale;
  const element = new Uint8Array(11);
  element[0] = 0x44;
  element[1] = 0x89;
  element[2] = 0x88;
  new DataView(element.buffer).setFloat64(3, durationTimecode, false);
  return element;
}

function patchWebmDurationBuffer(data: Uint8Array, durationMs: number) {
  const segment = findEbmlElement(data, 0, data.length, 0x18538067);
  if (!segment) return null;

  const info = findEbmlElement(
    data,
    segment.contentStart,
    segment.contentEnd,
    0x1549a966,
  );
  if (!info || info.unknownSize) return null;

  const existingDuration = findEbmlElement(
    data,
    info.contentStart,
    info.contentEnd,
    0x4489,
  );
  if (existingDuration) return data;

  const timecodeScaleElement = findEbmlElement(
    data,
    info.contentStart,
    info.contentEnd,
    0x2ad7b1,
  );
  const timecodeScale = timecodeScaleElement
    ? readUnsignedInteger(
        data,
        timecodeScaleElement.contentStart,
        timecodeScaleElement.contentEnd,
      )
    : 1_000_000;
  if (!timecodeScale) return null;

  const durationElement = createWebmDurationElement(durationMs, timecodeScale);
  const nextInfoSize = info.size + durationElement.length;
  const encodedInfoSize = encodeEbmlSize(nextInfoSize, info.sizeLength);
  if (!encodedInfoSize) return null;

  const encodedSegmentSize =
    segment.unknownSize
      ? null
      : encodeEbmlSize(segment.size + durationElement.length, segment.sizeLength);
  if (!segment.unknownSize && !encodedSegmentSize) return null;

  const patched = new Uint8Array(data.length + durationElement.length);
  patched.set(data.subarray(0, info.sizeOffset), 0);
  patched.set(encodedInfoSize, info.sizeOffset);
  patched.set(
    data.subarray(info.sizeOffset + info.sizeLength, info.contentEnd),
    info.sizeOffset + info.sizeLength,
  );
  patched.set(durationElement, info.contentEnd);
  patched.set(
    data.subarray(info.contentEnd),
    info.contentEnd + durationElement.length,
  );

  if (encodedSegmentSize) {
    patched.set(encodedSegmentSize, segment.sizeOffset);
  }

  return patched;
}

async function addWebmDurationMetadata(blob: Blob, durationMs: number) {
  if (!blob.type.includes("webm") || durationMs <= 0) return blob;

  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const patched = patchWebmDurationBuffer(data, durationMs);
    if (!patched || patched === data) return blob;

    return new Blob([patched], { type: blob.type || "video/webm" });
  } catch (error) {
    console.warn("[GuideMagic video] could not add WebM duration metadata", error);
    return blob;
  }
}

function notifyRecorderStateChanged(status: VideoRecordingState["status"]) {
  window.dispatchEvent(
    new CustomEvent<{ status: VideoRecordingState["status"] }>(
      "guidemagic-video-recorder-state",
      { detail: { status } },
    ),
  );
}

async function setRecordingState(
  patch: Partial<VideoRecordingState> & { guideId?: number },
) {
  const current = await storage.get<VideoRecordingState>("videoRecording");
  const guideId = patch.guideId || current?.guideId || activeGuideId;
  if (!guideId) return;
  await storage.set("videoRecording", {
    guideId,
    active: current?.active ?? true,
    status: current?.status || "starting",
    options: normalizeVideoRecordingOptions(current?.options || activeOptions),
    ...patch,
  });
  if (patch.status) {
    notifyRecorderStateChanged(patch.status);
  }
}

function stopTracks() {
  activeCompositorCleanup?.();
  activeCompositorCleanup = null;
  activeStreams.forEach((stream) => {
    stream.getTracks().forEach((track) => track.stop());
  });
  activeStreams = [];
  if (webcamPreviewTimerId != null) {
    window.clearInterval(webcamPreviewTimerId);
    webcamPreviewTimerId = null;
  }
  if (webcamPreviewPeerConnection) {
    webcamPreviewPeerConnection.close();
    webcamPreviewPeerConnection = null;
  }
  if (webcamCompositorFrameId != null && webcamCompositorWindow) {
    webcamCompositorWindow.cancelAnimationFrame(webcamCompositorFrameId);
  }
  webcamCompositorFrameId = null;
  webcamCompositorWindow = null;
  webcamPreviewVideo = null;
  activeUserStream = null;
  if (stopTimerId != null) {
    window.clearTimeout(stopTimerId);
    stopTimerId = null;
  }
}

function getRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function getVideoOnlyRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function describeError(error: unknown) {
  if (error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isDisplayShareCanceled(error: unknown) {
  return (
    error instanceof DOMException &&
    ["AbortError", "NotAllowedError"].includes(error.name)
  );
}

async function getAccessToken(refresh = false) {
  const response = await chrome.runtime.sendMessage({
    type: "GET_GUIDEMAGIC_ACCESS_TOKEN",
    refresh,
  });
  if (!response?.success || !response.accessToken) {
    throw new Error(response?.error || "User session is no longer valid");
  }
  return response.accessToken as string;
}

async function fetchWithToken(
  path: string,
  options: RequestInit,
  refresh = false,
) {
  const token = await getAccessToken(refresh);
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(`${process.env.PLASMO_PUBLIC_API_ROUTE}${path}`, {
    ...options,
    headers,
  });
}

async function uploadRecordedVideo(
  guideId: number,
  screenBlob: Blob,
  webcamBlob?: Blob | null,
  showSteps = true,
) {
  const createFormData = () => {
    const formData = new FormData();
    formData.append("screen", screenBlob, `guide-${guideId}-screen.webm`);
    formData.append("stepsVisible", String(showSteps));
    if (webcamBlob?.size) {
      formData.append("webcam", webcamBlob, `guide-${guideId}-webcam.webm`);
    }
    return formData;
  };

  let response = await fetchWithToken(`/guides/${guideId}/video/upload`, {
    method: "POST",
    body: createFormData(),
  });

  if (response.status === 401) {
    response = await fetchWithToken(
      `/guides/${guideId}/video/upload`,
      {
        method: "POST",
        body: createFormData(),
      },
      true,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[GuideMagic video] recorded video upload response failed", {
      guideId,
      status: response.status,
      body: body.slice(0, 1000),
    });
    throw new Error(
      `Video upload failed with status ${response.status}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
    );
  }

  return response.json();
}

async function markRecordedVideoUploadFailed(guideId: number, message: string) {
  const response = await fetchWithToken(`/guides/${guideId}/video/upload/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(`Could not mark video upload failed: ${response.status}`);
  }
}

async function getDisplayStream() {
  return navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: {
      frameRate: { ideal: 30, max: 30 },
    },
  });
}

function getUserMediaConstraints(options: VideoRecordingOptions): MediaStreamConstraints {
  return {
    audio: options.microphone
      ? {
          deviceId: options.audioDeviceId
            ? { exact: options.audioDeviceId }
            : undefined,
        }
      : false,
    video: options.webcam
      ? {
          deviceId: options.videoDeviceId
            ? { exact: options.videoDeviceId }
            : undefined,
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 30, max: 30 },
        }
      : false,
  };
}

async function getUserStream(options: VideoRecordingOptions) {
  if (!options.microphone && !options.webcam) {
    console.info("[GuideMagic video] mic/webcam disabled");
    return null;
  }

  console.info("[GuideMagic video] requesting recorder-owned mic/webcam media", options);
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      getUserMediaConstraints(options),
    );
    console.info("[GuideMagic video] recorder-owned mic/webcam media granted", {
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      videoSettings: stream.getVideoTracks()[0]?.getSettings(),
    });
    return stream;
  } catch (error) {
    console.warn("[GuideMagic video] recorder-owned mic/webcam media unavailable", {
      options,
      error,
      message: describeError(error),
    });
    return null;
  }
}

async function playVideoElement(video: HTMLVideoElement, label: string) {
  await new Promise<void>((resolve, reject) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) {
      resolve();
      return;
    }

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`${label} video did not become ready`));
    }, 5000);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      if (video.videoWidth <= 0) {
        return;
      }
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${label} video failed to load`));
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
  });

  await video.play();
}

async function waitForIceGatheringComplete(peerConnection: RTCPeerConnection) {
  if (peerConnection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeoutId = window.setTimeout(resolve, 3000);
    const onStateChange = () => {
      if (peerConnection.iceGatheringState !== "complete") {
        return;
      }
      window.clearTimeout(timeoutId);
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    peerConnection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function prepareWebcamPreview(userStream: MediaStream | null) {
  const webcamTrack = userStream?.getVideoTracks()[0];
  if (!webcamTrack) {
    webcamPreviewVideo = null;
    return;
  }

  const webcamVideo = document.createElement("video");
  webcamVideo.srcObject = new MediaStream([webcamTrack]);
  webcamVideo.muted = true;
  webcamVideo.playsInline = true;
  await playVideoElement(webcamVideo, "webcam");
  webcamPreviewVideo = webcamVideo;
  console.info("[GuideMagic video] webcam preview source ready", {
    webcamVideoWidth: webcamVideo.videoWidth,
    webcamVideoHeight: webcamVideo.videoHeight,
    settings: webcamTrack.getSettings(),
  });
}

function drawCircle(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
) {
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.closePath();
}

function drawSourceCover(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  context.drawImage(source, sx, sy, sw, sh, x, y, width, height);
}

function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  drawSourceCover(
    context,
    video,
    video.videoWidth || width,
    video.videoHeight || height,
    x,
    y,
    width,
    height,
  );
}

function canUseFrameCompositor() {
  const browserWindow = window as typeof window & {
    MediaStreamTrackProcessor?: new (init: {
      track: MediaStreamTrack;
    }) => { readable: ReadableStream<VideoFrame> };
    VideoTrackGenerator?: new () => {
      writable: WritableStream<VideoFrame>;
      track: MediaStreamTrack;
    };
    VideoFrame?: typeof VideoFrame;
  };

  return (
    typeof browserWindow.MediaStreamTrackProcessor === "function" &&
    typeof browserWindow.VideoTrackGenerator === "function" &&
    typeof browserWindow.VideoFrame === "function" &&
    typeof OffscreenCanvas === "function"
  );
}

async function composeVideoStreamWithFrameProcessor(
  tabStream: MediaStream,
  userStream: MediaStream,
) {
  const tabVideoTrack = tabStream.getVideoTracks()[0];
  const webcamTrack = userStream.getVideoTracks()[0];
  if (!tabVideoTrack || !webcamTrack || !canUseFrameCompositor()) {
    return null;
  }

  const browserWindow = window as typeof window & {
    MediaStreamTrackProcessor: new (init: {
      track: MediaStreamTrack;
    }) => { readable: ReadableStream<VideoFrame> };
    VideoTrackGenerator: new () => {
      writable: WritableStream<VideoFrame>;
      track: MediaStreamTrack;
    };
    VideoFrame: typeof VideoFrame;
  };
  const abortController = new AbortController();
  const screenProcessor = new browserWindow.MediaStreamTrackProcessor({
    track: tabVideoTrack,
  });
  const webcamProcessor = new browserWindow.MediaStreamTrackProcessor({
    track: webcamTrack,
  });
  const generator = new browserWindow.VideoTrackGenerator();
  const screenReader = screenProcessor.readable.getReader();
  const webcamReader = webcamProcessor.readable.getReader();
  const writer = generator.writable.getWriter();
  let latestWebcamFrame: VideoFrame | null = null;
  const canvas = new OffscreenCanvas(
    Number(tabVideoTrack.getSettings().width) || 1280,
    Number(tabVideoTrack.getSettings().height) || 720,
  );
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const cleanup = () => {
    abortController.abort();
    latestWebcamFrame?.close();
    latestWebcamFrame = null;
    void screenReader.cancel().catch(() => undefined);
    void webcamReader.cancel().catch(() => undefined);
    void writer.close().catch(() => undefined);
    generator.track.stop();
  };
  activeCompositorCleanup = cleanup;

  void (async () => {
    try {
      while (!abortController.signal.aborted) {
        const { done, value } = await webcamReader.read();
        if (done || !value) {
          break;
        }
        latestWebcamFrame?.close();
        latestWebcamFrame = value;
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.warn("[GuideMagic video] webcam frame reader stopped", {
          error,
          message: describeError(error),
        });
      }
    }
  })();

  void (async () => {
    try {
      while (!abortController.signal.aborted) {
        const { done, value: screenFrame } = await screenReader.read();
        if (done || !screenFrame) {
          break;
        }

        const nextWidth = screenFrame.displayWidth || screenFrame.codedWidth;
        const nextHeight = screenFrame.displayHeight || screenFrame.codedHeight;
        if (nextWidth > 0 && nextHeight > 0) {
          if (canvas.width !== nextWidth) {
            canvas.width = nextWidth;
          }
          if (canvas.height !== nextHeight) {
            canvas.height = nextHeight;
          }
        }

        context.fillStyle = "#0f172a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(screenFrame, 0, 0, canvas.width, canvas.height);

        if (latestWebcamFrame) {
          const bubbleSize = Math.min(240, canvas.width * 0.18, canvas.height * 0.28);
          const margin = Math.max(24, canvas.width * 0.025);
          const radius = bubbleSize / 2;
          const x = canvas.width - bubbleSize - margin;
          const y = canvas.height - bubbleSize - margin;
          const centerX = x + radius;
          const centerY = y + radius;

          context.save();
          context.shadowColor = "rgba(15, 23, 42, 0.42)";
          context.shadowBlur = 26;
          context.shadowOffsetY = 10;
          drawCircle(context, centerX, centerY, radius);
          context.clip();
          context.translate(x + bubbleSize, y);
          context.scale(-1, 1);
          drawSourceCover(
            context,
            latestWebcamFrame,
            latestWebcamFrame.displayWidth || latestWebcamFrame.codedWidth,
            latestWebcamFrame.displayHeight || latestWebcamFrame.codedHeight,
            0,
            0,
            bubbleSize,
            bubbleSize,
          );
          context.restore();

          context.save();
          context.strokeStyle = "#ffffff";
          context.lineWidth = Math.max(4, canvas.width * 0.003);
          drawCircle(context, centerX, centerY, radius - context.lineWidth / 2);
          context.stroke();
          context.restore();
        }

        const outputFrame = new browserWindow.VideoFrame(canvas, {
          timestamp: screenFrame.timestamp,
          duration: screenFrame.duration ?? undefined,
        });
        screenFrame.close();
        await writer.write(outputFrame);
        outputFrame.close();
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.warn("[GuideMagic video] screen frame compositor stopped", {
          error,
          message: describeError(error),
        });
      }
    } finally {
      cleanup();
    }
  })();

  console.info("[GuideMagic video] recording display stream with frame compositor", {
    screenTrackSettings: tabVideoTrack.getSettings(),
    webcamTrackSettings: webcamTrack.getSettings(),
  });

  return new MediaStream([generator.track]);
}

async function composeVideoStreamWithWebcam(
  tabStream: MediaStream,
  userStream: MediaStream,
) {
  const processedStream = await composeVideoStreamWithFrameProcessor(
    tabStream,
    userStream,
  );
  if (processedStream) {
    return processedStream;
  }

  const tabVideoTrack = tabStream.getVideoTracks()[0];
  const webcamTrack = userStream.getVideoTracks()[0];
  if (!tabVideoTrack || !webcamTrack) {
    throw new Error("Missing screen or webcam track");
  }

  const screenVideo = document.createElement("video");
  screenVideo.srcObject = new MediaStream([tabVideoTrack]);
  screenVideo.muted = true;
  screenVideo.playsInline = true;
  screenVideo.style.cssText =
    "position:absolute;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(screenVideo);
  await playVideoElement(screenVideo, "screen compositor");

  const webcamVideo = document.createElement("video");
  webcamVideo.srcObject = new MediaStream([webcamTrack]);
  webcamVideo.muted = true;
  webcamVideo.playsInline = true;
  webcamVideo.style.cssText =
    "position:absolute;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(webcamVideo);
  await playVideoElement(webcamVideo, "webcam compositor");

  const settings = tabVideoTrack.getSettings();
  const canvas = document.createElement("canvas");
  canvas.width = Number(settings.width) || 1280;
  canvas.height = Number(settings.height) || 720;
  canvas.style.cssText =
    "position:absolute;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(canvas);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create webcam compositor");
  }

  const draw = () => {
    if (webcamTrack.readyState !== "live" || tabVideoTrack.readyState !== "live") {
      webcamCompositorFrameId = null;
      webcamCompositorWindow = null;
      return;
    }

    context.fillStyle = "#0f172a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

    const bubbleSize = Math.min(240, canvas.width * 0.18, canvas.height * 0.28);
    const margin = Math.max(24, canvas.width * 0.025);
    const radius = bubbleSize / 2;
    const x = canvas.width - bubbleSize - margin;
    const y = canvas.height - bubbleSize - margin;
    const centerX = x + radius;
    const centerY = y + radius;

    context.save();
    context.shadowColor = "rgba(15, 23, 42, 0.42)";
    context.shadowBlur = 26;
    context.shadowOffsetY = 10;
    drawCircle(context, centerX, centerY, radius);
    context.clip();
    context.translate(x + bubbleSize, y);
    context.scale(-1, 1);
    drawVideoCover(context, webcamVideo, 0, 0, bubbleSize, bubbleSize);
    context.restore();

    context.save();
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(4, canvas.width * 0.003);
    drawCircle(context, centerX, centerY, radius - context.lineWidth / 2);
    context.stroke();
    context.restore();

    webcamCompositorWindow = window;
    webcamCompositorFrameId = window.requestAnimationFrame(draw);
  };
  draw();

  console.info("[GuideMagic video] recording display stream with webcam compositor", {
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    screenTrackSettings: settings,
    webcamTrackSettings: webcamTrack.getSettings(),
  });
  return canvas.captureStream(30);
}

async function composeVideoStream(tabStream: MediaStream, userStream: MediaStream | null) {
  const tabVideoTrack = tabStream.getVideoTracks()[0];
  if (userStream?.getVideoTracks()[0]) {
    try {
      return await composeVideoStreamWithWebcam(tabStream, userStream);
    } catch (error) {
      console.warn("[GuideMagic video] webcam compositor unavailable", {
        error,
        message: describeError(error),
      });
    }
  }

  console.info("[GuideMagic video] recording display stream directly", {
    screenTrackSettings: tabVideoTrack.getSettings(),
    webcamOverlayMode: Boolean(userStream?.getVideoTracks()[0])
      ? "compositor-unavailable"
      : "none",
  });
  return new MediaStream([tabVideoTrack]);
}

function startWebcamPreviewBridge(targetTabId: number) {
  if (!webcamPreviewVideo || webcamPreviewTimerId != null) {
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  webcamPreviewTimerId = window.setInterval(() => {
    if (
      !webcamPreviewVideo ||
      webcamPreviewVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      webcamPreviewVideo.videoWidth <= 0
    ) {
      return;
    }

    context.save();
    context.scale(-1, 1);
    context.drawImage(webcamPreviewVideo, -canvas.width, 0, canvas.width, canvas.height);
    context.restore();
    const frame = canvas.toDataURL("image/jpeg", 0.55);
    void chrome.tabs
      .sendMessage(targetTabId, {
        message: "updateVideoPreviewFrame",
        frame,
      })
      .catch(() => undefined);
  }, 83);
}

async function startWebrtcWebcamPreview(targetTabId: number, userStream: MediaStream | null) {
  const webcamTrack = userStream?.getVideoTracks()[0];
  if (!webcamTrack) {
    console.info("[GuideMagic video] WebRTC webcam preview skipped: no webcam track");
    return false;
  }

  try {
    webcamPreviewPeerConnection?.close();
    const peerConnection = new RTCPeerConnection();
    webcamPreviewPeerConnection = peerConnection;
    peerConnection.addTrack(webcamTrack, new MediaStream([webcamTrack]));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);
    const response = await chrome.runtime.sendMessage({
      type: "GUIDEMAGIC_WEBRTC_PREVIEW_OFFER",
      targetTabId,
      offer: peerConnection.localDescription?.toJSON(),
    });
    if (!response?.success || !response.answer) {
      throw new Error(response?.error || "WebRTC preview answer was not received");
    }
    await peerConnection.setRemoteDescription(response.answer);
    console.info("[GuideMagic video] WebRTC webcam preview connected");
    return true;
  } catch (error) {
    console.warn("[GuideMagic video] WebRTC webcam preview failed", {
      error,
      message: describeError(error),
    });
    webcamPreviewPeerConnection?.close();
    webcamPreviewPeerConnection = null;
    return false;
  }
}

function composeAudioStream(tabStream: MediaStream, userStream: MediaStream | null) {
  const tabAudioTracks = tabStream.getAudioTracks();
  const userAudioTracks = userStream?.getAudioTracks() || [];
  const audioTracks = [...tabAudioTracks, ...userAudioTracks];
  if (!audioTracks.length) {
    return null;
  }

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  tabAudioTracks.forEach((track) => {
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(destination);
    source.connect(audioContext.destination);
  });
  userAudioTracks.forEach((track) => {
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(destination);
  });
  return destination.stream;
}

async function uploadBlob(
  guideId: number,
  screenBlob: Blob,
  webcamBlob?: Blob | null,
) {
  console.info("[GuideMagic video] uploading recorded video", {
    guideId,
    screenSize: screenBlob.size,
    screenType: screenBlob.type,
    webcamSize: webcamBlob?.size || 0,
    webcamType: webcamBlob?.type,
  });
  await setRecordingState({
    guideId,
    active: false,
    status: "uploading",
    error: undefined,
  });
  await uploadRecordedVideo(
    guideId,
    screenBlob,
    webcamBlob,
    activeOptions?.showSteps ?? true,
  );
  console.info("[GuideMagic video] recorded video uploaded", {
    guideId,
    screenSize: screenBlob.size,
    webcamSize: webcamBlob?.size || 0,
  });
  await storage.remove("videoRecording");
  await storage.remove("guide");
  retryBlob = null;
  retryWebcamBlob = null;
  activeGuideId = null;
}

function maybeFinishRecording() {
  if (!recorderStopped) {
    return;
  }
  if (!webcamRecorderStopped) {
    return;
  }
  void finishRecording();
}

async function finishRecording() {
  if (!activeGuideId) return;
  const guideId = activeGuideId;
  const durationMs = recordingStartedAt
    ? Math.max(0, Date.now() - recordingStartedAt)
    : 0;
  const rawBlob = new Blob(chunks, { type: "video/webm" });
  const rawWebcamBlob = webcamChunks.length
    ? new Blob(webcamChunks, { type: "video/webm" })
    : null;
  const blob = await addWebmDurationMetadata(rawBlob, durationMs);
  const webcamBlob = rawWebcamBlob
    ? await addWebmDurationMetadata(rawWebcamBlob, durationMs)
    : null;
  console.info("[GuideMagic video] recorder finalized", {
    guideId,
    chunks: chunks.length,
    size: blob.size,
    webcamChunks: webcamChunks.length,
    webcamSize: webcamBlob?.size || 0,
    durationMs,
  });
  console.info(
    `[GuideMagic video] recorder finalized guide=${guideId} screenChunks=${chunks.length} screenBytes=${blob.size} webcamChunks=${webcamChunks.length} webcamBytes=${webcamBlob?.size || 0} durationMs=${durationMs}`,
  );
  retryBlob = blob;
  retryWebcamBlob = webcamBlob;
  stopTracks();
  recordingStartedAt = null;
  recorder = null;
  webcamRecorder = null;
  chunks = [];
  webcamChunks = [];

  try {
    if (blob.size < MIN_VALID_RECORDING_BYTES) {
      throw new Error(`Recorded video is empty (${blob.size} bytes)`);
    }
    await uploadBlob(guideId, blob, webcamBlob);
    chrome.runtime.sendMessage({ type: "VIDEO_RECORDING_COMPLETE", guideId });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Video upload failed. Please try recording again.";
    await markRecordedVideoUploadFailed(guideId, message).catch(
      () => undefined,
    );
    console.error("[GuideMagic video] recorded video upload failed", {
      guideId,
      error,
      message,
    });
    await setRecordingState({
      guideId,
      active: false,
      status: "failed",
      error: message,
    });
  }
}

async function startRecording(
  guideId: number,
  options: VideoRecordingOptions,
  preparedUserStream?: MediaStream | null,
) {
  activeGuideId = guideId;
  const recordingOptions = normalizeVideoRecordingOptions(options);
  activeOptions = recordingOptions;
  chunks = [];
  webcamChunks = [];
  recorderStopped = false;
  webcamRecorderStopped = true;
  recordingStartedAt = null;
  retryBlob = null;
  retryWebcamBlob = null;
  await setRecordingState({
    guideId,
    active: true,
    status: "starting",
    options: recordingOptions,
    error: undefined,
  });

  try {
    const userStream =
      preparedUserStream ?? (await getUserStream(recordingOptions));
    activeUserStream = userStream;
    activeStreams = [];

    console.info("[GuideMagic video] requesting display media", {
      guideId,
      options: recordingOptions,
    });
    const tabStream = await getDisplayStream();
    console.info("[GuideMagic video] display media granted", {
      guideId,
      videoTracks: tabStream.getVideoTracks().length,
      audioTracks: tabStream.getAudioTracks().length,
    });
    activeStreams = [tabStream, ...(userStream ? [userStream] : [])];
    const tabVideoTrack = tabStream.getVideoTracks()[0];
    if (!tabVideoTrack) {
      throw new Error("Screen capture did not provide a video track");
    }
    const videoStream = new MediaStream([tabVideoTrack]);
    const audioStream = composeAudioStream(tabStream, userStream);
    activeStreams = [
      ...activeStreams,
      videoStream,
      ...(audioStream ? [audioStream] : []),
    ];
    const outputStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...(audioStream?.getAudioTracks() || []),
    ]);
    console.info("[GuideMagic video] recorder output stream ready", {
      videoTracks: outputStream.getVideoTracks().map((track) => ({
        id: track.id,
        label: track.label,
        readyState: track.readyState,
        settings: track.getSettings(),
      })),
      audioTracks: outputStream.getAudioTracks().map((track) => ({
        id: track.id,
        label: track.label,
        readyState: track.readyState,
        settings: track.getSettings(),
      })),
    });
    const mimeType = getRecorderMimeType();
    recorder = new MediaRecorder(outputStream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
        console.info("[GuideMagic video] recorder chunk received", {
          guideId,
          chunkSize: event.data.size,
          chunks: chunks.length,
          recorderState: recorder?.state,
        });
      }
    };
    recorder.onstop = () => {
      console.info("[GuideMagic video] recorder stopped", { guideId });
      recorderStopped = true;
      maybeFinishRecording();
    };
    recordingStartedAt = Date.now();
    recorder.start(1000);

    const webcamTrack = userStream?.getVideoTracks()[0];
    if (webcamTrack) {
      webcamRecorderStopped = false;
      const webcamStream = new MediaStream([webcamTrack]);
      const webcamMimeType = getVideoOnlyRecorderMimeType();
      webcamRecorder = new MediaRecorder(
        webcamStream,
        webcamMimeType ? { mimeType: webcamMimeType } : undefined,
      );
      webcamRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          webcamChunks.push(event.data);
          console.info("[GuideMagic video] webcam recorder chunk received", {
            guideId,
            chunkSize: event.data.size,
            chunks: webcamChunks.length,
            recorderState: webcamRecorder?.state,
          });
        }
      };
      webcamRecorder.onstop = () => {
        console.info("[GuideMagic video] webcam recorder stopped", { guideId });
        webcamRecorderStopped = true;
        maybeFinishRecording();
      };
      webcamRecorder.start(1000);
    }

    stopTimerId = window.setTimeout(() => {
      void stopRecording();
    }, MAX_RECORDING_MS);
    await setRecordingState({
      guideId,
      active: true,
      status: "recording",
      options: recordingOptions,
      error: undefined,
    });
  } catch (error) {
    recordingStartedAt = null;
    console.error("[GuideMagic video] failed to start recorder", {
      guideId,
      error,
    });
    if (isDisplayShareCanceled(error)) {
      activeStreams = [];
      await setRecordingState({
        guideId,
        active: true,
        status: "starting",
        options: recordingOptions,
        error: undefined,
      });
      throw error;
    }
    stopTracks();
    await setRecordingState({
      guideId,
      active: false,
      status: "failed",
      error: describeError(error),
    });
    void chrome.runtime.sendMessage({
      type: "VIDEO_RECORDING_FAILED",
      guideId,
      error: describeError(error),
    });
    throw error;
  }
}

async function stopRecording() {
  if (!recorder || recorder.state === "inactive") {
    console.warn("[GuideMagic video] stop requested without active recorder", {
      hasRecorder: Boolean(recorder),
      recorderState: recorder?.state,
      activeStreams: activeStreams.length,
    });
    stopTracks();
    return;
  }
  console.info("[GuideMagic video] stop requested", {
    guideId: activeGuideId,
    recorderState: recorder.state,
    chunks: chunks.length,
  });
  await setRecordingState({ active: false, status: "stopping" });
  try {
    recorder.requestData();
  } catch (error) {
    console.warn("[GuideMagic video] requestData failed before stop", { error });
  }
  if (webcamRecorder && webcamRecorder.state !== "inactive") {
    try {
      webcamRecorder.requestData();
    } catch (error) {
      console.warn("[GuideMagic video] webcam requestData failed before stop", {
        error,
      });
    }
    webcamRecorder.stop();
  }
  recorder.stop();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "video-recorder") {
    return;
  }

  if (message.type === "START_VIDEO_RECORDING") {
    startRecording(message.guideId, message.options)
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: describeError(error),
        }),
      );
    return true;
  }

  if (message.type === "STOP_VIDEO_RECORDING") {
    stopRecording()
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message.type === "RETRY_VIDEO_UPLOAD") {
    if (!activeGuideId || !retryBlob) {
      sendResponse({ success: false, error: "No video upload is available to retry" });
      return;
    }
    uploadBlob(activeGuideId, retryBlob, retryWebcamBlob)
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }
});

function VideoRecorderPage() {
  const initializedRef = useRef(false);
  const recordingStartedRef = useRef(false);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const setupStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micLevelFrameRef = useRef<number | null>(null);
  const [status, setStatus] = useState("Preparing recorder...");
  const [pageStatus, setPageStatus] = useState<RecorderPageStatus>("setup");
  const [error, setError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isPreparingMedia, setIsPreparingMedia] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [session, setSession] = useState<{
    guideId: number;
    targetTabId?: number;
    options: VideoRecordingOptions;
  } | null>(null);
  const [options, setOptions] = useState<VideoRecordingOptions>(
    getDefaultVideoRecordingOptions(),
  );
  const [devices, setDevices] = useState<RecorderDevices>({
    audioInputs: [],
    videoInputs: [],
  });
  const controlsDisabled = isStarting || isPreparingMedia;
  const showProgressState = ["recording", "stopping", "uploading"].includes(
    pageStatus,
  );
  const pageCopy = getRecorderPageCopy(pageStatus);

  const stopMicLevelMeter = useCallback(() => {
    if (micLevelFrameRef.current != null) {
      window.cancelAnimationFrame(micLevelFrameRef.current);
      micLevelFrameRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setMicLevel(0);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const nextDevices = await navigator.mediaDevices.enumerateDevices();
    setDevices({
      audioInputs: nextDevices.filter((device) => device.kind === "audioinput"),
      videoInputs: nextDevices.filter((device) => device.kind === "videoinput"),
    });
  }, []);

  const stopSetupStream = useCallback(() => {
    stopMicLevelMeter();
    setupStreamRef.current?.getTracks().forEach((track) => track.stop());
    setupStreamRef.current = null;
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = null;
    }
  }, [stopMicLevelMeter]);

  const startMicLevelMeter = useCallback(
    (stream: MediaStream | null) => {
      stopMicLevelMeter();
      const audioTrack = stream?.getAudioTracks()[0];
      if (!audioTrack) {
        return;
      }

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      const source = audioContext.createMediaStreamSource(
        new MediaStream([audioTrack]),
      );
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      audioContextRef.current = audioContext;

      const update = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / samples.length);
        setMicLevel(Math.min(1, rms * 4.2));
        micLevelFrameRef.current = window.requestAnimationFrame(update);
      };
      update();
    },
    [stopMicLevelMeter],
  );

  const attachPreviewStream = useCallback(async (stream: MediaStream | null) => {
    if (!previewVideoRef.current) {
      return;
    }

    const videoTrack = stream?.getVideoTracks()[0];
    if (!videoTrack) {
      previewVideoRef.current.srcObject = null;
      return;
    }

    previewVideoRef.current.srcObject = new MediaStream([videoTrack]);
    await previewVideoRef.current.play().catch(() => undefined);
  }, []);

  const persistOptions = useCallback(
    async (nextOptions: VideoRecordingOptions) => {
      setOptions(nextOptions);
      setSession((current) =>
        current ? { ...current, options: nextOptions } : current,
      );
      activeOptions = nextOptions;
      await storage.set(VIDEO_RECORDING_PREFERENCES_KEY, nextOptions);

      const currentState = await storage.get<VideoRecordingState>("videoRecording");
      if (currentState?.guideId) {
        await storage.set("videoRecording", {
          ...currentState,
          options: nextOptions,
        });
      }

      const currentGuide = await storage.get<any>("guide");
      if (currentGuide?.recordingMode === "video") {
        await storage.set("guide", {
          ...currentGuide,
          videoRecording: nextOptions,
        });
      }
    },
    [],
  );

  const prepareSetupMedia = useCallback(
    async (nextOptions: VideoRecordingOptions) => {
      stopSetupStream();
      if (!nextOptions.microphone && !nextOptions.webcam) {
        await attachPreviewStream(null);
        return null;
      }

      setIsPreparingMedia(true);
      setError("");
      setStatus("Preparing selected inputs.");
      try {
        const stream = await getUserStream(nextOptions);
        if (!stream) {
          throw new Error("Permission was not granted for the selected input.");
        }
        setupStreamRef.current = stream;
        await attachPreviewStream(stream);
        startMicLevelMeter(stream);
        await refreshDevices();
        setStatus("Choose what to share when you are ready.");
        return stream;
      } catch (err) {
        stopSetupStream();
        setError(describeError(err));
        setStatus("Could not prepare selected inputs.");
        return null;
      } finally {
        setIsPreparingMedia(false);
      }
    },
    [attachPreviewStream, refreshDevices, startMicLevelMeter, stopSetupStream],
  );

  const updateRecordingOptions = useCallback(
    async (patch: Partial<VideoRecordingOptions>) => {
      const nextOptions = {
        ...options,
        ...patch,
      };
      const shouldRefreshSetupMedia =
        nextOptions.microphone !== options.microphone ||
        nextOptions.webcam !== options.webcam ||
        nextOptions.audioDeviceId !== options.audioDeviceId ||
        nextOptions.videoDeviceId !== options.videoDeviceId;
      await persistOptions(nextOptions);
      if (shouldRefreshSetupMedia) {
        await prepareSetupMedia(nextOptions);
      }
    },
    [options, persistOptions, prepareSetupMedia],
  );

  const beginRecording = useCallback(
    async (
      nextSession = session,
    ) => {
      if (!nextSession || recordingStartedRef.current) {
        return;
      }
      recordingStartedRef.current = true;
      setIsStarting(true);
      setError("");
      const selectedOptions = nextSession.options;
      setStatus("Choose a screen or tab to share.");

      try {
        await persistOptions(selectedOptions);
        let userStream = setupStreamRef.current;
        if ((selectedOptions.microphone || selectedOptions.webcam) && !userStream) {
          userStream = await getUserStream(selectedOptions);
          setupStreamRef.current = userStream;
        }

        if (selectedOptions.microphone && !userStream?.getAudioTracks().length) {
          throw new Error("Microphone is enabled, but no microphone stream is available.");
        }
        if (selectedOptions.webcam && !userStream?.getVideoTracks().length) {
          throw new Error("Webcam is enabled, but no webcam stream is available.");
        }

        await startRecording(nextSession.guideId, selectedOptions, userStream);
        setupStreamRef.current = null;
        setPageStatus("recording");
        setStatus("Recording in progress.");
        void chrome.runtime.sendMessage({
          type: "VIDEO_RECORDING_STARTED",
          guideId: nextSession.guideId,
          targetTabId: nextSession.targetTabId,
          options: selectedOptions,
          recordingStartedAt,
        });
      } catch (err) {
        recordingStartedRef.current = false;
        if (isDisplayShareCanceled(err)) {
          await attachPreviewStream(setupStreamRef.current);
          setError("Screen sharing was cancelled. Click Start screen sharing to try again.");
          setStatus("Choose what to share when you are ready.");
        } else {
          setError(describeError(err));
          setStatus("Recording could not start.");
        }
      } finally {
        setIsStarting(false);
      }
    },
    [attachPreviewStream, persistOptions, session],
  );

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const guideId = Number(params.get("guideId"));
    const targetTabId = Number(params.get("targetTabId"));

    if (!Number.isInteger(guideId) || guideId <= 0) {
      setError("Missing guide for this recording.");
      return;
    }

    void (async () => {
      const savedOptions =
        (await storage.get<VideoRecordingOptions>(VIDEO_RECORDING_PREFERENCES_KEY)) ||
        null;
      const nextOptions = {
        ...normalizeVideoRecordingOptions(savedOptions),
        showSteps:
          params.get("showSteps") === "false"
            ? false
            : savedOptions?.showSteps ?? true,
      };
      setOptions(nextOptions);
      activeOptions = nextOptions;
      setSession({
        guideId,
        targetTabId: Number.isInteger(targetTabId) ? targetTabId : undefined,
        options: nextOptions,
      });
      await persistOptions(nextOptions);
      await refreshDevices().catch(() => undefined);
      if (nextOptions.microphone || nextOptions.webcam) {
        await prepareSetupMedia(nextOptions);
        return;
      }
      setStatus("Choose optional inputs, then start recording.");
    })();
  }, [persistOptions, prepareSetupMedia, refreshDevices]);

  useEffect(() => {
    void attachPreviewStream(setupStreamRef.current);
  }, [attachPreviewStream, options.webcam]);

  useEffect(() => {
    const syncRecordingStatus = async () => {
      const currentState = await storage.get<VideoRecordingState>("videoRecording");
      if (currentState?.status) {
        setPageStatus(currentState.status);
      }
    };
    const handleRecordingStatus = (event: Event) => {
      const nextStatus = (event as CustomEvent<{ status?: RecorderPageStatus }>)
        .detail?.status;
      if (nextStatus) {
        setPageStatus(nextStatus);
      }
    };

    void syncRecordingStatus();
    window.addEventListener(
      "guidemagic-video-recorder-state",
      handleRecordingStatus,
    );

    return () => {
      window.removeEventListener(
        "guidemagic-video-recorder-state",
        handleRecordingStatus,
      );
    };
  }, []);

  useEffect(() => {
    return () => {
      if (!recordingStartedRef.current) {
        stopSetupStream();
      } else {
        stopMicLevelMeter();
      }
    };
  }, [stopMicLevelMeter, stopSetupStream]);

  return (
    <main style={styles.page}>
      <section style={styles.panel}>
        <div style={styles.header}>
          <div
            style={{
              ...styles.indicator,
              ...(showProgressState ? styles.indicatorActive : {}),
            }}
          />
          <div>
            <h1 style={styles.title}>
              {showProgressState ? pageCopy.title : "Video recording"}
            </h1>
            <p style={styles.copy}>
              {showProgressState ? pageCopy.copy : status}
            </p>
          </div>
        </div>
        {showProgressState ? (
          <div style={styles.progressPanel} aria-live="polite" aria-busy="true">
            <div style={styles.spinner} aria-hidden="true" />
            <div style={styles.progressText}>
              <strong style={styles.progressTitle}>{pageCopy.title}</strong>
              <span style={styles.progressCopy}>{pageCopy.copy}</span>
            </div>
          </div>
        ) : options.webcam ? (
          <div style={styles.preview}>
            <video
              ref={previewVideoRef}
              style={styles.previewVideo}
              muted
              playsInline
              autoPlay
            />
          </div>
        ) : null}
        {!showProgressState && (
          <>
            <div style={styles.controls}>
              <div style={styles.controlRow}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={options.microphone}
                  aria-label="Microphone"
                  style={{
                    ...styles.switchButton,
                    ...(options.microphone ? styles.switchButtonOn : {}),
                  }}
                  disabled={controlsDisabled}
                  onClick={() => {
                    void updateRecordingOptions({
                      microphone: !options.microphone,
                    });
                  }}
                >
                  <span
                    style={{
                      ...styles.switchKnob,
                      ...(options.microphone ? styles.switchKnobOn : {}),
                    }}
                  />
                </button>
                <div style={styles.controlText}>
                  <strong style={styles.controlTitle}>Microphone</strong>
                  <span style={styles.micMeta}>
                    <small style={styles.controlHint}>Voice-over audio</small>
                    {options.microphone && (
                      <span style={styles.micMeter} aria-label="Microphone level">
                        {[0, 1, 2, 3, 4].map((index) => (
                          <span
                            key={index}
                            style={{
                              ...styles.micMeterBar,
                              ...(micLevel > (index + 1) / 6
                                ? styles.micMeterBarActive
                                : {}),
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </span>
                </div>
                <select
                  style={{
                    ...styles.select,
                    ...(!options.microphone ? styles.selectDisabled : {}),
                  }}
                  value={options.audioDeviceId || ""}
                  disabled={controlsDisabled || !options.microphone}
                  onChange={(event) => {
                    void updateRecordingOptions({
                      audioDeviceId: event.target.value || undefined,
                    });
                  }}
                >
                  <option value="">Default microphone</option>
                  {devices.audioInputs.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </select>
              </div>
              <div style={styles.controlRow}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={options.webcam}
                  aria-label="Webcam"
                  style={{
                    ...styles.switchButton,
                    ...(options.webcam ? styles.switchButtonOn : {}),
                  }}
                  disabled={controlsDisabled}
                  onClick={() => {
                    void updateRecordingOptions({
                      webcam: !options.webcam,
                    });
                  }}
                >
                  <span
                    style={{
                      ...styles.switchKnob,
                      ...(options.webcam ? styles.switchKnobOn : {}),
                    }}
                  />
                </button>
                <div style={styles.controlText}>
                  <strong style={styles.controlTitle}>Webcam</strong>
                  <small style={styles.controlHint}>Fixed bottom-right overlay</small>
                </div>
                <select
                  style={{
                    ...styles.select,
                    ...(!options.webcam ? styles.selectDisabled : {}),
                  }}
                  value={options.videoDeviceId || ""}
                  disabled={controlsDisabled || !options.webcam}
                  onChange={(event) => {
                    void updateRecordingOptions({
                      videoDeviceId: event.target.value || undefined,
                    });
                  }}
                >
                  <option value="">Default camera</option>
                  {devices.videoInputs.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ ...styles.controlRow, ...styles.controlRowNoAccessory }}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={options.showSteps}
                  aria-label="Record steps"
                  style={{
                    ...styles.switchButton,
                    ...(options.showSteps ? styles.switchButtonOn : {}),
                  }}
                  disabled={controlsDisabled}
                  onClick={() => {
                    void updateRecordingOptions({
                      showSteps: !options.showSteps,
                    });
                  }}
                >
                  <span
                    style={{
                      ...styles.switchKnob,
                      ...(options.showSteps ? styles.switchKnobOn : {}),
                    }}
                  />
                </button>
                <div style={styles.controlText}>
                  <strong style={styles.controlTitle}>Record clicks</strong>
                  <small style={styles.controlHint}>Show captured clicks in the guide(Only works for clicks inside the browser)</small>
                </div>
              </div>
            </div>
            <p style={styles.shareHint}>
              After you share your screen, you will return to the original page and recording will start.
            </p>
            <button
              type="button"
              style={{
                ...styles.button,
                ...(isStarting || isPreparingMedia ? styles.buttonDisabled : {}),
              }}
              disabled={isStarting || isPreparingMedia || !session}
              onClick={() => {
                void beginRecording();
              }}
            >
              {isStarting
                ? "Starting..."
                : isPreparingMedia
                  ? "Preparing inputs..."
                  : "Start screen sharing"}
            </button>
          </>
        )}
        {error && <p style={styles.error}>{error}</p>}
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    margin: 0,
    display: "grid",
    placeItems: "center",
    background: "#f3f6fb",
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  panel: {
    width: "min(560px, calc(100vw - 32px))",
    padding: 24,
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    background: "#ffffff",
    boxShadow: "0 20px 54px rgba(15, 23, 42, 0.13)",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: 13,
    marginBottom: 18,
  },
  indicator: {
    width: 12,
    height: 12,
    flex: "0 0 auto",
    marginTop: 6,
    borderRadius: 999,
    background: "#ef4444",
    boxShadow: "0 0 0 6px rgba(239, 68, 68, 0.14)",
  },
  indicatorActive: {
    animation: "guidemagicPulse 1.4s ease-in-out infinite",
  },
  title: {
    margin: "0 0 4px",
    color: "#0f172a",
    fontSize: 22,
    fontWeight: 700,
    lineHeight: 1.15,
  },
  copy: {
    margin: 0,
    color: "#475569",
    fontSize: 14,
    lineHeight: 1.45,
  },
  progressPanel: {
    display: "grid",
    justifyItems: "center",
    gap: 16,
    padding: "34px 20px 30px",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    background: "#fbfdff",
    textAlign: "center",
  },
  spinner: {
    width: 42,
    height: 42,
    border: "4px solid #dbeafe",
    borderTopColor: "#5046e5",
    borderRadius: 999,
    animation: "guidemagicSpin 900ms linear infinite",
  },
  progressText: {
    display: "grid",
    gap: 5,
    maxWidth: 360,
  },
  progressTitle: {
    color: "#0f172a",
    fontSize: 16,
    lineHeight: 1.25,
  },
  progressCopy: {
    color: "#475569",
    fontSize: 14,
    lineHeight: 1.45,
  },
  preview: {
    display: "grid",
    width: 220,
    height: 220,
    margin: "0 auto 16px",
    placeItems: "center",
    overflow: "hidden",
    border: "4px solid #ffffff",
    borderRadius: 999,
    background: "#0f172a",
    boxShadow: "0 12px 32px rgba(15, 23, 42, 0.22)",
  },
  previewVideo: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transform: "scaleX(-1)",
    background: "#0f172a",
  },
  controls: {
    display: "grid",
    gap: 10,
    marginBottom: 16,
  },
  controlRow: {
    display: "grid",
    gridTemplateColumns: "48px minmax(120px, 1fr) minmax(180px, 220px)",
    alignItems: "center",
    gap: 12,
    minHeight: 64,
    padding: "10px 12px",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    background: "#fbfdff",
  },
  controlRowNoAccessory: {
    gridTemplateColumns: "48px minmax(120px, 1fr)",
  },
  switchButton: {
    position: "relative",
    width: 44,
    height: 26,
    padding: 0,
    border: "1px solid #cbd5e1",
    borderRadius: 999,
    background: "#e2e8f0",
    cursor: "pointer",
    transition: "background 160ms ease, border-color 160ms ease",
  },
  switchButtonOn: {
    borderColor: "#5046e5",
    background: "#5046e5",
  },
  switchKnob: {
    position: "absolute",
    top: 3,
    left: 3,
    width: 18,
    height: 18,
    borderRadius: 999,
    background: "#ffffff",
    boxShadow: "0 1px 3px rgba(15, 23, 42, 0.25)",
    transition: "transform 160ms ease",
  },
  switchKnobOn: {
    transform: "translateX(18px)",
  },
  controlText: {
    minWidth: 0,
  },
  controlTitle: {
    display: "block",
    color: "#0f172a",
    fontSize: 14,
  },
  controlHint: {
    display: "block",
    marginTop: 2,
    color: "#64748b",
    fontSize: 12,
  },
  micMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  micMeter: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    height: 12,
  },
  micMeterBar: {
    width: 3,
    height: 8,
    borderRadius: 999,
    background: "#cbd5e1",
    transition: "height 90ms ease, background 90ms ease",
  },
  micMeterBarActive: {
    height: 12,
    background: "#22c55e",
  },
  select: {
    width: "100%",
    height: 38,
    minWidth: 0,
    padding: "0 28px 0 10px",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    background: "#ffffff",
    color: "#334155",
    fontSize: 13,
    fontWeight: 600,
  },
  selectDisabled: {
    background: "#f8fafc",
    color: "#94a3b8",
  },
  button: {
    width: "100%",
    height: 42,
    border: 0,
    borderRadius: 8,
    background: "#5046e5",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 700,
  },
  shareHint: {
    margin: "0 0 10px",
    color: "#64748b",
    fontSize: 13,
    lineHeight: 1.4,
    textAlign: "center",
  },
  buttonDisabled: {
    cursor: "default",
    opacity: 0.66,
  },
  error: {
    margin: "14px 0 0",
    color: "#b91c1c",
    fontSize: 13,
    lineHeight: 1.4,
  },
} satisfies Record<string, CSSProperties>;

const style = document.createElement("style");
style.textContent = `
  @keyframes guidemagicSpin {
    to { transform: rotate(360deg); }
  }

  @keyframes guidemagicPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(0.78); opacity: 0.62; }
  }
`;
document.head.appendChild(style);

export default VideoRecorderPage;
export {};
