import backButtonWhite from "data-base64:~/assets/back-button-white.png";
import backButtonBlack from "data-base64:~/assets/back-button-black.png";
import "./backButton.css";

interface Props {
  onClick: () => void;
}

export function BackButton(props: Props) {
  return (
    <button
      className="back-button"
      onClick={props.onClick}
      aria-label="Go back"
    >
      <img
        className="back-button-image white"
        src={backButtonWhite}
        alt="back button white"
      />
      <img
        className="back-button-image black"
        src={backButtonBlack}
        alt="back button black"
      />
    </button>
  );
}
