import { useState } from "react";
import { RecordButton } from "./RecordButton";
import "./popup.css";
import { useGuide } from "./hooks/useGuide";
import AuthHandler from "../util/AuthHandler";

function IndexPopup() {
  const { guide, startRecording, stopRecording } = useGuide();

  const handleLogin = () => {
    const newURL = "http://stackoverflow.com/";
    chrome.tabs.create({ url: newURL });
  };

  return (
    <div className="popup-container">
      {AuthHandler.isLoggedIn() ? (
        <>
          <RecordButton
            isRecording={guide?.active}
            onClick={() => {
              if (guide?.active) {
                stopRecording();
              } else {
                startRecording();
              }
            }}
          />
          <p>Click to start recording</p>
        </>
      ) : (
        <div>
          <button onClick={handleLogin}>Login</button>
        </div>
      )}
    </div>
  );
}

export default IndexPopup;
