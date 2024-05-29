import { sendToBackground } from "@plasmohq/messaging";
import { Storage } from "@plasmohq/storage";
import type { PlasmoCSConfig, PlasmoWatchOverlayAnchor } from "plasmo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Guide } from "~ts/Guide";
import parseTitle from "~util/parseTitle";
import { getWindowInformation } from "~util/windowInformation";

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
  const [isRecording, setRecording] = useState(false);
  const [rect, setRect] = useState(null);
  const lastElem = useRef<Element>();

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
        setRecording(true);
      } else if (request.message === "stopRecording") {
        setRect(null);
        setRecording(false);
      }
    },
    [isRecording, setRecording, setRect]
  );

  const onMouseDown = useCallback(
    async (event) => {
      if (!isRecording) {
        return;
      }
      const target = event.target as HTMLElement;
      const placeholder = target.getAttribute("placeholder")      
      const title = parseTitle(target);
      const parentTitle = parseTitle(target.parentNode);
      
      
      const htmlTag = target.outerHTML;
      const rect = target.getBoundingClientRect();
      const { width: windowWidth, height: windowHeight, screenWidth, screenHeight, devicePixelRatio } =
        getWindowInformation();

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
      setRecording(true);
    } else {
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
    return <div></div>;
  }

  return (
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
  );
};

export default PlasmoPricingExtra;
