import "./popup.css";
import AuthHandler from "../util/AuthHandler";
import logoImage from "data-base64:~/assets/logo.png";
import { RecordMode } from "./components/RecordMode";

function IndexPopup() {
  const handleLogin = () => {
    chrome.tabs.create({ url: process.env.PLASMO_PUBLIC_AUTH_ROUTE });
  };

  return (
    <div className="popup-container">
      <div className="logo">
        <img src={logoImage} alt="" />{" "}
      </div>
      <button className="close-button" onClick={() => window.close()}>
        x
      </button>

      {AuthHandler.isLoggedIn() ? (
        <RecordMode />
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
