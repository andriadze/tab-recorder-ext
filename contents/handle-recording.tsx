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
  const [isRecording, setRecording] = useState(false);
  const [performAnim, setPerformAnim] = useState(false);
  const [rect, setRect] = useState(null);
  const lastElem = useRef<Element>();

  const handleStopRecording = async (event: MouseEvent) => {
    event.stopPropagation();
    setRect(null);
    setRecording(false);
    setPerformAnim(false);
    sendToBackground({
      name: "handle-stop-recording",
      body: {}
    })
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
        setPerformAnim(true);
        setRecording(true);
      } else if (request.message === "stopRecording") {
        setRect(null);
        setRecording(false);
        setPerformAnim(false);
      }
    },
    [isRecording, setRecording, setRect]
  );

  useEffect(() => {
    setTimeout(() => {
      setPerformAnim(false);
    }, 3000);
  }, [performAnim]);

  const onMouseDown = useCallback(
    async (event) => {
      if (!isRecording) {
        return;
      }
      const target = event.target as HTMLElement;
      if(target.tagName === 'PLASMO-CSUI' || target.id === '___guidemagic__inject__button__'){
        return;
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
    handleInit();
  }, [handleInit]);

  useEffect(() => {
    document.addEventListener("mouseover", handleMouseOver);
    window.addEventListener("focus", handleInit);
    document.addEventListener("mousedown", onMouseDown);

    document.addEventListener("scroll", handleScroll);

    chrome.runtime.onMessage.addListener(handleRecorderStatusChange);

    document.addEventListener("scrollend", handleScrollFinished);

    return () => {
      window.removeEventListener("focus", handleInit);
      document.removeEventListener("mouseover", handleMouseOver);
      document.removeEventListener("mousedown", onMouseDown);
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
    return <div className="main-container"></div>;
  }

  return (
    <>
      {performAnim && (
        <div className="main-container-ripple">
          <span className="ripple"></span>
        </div>
      )}
      <div
        id="rec_border"
        style={{
          width: rect?.width + 12,
          height: rect?.height + 12,
          top: rect?.top - 3 - 6 + window.scrollY,
          left: rect?.left - 3 - 6 + window.scrollX,
          position: "absolute",
          border: "3px solid blue",
          borderRadius: 3,
          pointerEvents: "none",
        }}
      ></div>
      {isRecording && (
        <RecButton onStopClicked={handleStopRecording} stepCount={stepCount} />
      )}
    </>
  );
};

const RecButton = (props: {
  stepCount: number;
  onStopClicked: (ev: any) => void;
}) => {
  const [hovering, setHovering] = useState(false);

  return (
    <div
      id="___guidemagic__inject__button__"
      className="recording-button"
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
  .red-circle-count{
    position: absolute;
    display: flex;
    right: 70px;
    min-width: 80px;
    font-size: 15px;
    border-radius: 8px;
    text-align: center;
    padding: 0px 8px;
    justify-content: center;
    background-color: white;
    font-family: Arial;
    box-shadow: rgba(0, 0, 0, 0.16) 0px 1px 4px;
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

  .recording-logo{
    width: 20px;
    transition: 0.5s;
  }
  .red-circle{
      width: 20px;
      height: 20px;
      background-color: red;
  }

  .recording-button {
      width: 40px;
      height: 40px;
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
      box-shadow: rgba(0, 0, 0, 0.16) 0px 1px 4px;
  }

  .recording-button:hover{
      width: 50px;
      height: 50px; 
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
