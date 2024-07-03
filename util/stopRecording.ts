import { stopRecordingApi } from "~api/guide.api";
import { sendMessageToActivePage } from "./messaging";
import type { Guide } from "~ts/Guide";
import { Storage } from "@plasmohq/storage";

const storage = new Storage();

export async function stopRecording() {
  const guide = await storage.get<Guide>("guide");

  const stoppedGuide = { ...guide, active: false };
  await storage.set("guide", stoppedGuide);
  await stopRecordingApi(guide.id);

  sendMessageToActivePage("stopRecording");

  if (guide.stepCount > 0) {
    chrome.tabs.create({
      url: `${process.env.PLASMO_PUBLIC_APP_ROUTE}/guides/${stoppedGuide.id}`,
    });
  }
}
