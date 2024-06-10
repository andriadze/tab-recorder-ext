import { useEffect, useState } from "react";
import { Storage } from "@plasmohq/storage";
import { startRecordingApi, stopRecordingApi } from "../../api/guide.api";
import type { Guide } from "~ts/Guide";
import { sendMessageToActivePage } from "~util/messaging";

const storage = new Storage();

export function useGuide() {
  const [guide, setGuide] = useState<null | Guide>();

  const initGuide = async () => {
    const currGuide = await storage.get<Guide>("guide");
    setGuide(currGuide);
  };

  const startRecording = async () => {
    if (guide && guide.active) {
      await stopRecordingApi(guide.id);
      sendMessageToActivePage('stopRecording');
    }
    const newGuide = await startRecordingApi();
    await storage.set("guide", newGuide);
    setGuide(newGuide);
    sendMessageToActivePage('startRecording');
  };

  const stopRecording = async () => {
    const stoppedGuide = { ...guide, active: false };
    await storage.set('guide', stoppedGuide);
    await stopRecordingApi(guide.id);
    setGuide(stoppedGuide);
    sendMessageToActivePage('stopRecording');
    chrome.tabs.create({ url: `${process.env.PLASMO_PUBLIC_APP_ROUTE}/guides/${stoppedGuide.id}` });
  };

  useEffect(() => {
    initGuide();
  }, []);

  return {
    guide,
    startRecording,
    stopRecording,
  };
}
