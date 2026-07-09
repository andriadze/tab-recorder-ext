import { sendToBackground } from "@plasmohq/messaging";
import { Storage } from "@plasmohq/storage";
import type {
  PlasmoCSConfig,
  PlasmoGetStyle,
  PlasmoMountShadowHost,
  PlasmoWatchOverlayAnchor,
} from "plasmo";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Guide } from "~ts/Guide";
import type { StepEventType } from "~ts/Step";
import type { VideoRecordingOptions } from "~ts/VideoRecording";
import parseTitle from "~util/parseTitle";
import { getWindowInformation } from "~util/windowInformation";
import logoImage from "data-base64:~/assets/icon.png";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  all_frames: true,
  css: ["global-styles.css"],
};

export const mountShadowHost: PlasmoMountShadowHost = ({ shadowHost }) => {
  const host = shadowHost as HTMLElement;
  host.id = "guidemagic-recorder-host";
  host.style.position = "fixed";
  host.style.inset = "0 auto auto 0";
  host.style.display = "block";
  host.style.width = "0";
  host.style.height = "0";
  host.style.margin = "0";
  host.style.padding = "0";
  host.style.border = "0";
  host.style.overflow = "visible";
  host.style.pointerEvents = "none";
  host.style.zIndex = "2147483647";
  document.documentElement.prepend(host);
};

const storage = new Storage();
const DUPLICATE_SUBMIT_WINDOW_MS = 1000;

type LastPointerCapture = {
  form: HTMLFormElement | null;
  target: HTMLElement;
  capturedAt: number;
};

const shouldIgnoreTarget = (target: HTMLElement) =>
  target.tagName === "PLASMO-CSUI" ||
  target.id === "___guidemagic__inject__button__";

function shouldShowRecordingVisuals(
  guide?: Guide | null,
  options?: Partial<VideoRecordingOptions> | null,
) {
  if (options?.showSteps === false) {
    return false;
  }
  if (guide?.recordingMode === "video") {
    return guide.videoRecording?.showSteps !== false;
  }
  return true;
}

export const watchOverlayAnchor: PlasmoWatchOverlayAnchor = (
  updatePosition
) => {
  document.addEventListener("mouseover", (event) => {
    updatePosition();
  });
  document.addEventListener("scroll", (event) => {
    updatePosition();
  });

  setInterval(() => updatePosition(), 300);
};

const PlasmoPricingExtra = () => {
  const [stepCount, setStepCount] = useState(0);
  const [recordingStarting, setRecordingStarting] = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [recordingVisualsEnabled, setRecordingVisualsEnabled] = useState(true);
  const [performAnim, setPerformAnim] = useState(false);
  const [fade, setFade] = useState(false);
  const [videoPreviewActive, setVideoPreviewActive] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState("");
  const [videoPreviewFrame, setVideoPreviewFrame] = useState("");
  const [videoPreviewRemoteActive, setVideoPreviewRemoteActive] = useState(false);
  const [rect, setRect] = useState(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const videoPreviewStreamRef = useRef<MediaStream | null>(null);
  const videoPreviewPeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const videoPreviewDiagnosticsTimerRef = useRef<number | null>(null);
  const lastElem = useRef<Element>();
  const stoppingRef = useRef(false);
  const lastPointerCaptureRef = useRef<LastPointerCapture | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingModeRef = useRef<Guide["recordingMode"] | null>(null);

  const handleStopRecording = async () => {
    if (stoppingRef.current) {
      return;
    }

    stoppingRef.current = true;
    setRect(null);
    setRecording(false);
    setPerformAnim(false);
    setRecordingVisualsEnabled(true);
    recordingStartedAtRef.current = null;
    recordingModeRef.current = null;
    try {
      const result = await sendToBackground({
        name: "handle-stop-recording",
        body: {},
      });
      if (!result?.success) {
        throw new Error("Stop request failed");
      }
    } catch (error) {
      stoppingRef.current = false;
      console.error("Could not stop recording", error);
      await handleInit();
    }
  };

  const handleMouseOver = useCallback(
    (event) => {
      if (
        isRecording &&
        recordingVisualsEnabled &&
        event.target instanceof Element &&
        lastElem.current !== event.target
      ) {
        setRect(event.target.getBoundingClientRect());
        lastElem.current = event.target;
      }
    },
    [isRecording, lastElem, recordingVisualsEnabled]
  );

  const handleScroll = useCallback(
    (event) => {
      if (
        isRecording &&
        recordingVisualsEnabled &&
        event.target instanceof Element &&
        lastElem.current !== event.target
      ) {
        lastElem.current = event.target;
      }
    },
    [isRecording, lastElem, recordingVisualsEnabled]
  );

  const handleScrollFinished = useCallback(() => {
    if (!recordingVisualsEnabled) {
      return;
    }
    setRect(lastElem.current?.getBoundingClientRect());
  }, [setRect, lastElem, recordingVisualsEnabled]);

  const playVideoPreview = useCallback(() => {
    const video = videoPreviewRef.current;
    const stream = videoPreviewStreamRef.current;
    if (!video || !stream) {
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    void video.play().then(
      () =>
        console.info("[GuideMagic video] WebRTC webcam preview playing", {
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          readyState: video.readyState,
        }),
      (error) =>
        console.warn("[GuideMagic video] WebRTC webcam preview play failed", error),
    );
  }, []);

  const stopVideoPreviewDiagnostics = useCallback(() => {
    if (videoPreviewDiagnosticsTimerRef.current != null) {
      window.clearInterval(videoPreviewDiagnosticsTimerRef.current);
      videoPreviewDiagnosticsTimerRef.current = null;
    }
  }, []);

  const startVideoPreviewDiagnostics = useCallback(() => {
    if (videoPreviewDiagnosticsTimerRef.current != null) {
      return;
    }
    videoPreviewDiagnosticsTimerRef.current = window.setInterval(() => {
      const video = videoPreviewRef.current;
      if (!video) {
        console.info("[GuideMagic video] WebRTC webcam preview state", {
          mounted: false,
          hasStream: Boolean(videoPreviewStreamRef.current),
        });
        return;
      }
      const quality =
        "getVideoPlaybackQuality" in video
          ? video.getVideoPlaybackQuality()
          : null;
      console.info("[GuideMagic video] WebRTC webcam preview state", {
        currentTime: video.currentTime,
        readyState: video.readyState,
        paused: video.paused,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        droppedVideoFrames: quality?.droppedVideoFrames,
        totalVideoFrames: quality?.totalVideoFrames,
      });
    }, 1000);
  }, []);

  const attachVideoPreviewElement = useCallback(
    (element: HTMLVideoElement | null) => {
      videoPreviewRef.current = element;
      if (element) {
        playVideoPreview();
      }
    },
    [playVideoPreview],
  );

  const waitForIceGatheringComplete = useCallback(
    async (peerConnection: RTCPeerConnection) => {
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
          peerConnection.removeEventListener(
            "icegatheringstatechange",
            onStateChange,
          );
          resolve();
        };
        peerConnection.addEventListener("icegatheringstatechange", onStateChange);
      });
    },
    [],
  );

  const handleWebrtcPreviewOffer = useCallback(
    async (offer: RTCSessionDescriptionInit) => {
      videoPreviewPeerConnectionRef.current?.close();
      const peerConnection = new RTCPeerConnection();
      videoPreviewPeerConnectionRef.current = peerConnection;
      peerConnection.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        console.info("[GuideMagic video] WebRTC webcam preview track received", {
          href: window.location.href,
          isTopFrame: window.top === window,
          trackKind: event.track.kind,
          trackReadyState: event.track.readyState,
          streamTracks: stream.getTracks().map((track) => ({
            kind: track.kind,
            readyState: track.readyState,
            muted: track.muted,
          })),
        });
        videoPreviewStreamRef.current = stream;
        setVideoPreviewFrame("");
        setVideoPreviewError("");
        setVideoPreviewRemoteActive(true);
        setVideoPreviewActive(true);
        startVideoPreviewDiagnostics();
        window.setTimeout(playVideoPreview, 0);
      };
      await peerConnection.setRemoteDescription(offer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await waitForIceGatheringComplete(peerConnection);
      console.info("[GuideMagic video] WebRTC webcam preview answer created", {
        href: window.location.href,
        isTopFrame: window.top === window,
      });
      return peerConnection.localDescription?.toJSON();
    },
    [playVideoPreview, startVideoPreviewDiagnostics, waitForIceGatheringComplete],
  );

  const handleRecorderStatusChange = useCallback(
    (request, sender, sendResponse) => {
      if (request.message === "startRecording") {
        setRecordingStarting(false);
        const showVisuals = shouldShowRecordingVisuals(null, request.options);
        recordingStartedAtRef.current =
          typeof request.recordingStartedAt === "number"
            ? request.recordingStartedAt
            : Date.now();
        void storage.get<Guide>("guide").then((guide) => {
          recordingModeRef.current = guide?.recordingMode || null;
        });
        setRecordingVisualsEnabled(showVisuals);
        setPerformAnim(showVisuals);
        if (!showVisuals) {
          setFade(false);
          setRect(null);
        }
        setRecording(true);
      } else if (request.message === "stopRecording") {
        setRecordingStarting(false);
        setRect(null);
        setRecording(false);
        setPerformAnim(false);
        setRecordingVisualsEnabled(true);
        recordingStartedAtRef.current = null;
        recordingModeRef.current = null;
      } else if (request.message === "recordingStarting") {
        setRecordingStarting(true);
      } else if (request.message === "startVideoPreview") {
        setVideoPreviewError("");
        setVideoPreviewActive(true);
      } else if (request.message === "stopVideoPreview") {
        setVideoPreviewActive(false);
        setVideoPreviewError("");
        setVideoPreviewFrame("");
        setVideoPreviewRemoteActive(false);
        stopVideoPreviewDiagnostics();
        videoPreviewPeerConnectionRef.current?.close();
        videoPreviewPeerConnectionRef.current = null;
      } else if (request.message === "updateVideoPreviewFrame") {
        setVideoPreviewError("");
        setVideoPreviewActive(true);
        setVideoPreviewFrame(request.frame || "");
      } else if (request.message === "guidemagicWebrtcPreviewOffer") {
        if (window.top !== window) {
          sendResponse({ success: false, error: "Ignoring non-top frame" });
          return;
        }
        handleWebrtcPreviewOffer(request.offer)
          .then((answer) => sendResponse({ success: true, answer }))
          .catch((error) =>
            sendResponse({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        return true;
      }
    },
    [
      handleWebrtcPreviewOffer,
      isRecording,
      setRecording,
      setRect,
      setFade,
      stopVideoPreviewDiagnostics,
    ]
  );

  useEffect(() => {
    setTimeout(() => {
      setPerformAnim(false);
    }, 3000);
  }, [performAnim]);

  const onMouseUp = (event: PointerEvent) => {
    if (!isRecording || !recordingVisualsEnabled) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target.tagName === "PLASMO-CSUI" ||
      target.id === "___guidemagic__inject__button__"
    ) {
      return;
    }
    setFade(true);
  };

  const recordStep = useCallback(
    async (
      target: HTMLElement,
      options: {
        eventType: StepEventType;
        mousePosX?: number | null;
        mousePosY?: number | null;
      }
    ) => {
      if (!isRecording) {
        return false;
      }

      const placeholder = target.getAttribute("placeholder");
      const title = parseTitle(target);
      const parentTitle = parseTitle(target.parentNode);

      const htmlTag = target.outerHTML;
      const rect = target.getBoundingClientRect();
      const {
        width: windowWidth,
        height: windowHeight,
        screenWidth,
        screenHeight,
        devicePixelRatio,
      } = getWindowInformation();
      const recordingTimestampMs = recordingStartedAtRef.current &&
        recordingModeRef.current === "video"
        ? Math.max(0, Date.now() - recordingStartedAtRef.current)
        : undefined;

      try {
        const result = await sendToBackground({
          name: "take-screenshot",
          body: {
            title,
            htmlTag,
            eventType: options.eventType,
            url: window.location.href,
            placeholder,
            parentTitle,
            height: rect.height,
            width: rect.width,
            top: rect.top,
            left: rect.left,
            bottom: rect.bottom,
            right: rect.right,
            scrollX: scrollX,
            scrollY: scrollY,
            mousePosX: options.mousePosX,
            mousePosY: options.mousePosY,
            windowWidth,
            windowHeight,
            screenWidth,
            screenHeight,
            devicePixelRatio,
            recordingTimestampMs,
          },
        });

        if (result?.success) {
          setStepCount((currentCount) => currentCount + 1);
          return true;
        } else {
          console.error("Recording step was not captured", result?.error);
          if (result?.stopRecording) {
            setRect(null);
            setRecording(false);
            setPerformAnim(false);
          }
        }
      } catch (error) {
        console.error("Could not send recording step", error);
      }

      return false;
    },
    [isRecording]
  );

  const onMouseDown = useCallback(
    async (event: PointerEvent) => {
      if (!isRecording) {
        return;
      }
      const target = event.target as HTMLElement;
      if (shouldIgnoreTarget(target)) {
        return;
      }

      lastPointerCaptureRef.current = {
        form: target.closest("form"),
        target,
        capturedAt: Date.now(),
      };

      console.log("Event target", event.target);
      await recordStep(target, {
        eventType: "click",
        mousePosX: event.clientX,
        mousePosY: event.clientY,
      });
    },
    [isRecording, recordStep]
  );

  const onSubmit = useCallback(
    async (event: SubmitEvent) => {
      if (!isRecording) {
        return;
      }

      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (!form || shouldIgnoreTarget(form)) {
        return;
      }

      const lastPointerCapture = lastPointerCaptureRef.current;
      const submitter =
        event.submitter instanceof HTMLElement ? event.submitter : null;
      if (
        submitter &&
        lastPointerCapture?.form === form &&
        (lastPointerCapture.target === submitter ||
          submitter.contains(lastPointerCapture.target)) &&
        Date.now() - lastPointerCapture.capturedAt < DUPLICATE_SUBMIT_WINDOW_MS
      ) {
        return;
      }

      const target = submitter || form;
      await recordStep(target, {
        eventType: "submit",
        mousePosX: null,
        mousePosY: null,
      });
    },
    [isRecording, recordStep]
  );

  const handleInit = useCallback(async () => {
    try {
      const res = await storage.get<Guide>("guide");
      if (res && res.active) {
        setStepCount(res.stepCount || 0);
        const showVisuals = shouldShowRecordingVisuals(res);
        recordingModeRef.current = res.recordingMode || null;
        if (!recordingStartedAtRef.current) {
          recordingStartedAtRef.current = Date.now();
        }
        setRecordingVisualsEnabled(showVisuals);
        if (!showVisuals) {
          setFade(false);
          setRect(null);
          setPerformAnim(false);
        }
        setRecording(true);
      } else {
        setStepCount(0);
        setRecording(false);
        setRecordingVisualsEnabled(true);
        recordingStartedAtRef.current = null;
        recordingModeRef.current = null;
        setRect(null);
      }
    } catch (exc) {
      // alert('We detected broken situation pls refresh!!!!')
    }
  }, [setRecording, setRect]);

  useEffect(() => {
    let timeoutId;
    if (recordingStarting) {
      timeoutId = setTimeout(() => {
        setRecordingStarting(false);
      }, 10000);
    }

    return () => {
      clearTimeout(timeoutId);
    };
  }, [recordingStarting]);

  useEffect(() => {
    handleInit();
  }, [handleInit]);

  useEffect(() => {
    if (videoPreviewRemoteActive) {
      playVideoPreview();
      return;
    }

    if (!videoPreviewActive || videoPreviewFrame) {
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = null;
      }
      return;
    }

    setVideoPreviewError("");
  }, [
    playVideoPreview,
    videoPreviewActive,
    videoPreviewFrame,
    videoPreviewRemoteActive,
  ]);

  useEffect(() => {
    document.addEventListener("mouseover", handleMouseOver);
    window.addEventListener("focus", handleInit);
    document.addEventListener("pointerdown", onMouseDown);
    document.addEventListener("pointerup", onMouseUp);
    document.addEventListener("submit", onSubmit, true);

    document.addEventListener("scroll", handleScroll);

    chrome.runtime.onMessage.addListener(handleRecorderStatusChange);

    document.addEventListener("scrollend", handleScrollFinished);

    return () => {
      window.removeEventListener("focus", handleInit);
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("pointerdown", onMouseDown);
      document.removeEventListener("pointerup", onMouseUp);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("scroll", handleScroll);
      document.removeEventListener("scrollend", handleScrollFinished);
      chrome.runtime.onMessage.removeListener(handleRecorderStatusChange);
      stopVideoPreviewDiagnostics();
      videoPreviewPeerConnectionRef.current?.close();
    };
  }, [
    handleMouseOver,
    handleScroll,
    handleRecorderStatusChange,
    handleScrollFinished,
    onMouseDown,
    onSubmit,
    stopVideoPreviewDiagnostics,
  ]);

  return (
    <>
      {recordingStarting && (
        <div
          className="main-container"
          style={{
            width: "100vw",
            height: "100vh",
          }}
        >
          <div className="rec-starting">Recording starting...</div>
        </div>
      )}
      {recordingVisualsEnabled && performAnim && (
        <div className="main-container-ripple">
          <span className="ripple"></span>
        </div>
      )}
      {recordingVisualsEnabled && fade && (
        <div
          onAnimationEnd={() => {
            setFade(false);
          }}
          className={"fade-in-container"}
        />
      )}
      {recordingVisualsEnabled && rect && (
        <div
          id="rec_border"
          style={{
            width: rect.width + 12,
            height: rect.height + 12,
            top: rect.top - 3 - 6,
            left: rect.left - 3 - 6,
            position: "fixed",
            // border: "3px solid blue",
            borderRadius: 3,
            pointerEvents: "none",
          }}
        ></div>
      )}
      {isRecording && (
        <RecButton
          animate={fade}
          onStopClicked={handleStopRecording}
          stepCount={stepCount}
          showStepCount={recordingVisualsEnabled}
        />
      )}
      {videoPreviewActive && (
        <div className="video-preview-bubble">
          {videoPreviewError ? (
            <div className="video-preview-error">{videoPreviewError}</div>
          ) : videoPreviewFrame ? (
            <img
              className="video-preview video-preview-frame"
              src={videoPreviewFrame}
              alt=""
              aria-hidden="true"
            />
          ) : (
            <video
              ref={attachVideoPreviewElement}
              className="video-preview"
              muted
              playsInline
              autoPlay
              onLoadedMetadata={playVideoPreview}
              onCanPlay={playVideoPreview}
            />
          )}
        </div>
      )}
    </>
  );
};

const RecButton = (props: {
  stepCount: number;
  animate: boolean;
  showStepCount: boolean;
  onStopClicked: () => void;
}) => {
  const [hovering, setHovering] = useState(false);

  return (
    <button
      type="button"
      id="___guidemagic__inject__button__"
      className={`recording-button ${props.animate ? "rec-button-anim" : ""}`}
      aria-label="Stop recording"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onStopClicked();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          props.onStopClicked();
        }
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {hovering ? (
        <>
          {props.showStepCount && (
            <div className="red-circle-count">
              <p>Steps: {props.stepCount || 0}</p>
            </div>
          )}
          <div className="red-circle" />
        </>
      ) : (
        <img className="recording-logo" src={logoImage}></img>
      )}
    </button>
  );
};

export const getStyle: PlasmoGetStyle = () => {
  const style = document.createElement("style");
  style.textContent = `
  .rec-starting{
    position: fixed;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 72px;
    color: white;
    width: 100vw;
    height: 100vh;
    background-color: rgba(0, 0, 0, 0.5);
  }

  .red-circle-count{
    position: absolute;
    display: flex;
    right: 90px;
    min-width: 80px;
    font-size: 15px;
    border-radius: 8px;
    text-align: center;
    padding: 0px 8px;
    justify-content: center;
    background-color: white;
    font-family: Arial;
    box-shadow: rgba(0, 0, 0, 0.25) 0px 5px 8px;
  }

  .main-container-ripple{
    width: 100vw;
    right: 0px;
  }
  .ripple {
    position: absolute;
    right: 0px;
    top: 0px;
    width: 500px;
    height: 500px;
    border-radius: 99999px;
    transform: scale(0);
    animation: ripple 600ms linear;
    background-color: rgba(255, 0, 0, 0.7);
  }

  .fade-in-container {
    animation: fadeIn 0.2s; 
    z-index: 100;
    background-color: white;
    position: fixed;
    width: 100vw;
    height: 100vh;
    opacity: 0;
  }

  @keyframes fadeIn {
    0% { opacity: 0; }
    50% { opacity: 0.5; }
    100% { opacity: 0; }
  }

  @keyframes expand {
    0% { scale: 0; }
    50% { opacity: 0.5; }
    100% { opacity: 0; }
  }

  @keyframes scaleRec {
      0%, 100% {
          transform: scale(1);
      }
      50% {
          transform: scale(1.1);
      }
    }

   @keyframes scaleBounce {
      0%, 100% {
          transform: scale(1);
      }
      50% {
          transform: scale(1.4);
      }
      70% {
          transform: scale(1.2);
      }
    }

  .recording-logo{
    width: 50px;
    transition: 0.5s;
  }
  .red-circle{
      width: 30px;
      height: 30px;
      background-color: red;
  }

  .recording-button {
      width: 70px;
      height: 70px;
      color: black;
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      font-size: 30px;
      background-color: white;
      border: 0;
      padding: 0;
      border-radius: 99px;
      position: fixed;
      right: 50px;
      bottom: 50px;
      transition: 0.5s;
      font-family: Arial;
      box-shadow: rgba(0, 0, 0, 0.26) 0px 1px 4px;
      animation: scaleRec 2.5s infinite; 
      pointer-events: auto;
      box-sizing: border-box;
      will-change: transform;
  }

  .rec-button-anim{
    animation: scaleBounce 0.2s;      
  }

  .video-preview-bubble {
    position: fixed;
    right: 28px;
    bottom: 132px;
    width: 220px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 3px solid rgba(255, 255, 255, 0.9);
    border-radius: 20px;
    background: #0f172a;
    box-shadow: 0 18px 42px rgba(15, 23, 42, 0.32);
    pointer-events: none;
    z-index: 2147483647;
  }

  .video-preview {
    position: relative;
    z-index: 2;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #0f172a;
    transform: scaleX(-1);
  }

  .video-preview-frame {
    transform: none;
  }

  .video-preview-error {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    padding: 12px;
    color: #ffffff;
    font-family: Arial;
    font-size: 13px;
    text-align: center;
  }

  .recording-button:hover{
      transform: scale(1.1);
      animation: none;
  }

  @keyframes ripple {
      to {
        transform: scale(20);
        opacity: 0;
      }
    }
  `;
  return style;
};

export default PlasmoPricingExtra;
