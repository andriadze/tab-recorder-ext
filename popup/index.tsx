import { useState } from "react";
import { RecordButton } from "./RecordButton";
import "./popup.css";
import { useGuide } from "./hooks/useGuide";
import AuthHandler from "../util/AuthHandler";

import guideImage from "data-base64:~/assets/guideList.png";

import logoImage from "data-base64:~/assets/logo.png";

function IndexPopup() {
  const { guide, startRecording, stopRecording } = useGuide();

  const handleLogin = () => {
    chrome.tabs.create({ url: process.env.PLASMO_PUBLIC_AUTH_ROUTE });
  };

  return (
    <div className="popup-container">
      <div className="logo">
        <img src={logoImage} alt="" />{" "}
      </div>
      <button className="close-button">X</button>
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
          <div className="red-button-paragraphs">START RECORDING</div>
          <div className="settings-list">
            <button className="settings-list-button">
              <div className="settings-image-container">
                <img src={guideImage} alt="" />
              </div>
              My Guides
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="login-container-paragraph">
            Press the button to log in and <br /> start recording
          </p>
          <div className="button-container">
            <button onClick={handleLogin} className="login-button">
              <span></span>
              <span></span>
              <span></span>
              <span></span>Log in
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default IndexPopup;
