import "./rec-button.css";

interface Props {
  isRecording: boolean;
  onClick: () => void;
}
export function RecordButton(props: Props) {
  return (
    <div
      onClick={props.onClick}
      className={`rec-button ${
        props.isRecording && "rec-button-active"
      } `}
    >
      {props.isRecording ? 'STOP' : 'REC'}
    </div>
  );
}
