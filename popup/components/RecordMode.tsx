import { RecordButton } from "~popup/RecordButton";
import { useGuide } from "~popup/hooks/useGuide";
import settingsImage from "data-base64:~/assets/settings.png";
import guideImage from "data-base64:~/assets/guideList.png";
import { useState } from "react";
import { SettingsMode } from "./SettingsMode";

export function RecordMode() {
  const { guide, startRecording, stopRecording } = useGuide();
  console.log("Guide", guide);

  const [settingsMode, setSettingsMode] = useState(false);

  return (
    <>
      {settingsMode ? (
        <SettingsMode onBack={() => setSettingsMode(false)} />
      ) : (
        <div className="popup-container">
          <RecordButton
            isRecording={guide?.active}
            onClick={async () => {
              if (guide?.active) {
                stopRecording();
              } else {
                await startRecording();
                window.close();
              }
            }}
          />
          <div className="red-button-paragraphs">
            {guide?.active ? "STOP RECORDING" : "START RECORDING"}
          </div>
          <div className="settings-list">
            <button
              onClick={() =>
                window.open("https://app.guidemagic.ai/", "_blank")
              }
              className="settings-list-button"
            >
              <div className="settings-image-container">
                <img src={guideImage} alt="guide-image" />
              </div>
              My Guides
            </button>
            <button
              className="settings-list-button"
              onClick={() => setSettingsMode(true)}
            >
              <div className="settings-image-container">
                <img src={settingsImage} alt="settings-image" />
              </div>
              Settings
            </button>
          </div>
        </div>
      )}
    </>
  );
}
