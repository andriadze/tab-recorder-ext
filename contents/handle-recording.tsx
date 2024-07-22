import { sendToBackground } from "@plasmohq/messaging";
import { Storage } from "@plasmohq/storage";
import type {
  PlasmoCSConfig,
  PlasmoGetStyle,
  PlasmoWatchOverlayAnchor,
} from "plasmo";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
} from "react";
import type { Guide } from "~ts/Guide";
import parseTitle from "~util/parseTitle";
import { getWindowInformation } from "~util/windowInformation";
import logoImage from "data-base64:~/assets/icon.png";

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  all_frames: true,
  css: ["global-styles.css"],
};

const storage = new Storage();

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
  const [performAnim, setPerformAnim] = useState(false);
  const [fade, setFade] = useState(false);
  const [rect, setRect] = useState(null);
  const lastElem = useRef<Element>();

  const handleStopRecording = async (event: MouseEvent) => {
    event.stopPropagation();
    setRect(null);
    setRecording(false);
    setPerformAnim(false);
    sendToBackground({
      name: "handle-stop-recording",
      body: {},
    });
  };

  const getStepCount = async () => {
    const res = await storage.get<Guide>("guide");
    return res.stepCount;
  };

  const handleMouseOver = useCallback(
    (event) => {
      if (
        isRecording &&
        event.target instanceof Element &&
        lastElem.current !== event.target
      ) {
        setRect(event.target.getBoundingClientRect());
        lastElem.current = event.target;
      }
    },
    [isRecording, lastElem]
  );

  const handleScroll = useCallback(
    (event) => {
      if (
        isRecording &&
        event.target instanceof Element &&
        lastElem.current !== event.target
      ) {
        lastElem.current = event.target;
      }
    },
    [isRecording, lastElem]
  );

  const handleScrollFinished = useCallback(() => {
    setRect(lastElem.current?.getBoundingClientRect());
  }, [setRect, lastElem]);

  const handleRecorderStatusChange = useCallback(
    (request, sender, sendResponse) => {
      if (request.message === "startRecording") {
        setRecordingStarting(false);
        setPerformAnim(true);
        setRecording(true);
      } else if (request.message === "stopRecording") {
        setRecordingStarting(false);
        setRect(null);
        setRecording(false);
        setPerformAnim(false);
      } else if (request.message === "recordingStarting") {
        setRecordingStarting(true);
      }
    },
    [isRecording, setRecording, setRect]
  );

  useEffect(() => {
    setTimeout(() => {
      setPerformAnim(false);
    }, 3000);
  }, [performAnim]);

  const onMouseUp = () => {
    if (!isRecording) {
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

  const onMouseDown = useCallback(
    async (event) => {
      if (!isRecording) {
        return;
      }
      const target = event.target as HTMLElement;
      if (
        target.tagName === "PLASMO-CSUI" ||
        target.id === "___guidemagic__inject__button__"
      ) {
        return;
      }

      console.log("Event target", event.target);
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

      const steps = (await getStepCount()) || 0;
      setStepCount(steps + 1);
      const { img } = await sendToBackground({
        name: "take-screenshot",
        body: {
          title,
          htmlTag,
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
          windowWidth,
          windowHeight,
          screenWidth,
          screenHeight,
          devicePixelRatio,
        },
      });
    },
    [isRecording]
  );

  const handleInit = useCallback(async () => {
    const res = await storage.get<Guide>("guide");
    if (res && res.active) {
      setStepCount(res.stepCount || 0);
      setRecording(true);
    } else {
      setStepCount(0);
      setRecording(false);
      setRect(null);
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
    document.addEventListener("mouseover", handleMouseOver);
    window.addEventListener("focus", handleInit);
    document.addEventListener("pointerdown", onMouseDown);
    document.addEventListener("pointerup", onMouseUp);

    document.addEventListener("scroll", handleScroll);

    chrome.runtime.onMessage.addListener(handleRecorderStatusChange);

    document.addEventListener("scrollend", handleScrollFinished);

    return () => {
      window.removeEventListener("focus", handleInit);
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("pointerdown", onMouseDown);
      document.removeEventListener("pointerup", onMouseUp);
      document.removeEventListener("scroll", handleScroll);
      document.removeEventListener("scrollend", handleScrollFinished);
      chrome.runtime.onMessage.removeListener(handleRecorderStatusChange);
    };
  }, [
    handleMouseOver,
    handleScroll,
    handleRecorderStatusChange,
    handleScrollFinished,
  ]);

  if (!rect) {
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
      </>
    );
  }

  return (
    <>
      {performAnim && (
        <div className="main-container-ripple">
          <span className="ripple"></span>
        </div>
      )}
      {fade && (
        <div
          onAnimationEnd={() => {
            setFade(false);
          }}
          className={"fade-in-container"}
        />
      )}
      <div
        id="rec_border"
        style={{
          width: rect?.width + 12,
          height: rect?.height + 12,
          top: rect?.top - 3 - 6 + window.scrollY,
          left: rect?.left - 3 - 6 + window.scrollX,
          position: "absolute",
          // border: "3px solid blue",
          borderRadius: 3,
          pointerEvents: "none",
        }}
      ></div>
      {isRecording && (
        <RecButton
          animate={fade}
          onStopClicked={handleStopRecording}
          stepCount={stepCount}
        />
      )}
    </>
  );
};

const RecButton = (props: {
  stepCount: number;
  animate: boolean;
  onStopClicked: (ev: any) => void;
}) => {
  const [hovering, setHovering] = useState(false);

  return (
    <div
      id="___guidemagic__inject__button__"
      className={`recording-button ${props.animate ? "rec-button-anim" : ""}`}
      onClick={props.onStopClicked}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {hovering ? (
        <>
          <div className="red-circle-count">
            <p>Steps: {props.stepCount || 0}</p>
          </div>
          <div className="red-circle" />
        </>
      ) : (
        <img className="recording-logo" src={logoImage}></img>
      )}
    </div>
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
      border-radius: 99px;
      position: fixed;
      right: 50px;
      bottom: 50px;
      transition: 0.5s;
      font-family: Arial;
      box-shadow: rgba(0, 0, 0, 0.26) 0px 1px 4px;
      animation: scaleRec 2.5s infinite; 
  }

  .rec-button-anim{
    animation: scaleBounce 0.2s;      
  }

  .recording-button:hover{
      width: 80px;
      height: 80px; 
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
