import "./rec-button.css";

interface Props {
  isRecording: boolean;
  onClick: () => void;
}
export function RecordButton(props: Props) {
  return (
    <div onClick={props.onClick} className={`rec-button ${props.isRecording && "animate-flicker"}`}>
      <span className="rec-text">{props.isRecording ? 'STOP' : 'REC'}</span>
    </div>
  );
}
