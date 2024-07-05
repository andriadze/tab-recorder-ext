import { BackButton } from "./BackButton";
import { Checkbox } from "./Checkbox";
import { Dropdown } from "./Dropdown";

import "./settingsMode.css";

export function SettingsMode({ onBack }) {
  return (
    <div className="popup-container">
      <div className="back-button-container">
        <BackButton onClick={onBack} />
      </div>
      <div className="settings-container">
        <div className="full-checkbox">
          <p>Highlight selected item</p>
          <Checkbox id="highlight-selected-item" />
        </div>
        <Dropdown />
        <div className="full-checkbox">
          <p>Show mouse highlight</p>
          <Checkbox id="show-mouse-highlight" />
        </div>
      </div>
    </div>
  );
}
